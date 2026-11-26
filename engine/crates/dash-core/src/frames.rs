//! The render worker's frame table (plan #68 C1 §3.4): one viewport per ChartFrame, built into a
//! draw list and an `a11y` summary. Data enters only through [`Frames::set_chunk`] (the Part D
//! seam); the `data_*` calls build a chunk in the local id space (`2⁶³..2⁶⁴`) from the TS series,
//! so the decoder's stream ids never collide with them in a renderer's caches.
//!
//! A kind the engine does not draw yet (`bars`, `heatmap`, `stat`) clears and reports an empty
//! summary (no series, null values and axis, the whole canvas as the plot) until #69. A spec that
//! does not parse clears the frame and reports nothing.
//!
//! Part C2a1 (§3.2, §4.3): the camera and the size come from the input ring ([`Frames::apply`]);
//! a frame without a camera is cleared and reports nothing. Each applied record sets the frame's
//! ack seq, reported once per tick by [`Frames::take_applied`]. A presentation captures the state
//! it draws when it is submitted ([`Frames::submit`]), and its `drawn` reports exactly that
//! ([`Frames::complete`]), whatever was applied while it was in flight. Frame ids are never taken
//! twice: a `create` at or below the highest id seen is refused.
//!
//! Part C2a2 (§3.3): each build keeps its stage (plot, value domain, band), each presentation
//! captures it at submit, and a completion reports it as `stage` before its `drawn`, only when the
//! presentation is of the frame's current Resize and its (rseq, stage) differs from the frame's
//! last reported one: the first completion after any applied Resize always reports, a stale one
//! never does. A dropped or never-completed submission changes nothing.

use std::collections::BTreeMap;
use std::sync::Arc;

use dash_marks::{DrawList, MarkItem};
use dash_scene::{
    Band, Camera, PlotCamera, Range64, Size64, StageInfo, Theme, Viewport, VisKind, VisSpec,
    YRange, build_stage,
};
use dash_wire::{Chunk, ChunkBuilder, ChunkError, IdAlloc, IdSpace, SeriesMeta};
use serde_json::{Value, json};

use crate::CoreError;
use crate::events;
use crate::input::{Decoded, Record};

/// The camera of a Camera record: the time range, a manual value range (None = auto) and a fixed
/// value-label band in CSS px (None = measured).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraIn {
    pub view: Range64,
    pub value: Option<Range64>,
    pub band: Option<f64>,
}

impl CameraIn {
    /// None: view not finite or hi ≤ lo; value: both NaN (auto) or finite with min < max; band:
    /// NaN (measured) or finite ≥ 0.
    pub fn from_record(view: (f64, f64), value: (f64, f64), band: f64) -> Option<Self> {
        let (lo, hi) = view;
        if !(lo.is_finite() && hi.is_finite() && hi > lo) {
            return None;
        }
        let value = match value {
            (a, b) if a.is_nan() && b.is_nan() => None,
            (a, b) if a.is_finite() && b.is_finite() && a < b => Some(Range64 { lo: a, hi: b }),
            _ => return None,
        };
        let band = match band {
            b if b.is_nan() => None,
            b if b.is_finite() && b >= 0.0 => Some(b),
            _ => return None,
        };
        Some(Self {
            view: Range64 { lo, hi },
            value,
            band,
        })
    }
}

/// What one submitted presentation shows, captured at submit (C2a2 adds `stage`): the frame's
/// last applied seq, the seq of its last applied Resize, its CSS size and DPR, and the series its
/// draw list draws.
#[derive(Clone, Debug, PartialEq)]
pub struct Presented {
    pub seq: u32,
    pub rseq: u32,
    pub css: (f32, f32),
    pub dpr: f32,
    pub series: u32,
    /// The stage of the list (plan #68 C2a2 §3.3): None = no plot.
    pub stage: Option<StageInfo>,
}

/// A Resize as applied: CSS px, DPR and device px.
pub type FrameSize = ((f32, f32), f32, (u32, u32));

/// The chunk being built from TS series.
#[derive(Debug)]
enum Building {
    Open(ChunkBuilder),
    /// No id was left (reported by `data_end`).
    NoIds,
    /// A series was rejected (reported by `data_series`); the rest of the chunk is ignored.
    Rejected,
}

