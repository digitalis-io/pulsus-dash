//! The render worker's frame table (plan #68 C1 §3.4): one viewport per ChartFrame, built into a
//! draw list and an `a11y` summary. Data enters only through [`Frames::set_chunk`] (the Part D
//! seam); the `data_*` calls build a chunk in the local id space (`2⁶³..2⁶⁴`) from the TS series,
//! so the decoder's stream ids never collide with them in a renderer's caches.
//!
//! A kind the engine does not draw yet (`bars`, `heatmap`, `stat`) clears and reports an empty
//! summary (no series, null values and axis, the whole canvas as the plot) until #69. A spec that
//! does not parse clears the frame and reports nothing.

use std::collections::BTreeMap;
use std::sync::Arc;

use dash_marks::DrawList;
use dash_scene::{
    Band, Camera, PlotCamera, Range64, Size64, Theme, Viewport, VisKind, VisSpec, build,
};
use dash_wire::{Chunk, ChunkBuilder, ChunkError, IdAlloc, IdSpace, SeriesMeta};
use serde_json::{Value, json};

use crate::CoreError;
use crate::input::Decoded;

/// A camera from an input record (TODO C2a1: stub).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraIn {
    pub view: Range64,
    pub value: Option<Range64>,
    pub band: Option<f64>,
}

impl CameraIn {
    pub fn from_record(_view: (f64, f64), _value: (f64, f64), _band: f64) -> Option<Self> {
        None
    }
}

/// What one submitted presentation shows (TODO C2a1: stub).
#[derive(Clone, Debug, PartialEq)]
pub struct Presented {
    pub seq: u32,
    pub rseq: u32,
    pub css: (f32, f32),
    pub dpr: f32,
    pub series: u32,
}

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
    size: Option<((f32, f32), f32, (u32, u32))>,
    data: Option<Arc<Chunk>>,
    building: Option<Building>,
    /// The summary JSON reported last.
    last_a11y: Option<String>,
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
        }
    }
}

/// Every frame of the page, by the adapter's id.
#[derive(Debug)]
pub struct Frames {
    frames: BTreeMap<u32, Frame>,
    ids: IdAlloc,
}

impl Default for Frames {
    fn default() -> Self {
        Self {
            frames: BTreeMap::new(),
            ids: IdAlloc::new(IdSpace::Local),
        }
    }
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

    /// A new frame (TODO C2a1: the id contract).
    pub fn create(&mut self, id: u32, frame_id: Option<String>) -> bool {
        self.frames.insert(id, Frame::new(frame_id));
        true
    }

    /// TODO C2a1.
    pub fn apply(&mut self, _d: &Decoded) -> Option<u32> {
        None
    }

    /// Input records rejected by `apply`.
    pub fn bad(&self) -> u32 {
        0
    }

    /// TODO C2a1.
    pub fn submit(&self, _id: u32) -> Option<Presented> {
        None
    }

    /// TODO C2a1.
    pub fn complete(
        &mut self,
        _id: u32,
        _p: &Presented,
        _start_ms: f64,
        _end_ms: f64,
    ) -> Vec<String> {
        Vec::new()
    }

    /// TODO C2a1.
    pub fn take_applied(&mut self) -> Vec<String> {
        Vec::new()
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

    /// TODO C2a1.
    pub fn set_camera(&mut self, _id: u32, _c: CameraIn) {}

    pub fn set_theme(&mut self, id: u32, theme: Theme) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.theme = theme;
        }
    }

    pub fn resize(&mut self, id: u32, css: (f32, f32), dpr: f32, device: (u32, u32), _rseq: u32) {
        if let Some(f) = self.frames.get_mut(&id) {
            f.size = Some((css, dpr, device));
        }
    }

    /// CSS px, DPR and device px of the last resize.
    pub fn size(&self, id: u32) -> Option<((f32, f32), f32, (u32, u32))> {
        self.frames.get(&id)?.size
    }

    pub fn dispose(&mut self, id: u32) {
        self.frames.remove(&id);
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
            camera: Camera::Plot2D(PlotCamera::idle(Range64::from(window), &spec)),
            spec: spec.clone(),
            data: f.data.clone(),
            band: Band::Measure,
        };
        let (list, summary) = build(&v);
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
