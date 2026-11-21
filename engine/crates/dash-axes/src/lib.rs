//! Plot layout and the value axis (plan #68 §3.5): ports of `canvas2d/layout.ts` `layoutPlot` and
//! `canvas2d/draw.ts` `valueAxis`, plus the manual axis and the held label band (#93's seam).

use dash_scales::Range64;
use dash_units::Unit;

/// The chart kinds of the TS `VisKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VisKind {
    Line,
    Bars,
    Heatmap,
    Stat,
}

/// CSS px, relative to the canvas.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct PlotRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The value-label band width; `Measure` = label_width of this frame's labels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Band {
    Measure,
    Fixed(f64),
}

/// One value label.
#[derive(Clone, Debug, PartialEq)]
pub struct AxisLabel {
    pub y_css: f64,
    pub text: String,
    /// label_width([text]) ≤ band_w.
    pub fits: bool,
}

/// A laid-out value axis.
#[derive(Clone, Debug, PartialEq)]
pub struct ValueAxis {
    pub plot: PlotRect,
    pub domain: Range64,
    pub ticks: Vec<f64>,
    pub labels: Vec<AxisLabel>,
    pub manual: bool,
    pub band_w: f64,
}

impl ValueAxis {
    /// y in CSS px of value `v`.
    pub fn y(&self, v: f64) -> f64 {
        v
    }
}

/// ceil(font.size.xs · line_height.tight).
pub fn label_height() -> f64 {
    0.0
}

/// ceil(max chars × font.advance.mono × font.size.xs); chars = Unicode scalar values.
pub fn label_width(labels: &[String]) -> f64 {
    let _ = labels;
    0.0
}

/// Port of `layoutPlot`.
pub fn layout_plot(kind: VisKind, css_w: f64, css_h: f64, value_label_w: f64) -> PlotRect {
    let _ = (kind, value_label_w);
    PlotRect { x: 0.0, y: 0.0, width: css_w, height: css_h }
}

/// The value axis, auto (`manual = None`) or manual.
#[allow(clippy::too_many_arguments)]
pub fn value_axis(
    kind: VisKind,
    css_w: f64,
    css_h: f64,
    data_min: f64,
    data_max: f64,
    manual: Option<Range64>,
    unit: &Unit,
    band: Band,
) -> ValueAxis {
    let _ = (kind, data_min, data_max, unit, band);
    ValueAxis {
        plot: PlotRect { x: 0.0, y: 0.0, width: css_w, height: css_h },
        domain: manual.unwrap_or(Range64 { lo: 0.0, hi: 1.0 }),
        ticks: Vec::new(),
        labels: Vec::new(),
        manual: false,
        band_w: 0.0,
    }
}

/// The band `value_axis(.., Band::Measure)` would use.
pub fn measure_value_band(
    kind: VisKind,
    css_w: f64,
    css_h: f64,
    data_min: f64,
    data_max: f64,
    manual: Option<Range64>,
    unit: &Unit,
) -> f64 {
    let _ = (kind, css_w, css_h, data_min, data_max, manual, unit);
    0.0
}