/// One frame's state.
#[derive(Debug)]
struct Frame {
    frame_id: Option<String>,
    /// `None` before the first spec and after a spec error (the frame is cleared).
    spec: Option<VisSpec>,
    camera: Option<CameraIn>,
    theme: Theme,
    /// CSS px, DPR and device px of the last resize.
    size: Option<FrameSize>,
    data: Option<Arc<Chunk>>,
    building: Option<Building>,
    /// The summary JSON reported last.
    last_a11y: Option<String>,
    /// The seq of the last record applied (the ack) and of the last Resize applied.
    seq: u32,
    rseq: u32,
    /// Records were applied since the last `take_applied`.
    applied: bool,
    /// Series the last built draw list draws.
    series: u32,
    /// The stage of the last built draw list.
    stage: Option<StageInfo>,
}

impl Frame {
    fn new(frame_id: Option<String>) -> Self {
        Self {
            frame_id,
            spec: None,
            camera: None,
            theme: Theme::Dark,
            size: None,
            data: None,
            building: None,
            last_a11y: None,
            seq: 0,
            rseq: 0,
            applied: false,
            series: 0,
            stage: None,
        }
    }
}

/// Every frame of the page, by the adapter's id.
#[derive(Debug)]
pub struct Frames {
    frames: BTreeMap<u32, Frame>,
    ids: IdAlloc,
    /// The highest frame id created (ids are never reused, §3.1).
    highest: u32,
    /// Camera records rejected by `apply`.
    bad: u32,
    /// Per frame, the (rseq, stage) of its last `stage` event.
    reported: BTreeMap<u32, (u32, Option<StageInfo>)>,
}

impl Default for Frames {
    fn default() -> Self {
        Self {
            frames: BTreeMap::new(),
            ids: IdAlloc::new(IdSpace::Local),
            highest: 0,
            bad: 0,
            reported: BTreeMap::new(),
        }
    }
}

/// Series a draw list draws.
pub fn series_of(list: &DrawList) -> u32 {
    list.items
        .iter()
        .map(|i| match i {
            MarkItem::Line { series, .. } => series.end.saturating_sub(series.start),
            MarkItem::Guides { .. } => 0,
        })
        .sum()
}

/// `key` as the series key hash: exactly 16 lower-case hex digits (the TS `KEY_PATTERN`).
fn key_hash(key: &str) -> Result<u64, CoreError> {
    let hex = key.len() == 16
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !hex {
        return Err(CoreError::Key);
    }
    u64::from_str_radix(key, 16).map_err(|_| CoreError::Key)
}

/// The summary of a kind the engine does not draw: no series, null values and axis, the whole
/// canvas as the plot.
fn unsupported_summary(kind: VisKind, window: (f64, f64), css: Size64) -> Value {
    json!({
        "kind": kind,
        "seriesTotal": 0,
        "seriesShown": 0,
        "fromMs": window.0,
        "toMs": window.1,
        "min": null,
        "max": null,
        "last": null,
        "plot": {"x": 0, "y": 0, "width": css.w, "height": css.h},
        "valueAxis": null,
        "thresholdLabels": [],
        "eventLabels": [],
    })
}

impl Frames {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new frame; false (nothing changes) when `id` is at or below the highest id seen.
    pub fn create(&mut self, id: u32, frame_id: Option<String>) -> bool {
        if id <= self.highest {
            return false;
        }
        self.highest = id;
        self.frames.insert(id, Frame::new(frame_id));
        true
    }

    /// Applies one input record: the frame it dirtied, or None. A record of an unknown frame (one
    /// disposed after the publish) is ignored. A Camera that `CameraIn::from_record` rejects is
    /// counted in [`Frames::bad`] and leaves the camera unchanged, but still dirties the frame: the
    /// ack seq moves to the record's and the next presentation carries it.
    pub fn apply(&mut self, d: &Decoded) -> Option<u32> {
        match d.rec {
            Record::Resize {
                frame,
                css_w,
                css_h,
                dpr,
                device_w,
                device_h,
            } => {
                let f = self.frames.get_mut(&frame)?;
                f.size = Some(((css_w, css_h), dpr, (device_w, device_h)));
                f.rseq = d.seq;
                f.seq = d.seq;
                f.applied = true;
                Some(frame)
            }
            Record::Camera {
                frame,
                view,
                value,
                band,
            } => {
                let f = self.frames.get_mut(&frame)?;
                f.seq = d.seq;
                f.applied = true;
                match CameraIn::from_record(view, value, band) {
                    Some(c) => {
                        f.camera = Some(c);
                        Some(frame)
                    }
                    // Rejected: counted, the camera unchanged, but the frame still presents, so
                    // the next `drawn` carries the consumed seq and the adapter's settle resolves.
                    None => {
                        self.bad = self.bad.saturating_add(1);
                        Some(frame)
                    }
                }
            }
        }
    }

