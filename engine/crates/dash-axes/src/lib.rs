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
    /// y in CSS px of value `v`: `plot.y + (1 − (v − lo)/(hi − lo))·plot.height` (draw.ts), the
    /// halved form when `hi − lo` overflows.
    pub fn y(&self, v: f64) -> f64 {
        let d = self.domain;
        let q = if (d.hi - d.lo).is_finite() {
            (v - d.lo) / (d.hi - d.lo)
        } else {
            (v / 2.0 - d.lo / 2.0) / (d.hi / 2.0 - d.lo / 2.0)
        };
        self.plot.y + (1.0 - q) * self.plot.height
    }
}

/// A token as the f64 it was authored as: `tokens.rs` holds f32, and `0.6f32 as f64` is
/// 0.6000000238…, which would change `ceil` results; the shortest decimal round-trips exactly.
fn tok(x: f32) -> f64 {
    x.to_string().parse().unwrap_or(f64::from(x))
}

/// ceil(font.size.xs · line_height.tight) = 14 (layout.ts `LABEL_HEIGHT`).
pub fn label_height() -> f64 {
    (tok(dash_tokens::font::size::XS) * tok(dash_tokens::line_height::TIGHT)).ceil()
}

/// ceil(max chars × font.advance.mono × font.size.xs); chars = Unicode scalar values. JetBrains
/// Mono is monospaced, so this equals the interim renderer's `measureText` once the font is loaded.
pub fn label_width(labels: &[String]) -> f64 {
    let advance = tok(dash_tokens::font::advance::MONO);
    let size = tok(dash_tokens::font::size::XS);
    let w = labels
        .iter()
        .map(|l| l.chars().count() as f64 * advance * size)
        .fold(0.0, f64::max);
    w.ceil()
}

/// Port of `canvas2d/layout.ts` `layoutPlot`: stat fills the frame; the other kinds leave room for
/// the value labels and the time axis.
pub fn layout_plot(kind: VisKind, css_w: f64, css_h: f64, value_label_w: f64) -> PlotRect {
    if kind == VisKind::Stat {
        return PlotRect {
            x: 0.0,
            y: 0.0,
            width: css_w,
            height: css_h,
        };
    }
    let space1 = tok(dash_tokens::space::S_1);
    let space2 = tok(dash_tokens::space::S_2);
    let tick = tok(dash_tokens::size::CHART_TICK);
    let bottom = tick + 2.0 * space1 + label_height();
    let x = value_label_w + space2 + tick;
    let y = space2;
    PlotRect {
        x,
        y,
        width: css_w - x - space2,
        height: css_h - y - bottom,
    }
}

fn base_of(unit: &Unit) -> u32 {
    if *unit == Unit::Bytes { 1024 } else { 1000 }
}

/// Ticks and domain: auto = draw.ts `valueAxis` over [min(0, data_min), data_max]; manual =
/// `value_ticks(r)` filtered to r with a 1e-9 relative tolerance, domain r (#93's plan §3.5).
/// Both fall back to `extreme_ticks` when `value_ticks` returns None.
fn ticks_of(
    kind: VisKind,
    css_w: f64,
    css_h: f64,
    data_min: f64,
    data_max: f64,
    manual: Option<Range64>,
    unit: &Unit,
) -> (Range64, Vec<f64>) {
    let height = layout_plot(kind, css_w, css_h, 0.0).height;
    let base = base_of(unit);
    match manual {
        None => {
            let lo = data_min.min(0.0);
            match dash_scales::value_ticks(lo, data_max, height, label_height(), base) {
                Some(vt) => (
                    Range64 {
                        lo: vt.min,
                        hi: vt.max,
                    },
                    vt.ticks,
                ),
                None => {
                    let vt = dash_scales::extreme_ticks(lo, data_max, height, label_height());
                    (
                        Range64 {
                            lo: vt.min,
                            hi: vt.max,
                        },
                        vt.ticks,
                    )
                }
            }
        }
        Some(r) => {
            let ticks = match dash_scales::value_ticks(r.lo, r.hi, height, label_height(), base) {
                Some(vt) => {
                    let span = r.hi / 2.0 - r.lo / 2.0;
                    let tol = 2e-9 * span;
                    vt.ticks
                        .into_iter()
                        .filter(|t| *t >= r.lo - tol && *t <= r.hi + tol)
                        .collect()
                }
                None => dash_scales::extreme_ticks(r.lo, r.hi, height, label_height()).ticks,
            };
            (r, ticks)
        }
    }
}

/// The narrowest value band of `kind` in `unit` (draw.ts `minValueBand`, T02-011): the width of
/// the widest compact label, so a whole compact label always fits; 0 for stat (no value axis).
pub fn min_value_band(kind: VisKind, unit: &Unit) -> f64 {
    if kind == VisKind::Stat {
        return 0.0;
    }
    label_width(&dash_units::compact_samples(unit))
}

/// The value axis. Auto (`manual = None`): port of draw.ts `valueAxis`: the height from
/// `layout_plot(.., 0)`, ticks over [min(0, data_min), data_max], base 1024 for bytes else 1000,
/// labels by `format_value`, domain (vt.min, vt.max). Manual (`Some(r)`): ticks inside r, domain
/// r. Then `layout_plot` with the band: `Measure` = the labels' width, at least
/// [`min_value_band`] (as the Canvas 2D engine, so both draw the same plot, plan #68 C1);
/// `Fixed(w)` never changes with the labels, and a label wider than `w` has `fits = false` (#69
/// draws it on a chip).
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
    let (domain, ticks) = ticks_of(kind, css_w, css_h, data_min, data_max, manual, unit);
    let texts: Vec<String> = ticks
        .iter()
        .map(|t| dash_units::format_value(*t, unit))
        .collect();
    let band_w = match band {
        Band::Measure => label_width(&texts).max(min_value_band(kind, unit)),
        Band::Fixed(w) => w,
    };
    let plot = layout_plot(kind, css_w, css_h, band_w);
    let mut axis = ValueAxis {
        plot,
        domain,
        ticks,
        labels: Vec::new(),
        manual: manual.is_some(),
        band_w,
    };
    axis.labels = axis
        .ticks
        .iter()
        .zip(texts)
        .map(|(t, text)| {
            let fits = label_width(std::slice::from_ref(&text)) <= band_w;
            AxisLabel {
                y_css: axis.y(*t),
                text,
                fits,
            }
        })
        .collect();
    axis
}

/// The band `value_axis(.., Band::Measure)` would use, without building the axis.
pub fn measure_value_band(
    kind: VisKind,
    css_w: f64,
    css_h: f64,
    data_min: f64,
    data_max: f64,
    manual: Option<Range64>,
    unit: &Unit,
) -> f64 {
    let (_, ticks) = ticks_of(kind, css_w, css_h, data_min, data_max, manual, unit);
    let texts: Vec<String> = ticks
        .iter()
        .map(|t| dash_units::format_value(*t, unit))
        .collect();
    label_width(&texts).max(min_value_band(kind, unit))
}
