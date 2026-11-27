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
//!
//! Part C2b (§4.3): an Overlay record sets the frame's hover and box band and dirties the frame,
//! but not its layer: the build reuses the cached layer list unless a layer input (spec, data,
//! events, theme, Resize, Camera) changed, recomputes the hover when an Overlay was applied since the last
//! build (one `hover` event, with that Overlay's seq), then appends the overlay item, so the list
//! drawn in a tick carries the hover that tick emits (T02-024). A Select record is answered at
//! once against the presentation on screen (the last completed one, `onscreen`), never a newer
//! state (ADR-0025): one `select` event, none while nothing is on screen.
//!
//! Part C2c1 (§4.2): the event markers' times ([`Frames::set_events`]) are a layer input; the
//! layer list carries the threshold and event lines as an `Overlay` item before the hover's.
//! Part C2c2 (§4.2): the page selection ([`Frames::set_selection`]) is a layer input too: the Line
//! item's emphasis and the band, first in that `Overlay` item.

use std::collections::BTreeMap;
use std::sync::Arc;

use dash_marks::{DrawList, MarkItem};
use dash_scene::hover::{HoverAt, HoverOut, PickSnap, hover_at, key_on, overlay_item, pick_item};
use dash_scene::{
    Band, Camera, PlotCamera, Range64, SelectionIn, Size64, StageInfo, Theme, Viewport, VisKind,
    VisSpec, YRange, build_frame,
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

/// The overlay of an Overlay record (plan #68 C2b §3.1): the hover and the box band's ends, CSS px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverlayIn {
    pub hover: HoverAt,
    pub box_x: Option<(f64, f64)>,
}

impl OverlayIn {
    /// None: hover > 2, box > 1, a non-finite pointer x or y (hover 1), or a non-finite box end
    /// (box 1). Fields a mode does not use are ignored.
    #[allow(clippy::too_many_arguments)]
    pub fn from_record(
        hover: u8,
        boxed: u8,
        x: f64,
        y: f64,
        key: u32,
        box_x0: f64,
        box_x: f64,
    ) -> Option<Self> {
        let hover = match hover {
            0 => HoverAt::None,
            1 if x.is_finite() && y.is_finite() => HoverAt::Pointer { x, y },
            2 => HoverAt::Key(key),
            _ => return None,
        };
        let box_x = match boxed {
            0 => None,
            1 if box_x0.is_finite() && box_x.is_finite() => Some((box_x0, box_x)),
            _ => return None,
        };
        Some(Self { hover, box_x })
    }
}

const NO_OVERLAY: OverlayIn = OverlayIn {
    hover: HoverAt::None,
    box_x: None,
};

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
    /// What picking reads of the list (plan #68 C2b §3.2): Some exactly when `stage` is.
    pub pick: Option<Arc<PickSnap>>,
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
    /// The event markers' times, ms (plan #68 C2c1 §3.1): a layer input.
    events: Arc<[f64]>,
    /// The page selection (plan #68 C2c2 §3.2): a layer input.
    selection: Arc<SelectionIn>,
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
    /// What picking reads of the last built list (Some exactly when `stage` is).
    pick: Option<Arc<PickSnap>>,
    /// The last applied Overlay, its seq, and whether one was applied since the last build.
    overlay: OverlayIn,
    oseq: u32,
    overlay_dirty: bool,
    /// A layer input changed since the cached list was built.
    layer_dirty: bool,
    /// The last built list, without the overlay.
    layer: Option<DrawList>,
    /// The hover the overlay draws, until the next Overlay (Canvas 2D's `lastHover`).
    last_hover: Option<HoverOut>,
    /// What the presentation on screen picks on: set when one completes.
    onscreen: Option<Arc<PickSnap>>,
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
            events: Arc::from([]),
            selection: Arc::default(),
            building: None,
            last_a11y: None,
            seq: 0,
            rseq: 0,
            applied: false,
            series: 0,
            stage: None,
            pick: None,
            overlay: NO_OVERLAY,
            oseq: 0,
            overlay_dirty: false,
            layer_dirty: true,
            layer: None,
            last_hover: None,
            onscreen: None,
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
    /// `select` events of the records applied since the last `take_events`, in apply order.
    events: Vec<String>,
    /// `build_frame` calls (the layer builds).
    layer_builds: u64,
}