    /// Camera records rejected by `apply` so far.
    pub fn bad(&self) -> u32 {
        self.bad
    }

    /// The state of the list being drawn: call it when the frame's draw list is submitted.
    pub fn submit(&self, id: u32) -> Option<Presented> {
        let f = self.frames.get(&id)?;
        let (css, dpr, _) = f.size.unwrap_or(((0.0, 0.0), 1.0, (0, 0)));
        Some(Presented {
            seq: f.seq,
            rseq: f.rseq,
            css,
            dpr,
            series: f.series,
            stage: f.stage.clone(),
        })
    }

    /// The presentation `p` is complete: its `stage` when it is of the frame's current Resize and
    /// differs from the last reported (rseq, stage), then its `drawn` (ADR-0019), from `p` only;
    /// none for a frame gone since, or at size 0.
    pub fn complete(&mut self, id: u32, p: &Presented, start_ms: f64, end_ms: f64) -> Vec<String> {
        let Some(f) = self.frames.get(&id) else {
            return Vec::new();
        };
        if !(p.css.0 > 0.0 && p.css.1 > 0.0) {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(2);
        let now = (p.rseq, p.stage.clone());
        if p.rseq == f.rseq && self.reported.get(&id) != Some(&now) {
            out.push(events::stage(id, p.rseq, p.stage.as_ref()));
            self.reported.insert(id, now);
        }
        out.push(events::drawn(id, p, start_ms, end_ms));
        out
    }

    /// The end of a tick: one `applied` per frame with records applied since the last call.
    pub fn take_applied(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        for (id, f) in &mut self.frames {
            if std::mem::take(&mut f.applied) {
                out.push(events::applied(*id, f.seq));
            }
        }
        out
    }

    pub fn contains(&self, id: u32) -> bool {
        self.frames.contains_key(&id)
    }

    /// The frame's `FrameInit.id` (ADR-0019; diagnostic only).
    pub fn frame_id(&self, id: u32) -> Option<&str> {
        self.frames.get(&id)?.frame_id.as_deref()
    }

    /// The TS `VisSpec` JSON. A spec that does not parse clears the frame.
    pub fn set_spec(&mut self, id: u32, json: &str) -> Result<(), CoreError> {
        let f = self.frames.get_mut(&id).ok_or(CoreError::NoFrame)?;
        match VisSpec::from_json(json) {
            Ok(spec) => {
                f.spec = Some(spec);
                Ok(())
            }
            Err(e) => {
                f.spec = None;
                Err(CoreError::Spec(e))
            }
        }
    }

    pub fn set_camera(&mut self, id: u32, c: CameraIn) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.camera = Some(c);
        }
    }

    pub fn set_theme(&mut self, id: u32, theme: Theme) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.theme = theme;
        }
    }

    /// CSS px, DPR and device px; `rseq` is the Resize record's seq.
    pub fn resize(&mut self, id: u32, css: (f32, f32), dpr: f32, device: (u32, u32), rseq: u32) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.size = Some((css, dpr, device));
            f.rseq = rseq;
        }
    }

    /// CSS px, DPR and device px of the last resize.
    pub fn size(&self, id: u32) -> Option<FrameSize> {
        self.frames.get(&id)?.size
    }

    pub fn dispose(&mut self, id: u32) {
        self.frames.remove(&id);
        self.reported.remove(&id);
    }

    /// The frame's data (the Part D seam): `None` clears it.
    pub fn set_chunk(&mut self, id: u32, chunk: Option<Arc<Chunk>>) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.data = chunk;
        }
    }

    /// Starts a chunk from TS series in the local id space.
    pub fn data_begin(&mut self, id: u32) {
        let next = self.ids.next();
        if let Some(f) = self.frames.get_mut(&id) {
            f.building = Some(match next {
                Some(cid) => Building::Open(ChunkBuilder::explicit(cid)),
                None => Building::NoIds,
            });
        }
    }

    /// One TS series of the chunk being built. On an error the frame's data is cleared and the
    /// rest of this chunk is ignored.
    pub fn data_series(
        &mut self,
        id: u32,
        key: &str,
        names: Vec<String>,
        values: Vec<String>,
        t_ms: &[f64],
        v: &[f64],
    ) -> Result<(), CoreError> {
        let f = self.frames.get_mut(&id).ok_or(CoreError::NoFrame)?;
        let Some(Building::Open(b)) = f.building.as_mut() else {
            return Ok(());
        };
        let pushed = key_hash(key).and_then(|key_hash| {
            let labels: Vec<(String, String)> = names.into_iter().zip(values).collect();
            let meta = SeriesMeta {
                key_hash,
                labels: labels.into(),
            };
            b.push_series(meta, Some(t_ms), v).map_err(CoreError::Chunk)
        });
        if let Err(e) = pushed {
            f.data = None;
            f.building = Some(Building::Rejected);
            return Err(e);
        }
        Ok(())
    }

    /// Ends the chunk and makes it the frame's data (through [`Frames::set_chunk`]).
    pub fn data_end(&mut self, id: u32) -> Result<(), CoreError> {
        let f = self.frames.get_mut(&id).ok_or(CoreError::NoFrame)?;
        match f.building.take() {
            Some(Building::Open(b)) => {
                f.data = Some(Arc::new(b.finish()));
                Ok(())
            }
            Some(Building::NoIds) => {
                f.data = None;
                Err(CoreError::Chunk(ChunkError::Ids))
            }
            // A series error was reported already.
            Some(Building::Rejected) | None => Ok(()),
        }
    }

    /// No data (heatmap and scalar frames send none to the engine).
    pub fn data_clear(&mut self, id: u32) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.data = None;
            f.building = None;
        }
    }

    /// The frame ids, in order.
    pub fn ids(&self) -> Vec<u32> {
        self.frames.keys().copied().collect()
    }

    /// The draw list of frame `id` and its `a11y` summary JSON when it changed since the last
    /// build; `None` for an unknown frame.
    pub fn build(&mut self, id: u32) -> Option<(DrawList, Option<String>)> {
        let f = self.frames.get_mut(&id)?;
        let ((w, h), dpr, _) = f.size.unwrap_or(((0.0, 0.0), 1.0, (0, 0)));
        let css = Size64 {
            w: f64::from(w),
            h: f64::from(h),
        };
        let window = f
            .camera
            .map_or((f64::NAN, f64::NAN), |c| (c.view.lo, c.view.hi));
        let spec = f
            .spec
            .clone()
            .unwrap_or(VisSpec::Unsupported(VisKind::Line));
        let v = Viewport {
            id,
            frame_id: f.frame_id.clone(),
            css,
            dpr,
            theme: f.theme,
            camera: Camera::Plot2D(PlotCamera {
                x: Range64::from(window),
                y: f.camera
                    .and_then(|c| c.value)
                    .map_or(YRange::Auto, YRange::Manual),
            }),
            spec: spec.clone(),
            data: f.data.clone(),
            band: f
                .camera
                .and_then(|c| c.band)
                .map_or(Band::Measure, Band::Fixed),
        };
        let (list, summary, stage) = build_stage(&v);
        f.series = series_of(&list);
        f.stage = stage;
        let summary = match (&f.spec, summary) {
            (None, _) => None,
            (Some(VisSpec::Unsupported(kind)), _) => f
                .camera
                .map(|c| unsupported_summary(*kind, (c.view.lo, c.view.hi), css)),
            (Some(VisSpec::Line(_)), Some(s)) => serde_json::to_value(s).ok().map(|mut s| {
                if let Some(o) = s.as_object_mut() {
                    o.insert("thresholdLabels".into(), json!([]));
                    o.insert("eventLabels".into(), json!([]));
                }
                s
            }),
            (Some(VisSpec::Line(_)), None) => None,
        };
        let text = summary.map(|s| s.to_string());
        let changed = match &text {
            Some(t) if f.last_a11y.as_deref() != Some(t.as_str()) => {
                f.last_a11y = Some(t.clone());
                Some(t.clone())
            }
            _ => None,
        };
        Some((list, changed))
    }
}
