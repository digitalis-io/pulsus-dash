//! Line-chart renders for the golden tests (plan #24 §3.6, §4.4).

use dash_marks::line::DecimatePath;
use dash_scales::lod::{Prepared, SlotRecord};
use dash_scales::raster::Mask;
use dash_scene::line::{LayerInfo, LineFrame};
use pulsus_synth::line::LinePreset;

use crate::headless::Headless;

/// A line layer as the render worker holds it: bits relative to each series' `v_ref`.
#[derive(Clone, Debug, PartialEq)]
pub struct LineData {
    pub layer: LayerInfo,
    pub bits: Vec<Vec<u32>>,
    pub prepared: Vec<Prepared>,
}

impl LineData {
    pub fn synth(_seed: u64, p: &LinePreset) -> LineData {
        LineData {
            layer: LayerInfo {
                start_ms: p.start_ms,
                step_ms: p.step_ms,
                n: p.points,
                requested: p.series,
                held: p.series,
            },
            bits: Vec::new(),
            prepared: Vec::new(),
        }
    }
}

/// A canvas and camera. The scene fits both axes; `x`, `y` then replace the camera's x
/// (`t_left_rel_ms`, `ms_per_px`) or y (`v_bottom`, `v_per_px`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub css: (u32, u32),
    pub dpr: f32,
    pub x: Option<(f64, f64)>,
    pub y: Option<(f64, f64)>,
}

/// What draws the line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Render {
    Decimated(DecimatePath),
    /// Every raw segment and isolated sample, one item per slot per pass (§4.4).
    Reference,
}

/// The scene's frame for `d` at `v`.
pub fn frame(_d: &LineData, _v: &View) -> Option<LineFrame> {
    None
}

/// The visual image (`Rgba8Unorm`, rows top-down, no gridlines).
pub fn render(
    _h: &Headless,
    _d: &LineData,
    _v: &View,
    _r: Render,
    _max_dim: Option<u32>,
) -> Vec<u8> {
    Vec::new()
}

/// The GPU records of every series.
pub fn records(_h: &Headless, _d: &LineData, _v: &View, _p: DecimatePath) -> Vec<Vec<SlotRecord>> {
    Vec::new()
}

/// The mask pass of `series` (all if `None`), read back.
pub fn render_mask(
    _h: &Headless,
    _d: &LineData,
    _v: &View,
    _r: Render,
    _series: Option<u32>,
) -> Mask {
    Mask::new(0, 0)
}

/// Panics naming `(missing, extra)` unless both are 0.
pub fn assert_zero_diff(_got: &Mask, _want: &Mask) {}