impl Default for Frames {
    fn default() -> Self {
        Self {
            frames: BTreeMap::new(),
            ids: IdAlloc::new(IdSpace::Local),
            highest: 0,
            bad: 0,
            reported: BTreeMap::new(),
            events: Vec::new(),
            layer_builds: 0,
        }
    }
}

/// Series a draw list draws.
pub fn series_of(list: &DrawList) -> u32 {
    list.items
        .iter()
        .map(|i| match i {
            MarkItem::Line { series, .. } => series.end.saturating_sub(series.start),
            MarkItem::Guides { .. } | MarkItem::Overlay { .. } => 0,
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
    /// ack seq moves to the record's and the next presentation carries it. The same holds for an
    /// Overlay `OverlayIn::from_record` rejects and a Select with a non-finite point (plan #68 C2b
    /// §3.1). A valid Select is answered at once from the presentation on screen.
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
                f.layer_dirty = true;
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
                        f.layer_dirty = true;
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
            Record::Overlay {
                frame,
                hover,
                boxed,
                x,
                y,
                key,
                box_x0,
                box_x,
            } => {
                let f = self.frames.get_mut(&frame)?;
                f.seq = d.seq;
                f.applied = true;
                match OverlayIn::from_record(hover, boxed, x, y, key, box_x0, box_x) {
                    Some(o) => {
                        f.overlay = o;
                        f.oseq = d.seq;
                        f.overlay_dirty = true;
                    }
                    None => self.bad = self.bad.saturating_add(1),
                }
                Some(frame)
            }
            Record::Select { frame, x, y } => {
                let f = self.frames.get_mut(&frame)?;
                f.seq = d.seq;
                f.applied = true;
                if !(x.is_finite() && y.is_finite()) {
                    self.bad = self.bad.saturating_add(1);
                } else if let Some(s) = f.onscreen.as_deref() {
                    self.events
                        .push(events::select(frame, pick_item(s, x, y).as_ref()));
                }
                // Dirtied either way, so the next `drawn` carries the record's seq.
                Some(frame)
            }
        }
    }

    /// Records rejected by `apply` so far.
    pub fn bad(&self) -> u32 {
        self.bad
    }

    /// The `select` events of the records applied since the last call, in apply order.
    pub fn take_events(&mut self) -> Vec<String> {
        std::mem::take(&mut self.events)
    }

    /// Test hook: `build_frame` calls so far (an Overlay alone reuses the cached layer).
    pub fn layer_builds(&self) -> u64 {
        self.layer_builds
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
            pick: f.pick.clone(),
        })
    }

    /// The presentation `p` is complete: its `stage` when it is of the frame's current Resize and
    /// differs from the last reported (rseq, stage), then its `drawn` (ADR-0019), from `p` only;
    /// none for a frame gone since, or at size 0. It is now what is on screen: clicks pick on it
    /// (nothing at size 0 or without a plot).
    pub fn complete(&mut self, id: u32, p: &Presented, start_ms: f64, end_ms: f64) -> Vec<String> {
        let Some(f) = self.frames.get_mut(&id) else {
            return Vec::new();
        };
        if !(p.css.0 > 0.0 && p.css.1 > 0.0) {
            f.onscreen = None;
            return Vec::new();
        }
        f.onscreen = p.pick.clone();
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
                f.layer_dirty = true;
                Ok(())
            }
            Err(e) => {
                f.spec = None;
                f.layer_dirty = true;
                Err(CoreError::Spec(e))
            }
        }
    }

    pub fn set_camera(&mut self, id: u32, c: CameraIn) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.camera = Some(c);
            f.layer_dirty = true;
        }
    }

    pub fn set_theme(&mut self, id: u32, theme: Theme) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.theme = theme;
            f.layer_dirty = true;
        }
    }

    /// CSS px, DPR and device px; `rseq` is the Resize record's seq.
    pub fn resize(&mut self, id: u32, css: (f32, f32), dpr: f32, device: (u32, u32), rseq: u32) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.size = Some((css, dpr, device));
            f.rseq = rseq;
            f.layer_dirty = true;
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
            f.layer_dirty = true;
        }
    }

    /// The frame's event markers' times, ms (plan #68 C2c1 §3.1), in call order: a layer input.
    pub fn set_events(&mut self, id: u32, at_ms: Vec<f64>) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.events = Arc::from(at_ms);
            f.layer_dirty = true;
        }
    }

    /// The frame's selection (plan #68 C2c2 §3.2): a layer input.
    pub fn set_selection(&mut self, id: u32, s: SelectionIn) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.selection = Arc::new(s);
            f.layer_dirty = true;
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
            f.layer_dirty = true;
            f.building = Some(Building::Rejected);
            return Err(e);
        }
        Ok(())
    }

    /// Ends the chunk and makes it the frame's data (through [`Frames::set_chunk`]).
    pub fn data_end(&mut self, id: u32) -> Result<(), CoreError> {
        let f = self.frames.get_mut(&id).ok_or(CoreError::NoFrame)?;
        f.layer_dirty = true;
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
            f.layer_dirty = true;
        }
    }

    /// The frame ids, in order.
    pub fn ids(&self) -> Vec<u32> {
        self.frames.keys().copied().collect()
    }

    /// The draw list of frame `id`, its `a11y` summary JSON when it changed since the last build
    /// and its `hover` event when an Overlay was applied since the last build (plan #68 C2b §4.3);
    /// `None` for an unknown frame. The layer is rebuilt only when a layer input changed; the
    /// overlay item, last, draws the hover this build emits.
    #[allow(clippy::type_complexity)]
    pub fn build(&mut self, id: u32) -> Option<(DrawList, Option<String>, Option<String>)> {
        let f = self.frames.get_mut(&id)?;
        let mut changed = None;
        if f.layer_dirty || f.layer.is_none() {
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
                events: f.events.clone(),
                selection: f.selection.clone(),
                fit: None,
                fade: None,
            };
            let built = build_frame(&v);
            self.layer_builds += 1;
            f.series = series_of(&built.list);
            f.stage = built.stage;
            f.pick = built.pick;
            let summary = match (&f.spec, built.summary) {
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
            changed = match &text {
                Some(t) if f.last_a11y.as_deref() != Some(t.as_str()) => {
                    f.last_a11y = Some(t.clone());
                    Some(t.clone())
                }
                _ => None,
            };
            f.layer = Some(built.list);
            f.layer_dirty = false;
        }
        // The hover of the last Overlay, on this list's pick (none without a plot); a key index
        // from an older stage is clamped to this pick's samples (`key_on`).
        let hover = if std::mem::take(&mut f.overlay_dirty) {
            f.last_hover = f
                .pick
                .as_deref()
                .and_then(|p| hover_at(p, key_on(p, f.overlay.hover)));
            Some(events::hover(id, f.oseq, f.last_hover.as_ref()))
        } else {
            None
        };
        let mut list = f.layer.clone()?;
        if let Some(p) = f.pick.as_deref() {
            list.items.push(overlay_item(
                p,
                f.last_hover.as_ref(),
                f.overlay.box_x,
                f.theme,
            ));
        }
        Some((list, changed, hover))
    }
}

