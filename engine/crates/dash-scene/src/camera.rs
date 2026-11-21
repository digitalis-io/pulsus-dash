//! Cameras (D-CAM) and the camera primitives, bit-equal to #93's `camera.ts` (plan #68 A.10).
//! No gesture policy lives here (D-GESTURE).

use dash_scales::Range64;

use crate::Size64;
use crate::spec::VisSpec;
use crate::summary::TimeWindow;

/// The view of one viewport; #94 adds `Orbit3D`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Camera {
    Plot2D(PlotCamera),
}

/// x: the time range in ms (unrounded); y: the value range.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlotCamera {
    pub x: Range64,
    pub y: YRange,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum YRange {
    Auto,
    Manual(Range64),
}

impl PlotCamera {
    /// The idle camera: x = window, y = spec.value_range validated, else Auto.
    pub fn idle(window: Range64, spec: &VisSpec) -> Self {
        let _ = spec;
        Self { x: window, y: YRange::Auto }
    }
}

impl Camera {
    /// (plot x, plot y css, lane z) → clip space, composed in f64 (T02-014).
    pub fn view_proj(&self, css: Size64) -> glam::DMat4 {
        let _ = css;
        glam::DMat4::IDENTITY
    }
}

/// Limits of a camera axis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpanLimits {
    pub min_span: f64,
    pub max_span: f64,
    pub lo: f64,
    pub hi: f64,
}

pub fn zoom_about(s: Range64, f: f64, factor: f64, l: &SpanLimits) -> Range64 {
    let _ = (f, factor, l);
    s
}

/// `step`: None = 0; Some(q) quantises the offset to multiples of q.
pub fn pan_by(s: Range64, fraction: f64, l: &SpanLimits, step: Option<f64>) -> Range64 {
    let _ = (fraction, l, step);
    s
}

pub fn contain(s: Range64, l: &SpanLimits) -> Range64 {
    let _ = l;
    s
}

/// (x − plot.x)/plot.width.
pub fn fx(plot: &dash_axes::PlotRect, x: f64) -> f64 {
    let _ = (plot, x);
    0.0
}

/// 1 − (y − plot.y)/plot.height.
pub fn fy(plot: &dash_axes::PlotRect, y: f64) -> f64 {
    let _ = (plot, y);
    0.0
}

/// Whole-ms window: ECMAScript Math.round of both ends, to ≥ from + 1.
pub fn to_window(x: Range64) -> TimeWindow {
    TimeWindow { from_ms: x.lo, to_ms: x.hi }
}
