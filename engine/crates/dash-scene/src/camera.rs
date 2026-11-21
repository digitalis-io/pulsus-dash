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
    /// The idle camera (#93 §3.4 "Idle" column): x = window, y = the spec's `valueRange` when it
    /// is valid, else Auto.
    pub fn idle(window: Range64, spec: &VisSpec) -> Self {
        let y = match spec {
            VisSpec::Line(l) => l
                .value_range
                .and_then(|r| r.validated())
                .map_or(YRange::Auto, YRange::Manual),
            VisSpec::Unsupported(_) => YRange::Auto,
        };
        Self { x: window, y }
    }
}

impl Camera {
    /// (plot x, plot y css, lane z) → clip space, composed in f64 (T02-014). `Plot2D` is the
    /// orthographic map of the CSS box: (0, 0) → (−1, 1), (w, h) → (1, −1), z ignored (clip z 0).
    pub fn view_proj(&self, css: Size64) -> glam::DMat4 {
        match self {
            Camera::Plot2D(_) => glam::DMat4::from_cols(
                glam::DVec4::new(2.0 / css.w, 0.0, 0.0, 0.0),
                glam::DVec4::new(0.0, -2.0 / css.h, 0.0, 0.0),
                glam::DVec4::ZERO,
                glam::DVec4::new(-1.0, 1.0, 0.0, 1.0),
            ),
        }
    }
}

/// Limits of a camera axis (#93 `timeLimits` / `valueLimits`, supplied by the caller).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpanLimits {
    pub min_span: f64,
    pub max_span: f64,
    pub lo: f64,
    pub hi: f64,
}

/// ECMAScript `Math.round` (half toward +∞).
pub fn js_round(x: f64) -> f64 {
    dash_units::js_round(x)
}

/// Zoom `s` by `factor` about the fraction `f` of it. The floor is `min(w, min_span)` when zooming
/// in (a span already below the floor never grows) and `min_span` otherwise; an unchanged span
/// returns `s` bit for bit.
pub fn zoom_about(s: Range64, f: f64, factor: f64, l: &SpanLimits) -> Range64 {
    let w = s.hi - s.lo;
    let a = s.lo + f * w;
    let floor = if factor < 1.0 {
        w.min(l.min_span)
    } else {
        l.min_span
    };
    let w2 = (w * factor).max(floor).min(l.max_span);
    if w2 == w {
        return s;
    }
    let lo = a - f * w2;
    contain(Range64 { lo, hi: lo + w2 }, l)
}

/// Pan `s` by `fraction` of its span. `step`: None = 0 (no quantisation); `Some(q)` with q > 0
/// rounds the offset to whole multiples of q (#93 A.13 F1: the caller picks it).
pub fn pan_by(s: Range64, fraction: f64, l: &SpanLimits, step: Option<f64>) -> Range64 {
    let mut d = fraction * (s.hi - s.lo);
    if let Some(q) = step.filter(|q| *q > 0.0) {
        d = js_round(d / q) * q;
    }
    contain(
        Range64 {
            lo: s.lo + d,
            hi: s.hi + d,
        },
        l,
    )
}

/// Keep `s` inside [l.lo, l.hi], shrinking it to the limits' width when wider.
pub fn contain(s: Range64, l: &SpanLimits) -> Range64 {
    if s.lo >= l.lo && s.hi <= l.hi {
        return s;
    }
    let w = (s.hi - s.lo).min(l.hi - l.lo);
    if s.lo < l.lo {
        Range64 {
            lo: l.lo,
            hi: l.lo + w,
        }
    } else {
        Range64 {
            lo: l.hi - w,
            hi: l.hi,
        }
    }
}

/// (x − plot.x)/plot.width.
pub fn fx(plot: &dash_axes::PlotRect, x: f64) -> f64 {
    (x - plot.x) / plot.width
}

/// 1 − (y − plot.y)/plot.height.
pub fn fy(plot: &dash_axes::PlotRect, y: f64) -> f64 {
    1.0 - (y - plot.y) / plot.height
}

/// Whole-ms window: ECMAScript Math.round of both ends (half toward +∞), to ≥ from + 1.
pub fn to_window(x: Range64) -> TimeWindow {
    let from = js_round(x.lo);
    TimeWindow {
        from_ms: from,
        to_ms: js_round(x.hi).max(from + 1.0),
    }
}