/// The probe build (plan #68 C2d1 §3.2): F1c built in the worker, so `bench:frame-line-1e8` can
/// hold 10⁸ points without a structured clone.
#[cfg(feature = "probe")]
impl Frames {
    /// F1c: `pulsus_synth::reference::f1a(series, points)`'s grid (key_hash = s, values from
    /// `f1a_value`) as the frame's data, through [`Frames::set_chunk`], with a local chunk id.
    /// Every buffer is reserved fallibly; false, with the frame unchanged, for an unknown frame, a
    /// grid the window cannot hold (`points` 0 or above 10⁶), more than 2³¹ samples or a failed
    /// allocation. On success the previous chunk is dropped (with the cached layer and pick that
    /// read it) and the frame is dirty.
    pub fn synth_f1c(&mut self, id: u32, series: u32, points: u32) -> bool {
        if !self.frames.contains_key(&id) {
            return false;
        }
        let Some(mut chunk) = f1c_chunk(series, points) else {
            return false;
        };
        let Some(cid) = self.ids.next() else {
            return false;
        };
        chunk.id = cid;
        // The previous chunk goes now: the data and the cached layer and pick that read it (the
        // next build remakes both; the presentation on screen keeps its own until replaced).
        if let Some(f) = self.frames.get_mut(&id) {
            f.data = None;
            f.layer = None;
            f.pick = None;
        }
        self.set_chunk(id, Some(Arc::new(chunk)));
        true
    }

    /// The frame's data (`probe_synth` checks the previous chunk was dropped).
    pub fn chunk(&self, id: u32) -> Option<Arc<Chunk>> {
        self.frames.get(&id)?.data.clone()
    }
}

/// Series `s`'s labels, `[("s", s)]` as `pulsus_synth::reference` makes them, with the strings and
/// the pair list reserved fallibly (None on a failure). The shared slice itself (`Arc<[_]>`, one
/// small allocation per series) has no fallible constructor on stable Rust: it is the one
/// infallible allocation left, made only after the values, offsets and metas were reserved.
#[cfg(feature = "probe")]
fn f1c_labels(s: usize) -> Option<std::sync::Arc<[(String, String)]>> {
    use std::fmt::Write;
    let mut name = String::new();
    name.try_reserve_exact(1).ok()?;
    name.push('s');
    let mut value = String::new();
    // usize::MAX has 20 decimal digits.
    value.try_reserve_exact(20).ok()?;
    write!(value, "{s}").ok()?;
    let mut pairs: Vec<(String, String)> = Vec::new();
    pairs.try_reserve_exact(1).ok()?;
    pairs.push((name, value));
    Some(pairs.into())
}

/// F1c's chunk as `pulsus_synth::reference`'s grid builds it (the same time axis, metas, offsets,
/// values and finite range), each buffer reserved with `try_reserve_exact`; None on a failure.
#[cfg(feature = "probe")]
fn f1c_chunk(series: u32, points: u32) -> Option<Chunk> {
    use dash_wire::TimeAxis;
    use dash_wire::chunk::MAX_SAMPLES;
    use pulsus_synth::reference::{WINDOW, f1a_value};
    if points == 0 {
        return None;
    }
    let step = (WINDOW.1 / f64::from(points)) as i64;
    if step < 1 {
        return None;
    }
    let n = series as usize;
    let total = n.checked_mul(points as usize)?;
    if total > MAX_SAMPLES {
        return None;
    }
    let mut values: Vec<f64> = Vec::new();
    values.try_reserve_exact(total).ok()?;
    let mut offsets: Vec<u32> = Vec::new();
    offsets.try_reserve_exact(n.checked_add(1)?).ok()?;
    let mut metas: Vec<SeriesMeta> = Vec::new();
    metas.try_reserve_exact(n).ok()?;
    offsets.push(0);
    let mut finite: Option<(f64, f64)> = None;
    for s in 0..n {
        for k in 0..points {
            let v = f1a_value(s, k);
            if v.is_finite() {
                finite = Some(finite.map_or((v, v), |(lo, hi)| (lo.min(v), hi.max(v))));
            }
            values.push(v);
        }
        // total ≤ 2³¹, so it fits u32.
        offsets.push(u32::try_from(values.len()).ok()?);
        metas.push(SeriesMeta {
            key_hash: s as u64,
            labels: f1c_labels(s)?,
        });
    }
    Some(Chunk {
        id: dash_wire::ChunkId(0),
        time: TimeAxis::Grid {
            start_ms: 0,
            step_ms: step,
            len: points,
        },
        series: metas,
        offsets,
        values,
        present: None,
        finite,
    })
}
