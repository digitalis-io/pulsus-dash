//! The layer marks of a line frame (plan #68 C2c1 §3.2): threshold lines (ADR-0022) and event lines
//! (ADR-0023) as screen-space rectangles of the overlay pipeline, ports of the Canvas 2D
//! `thresholdMark.ts` `withThresholds` and `drawThresholds` (its dashed stroke) and `eventMark.ts`
//! `membersInView` and `drawEventLines`. Both are inside the plot by construction: dashes end at its
//! right edge and an event rect is cut there, with or without a manual axis. Their labels come
//! with the engine's text mark (#69).

use dash_axes::{PlotRect, ValueAxis};
use dash_marks::OverlayShape;
use dash_scales::Range64;
use dash_tokens::{ColourRole, Theme, colour};

use crate::camera::js_round;
use crate::spec::{ThresholdLine, ThresholdState};

/// TS `withThresholds`: `[min, max]` widened to every finite threshold value; `(0, 0)` when no
/// input is finite.
pub fn with_thresholds(min: Option<f64>, max: Option<f64>, t: &[ThresholdLine]) -> (f64, f64) {
    let mut lo = min.filter(|v| v.is_finite()).unwrap_or(f64::INFINITY);
    let mut hi = max.filter(|v| v.is_finite()).unwrap_or(f64::NEG_INFINITY);
    for v in t.iter().filter_map(|l| l.value).filter(|v| v.is_finite()) {
        lo = lo.min(v);
        hi = hi.max(v);
    }
    if lo == f64::INFINITY || hi == f64::NEG_INFINITY {
        return (0.0, 0.0);
    }
    (lo, hi)
}

fn state_role(s: ThresholdState) -> ColourRole {
    match s {
        ThresholdState::Watch => ColourRole::Watch,
        ThresholdState::Degraded => ColourRole::Degraded,
        ThresholdState::Failing => ColourRole::Failing,
    }
}

/// The dashed threshold lines (TS `drawThresholds`): each finite value whose `y` is inside the
/// plot (edges included), at row `round(y)`, 1 px (`border.hairline`) high, in its state colour.
/// Its dashes are Canvas 2D's of a stroke from `plot.x` to the plot's right edge with the pattern
/// `chart-dash`/`chart-dash-gap` at offset 0 and butt caps: dash k from `plot.x + k·(d + g)`, `d`
/// wide and cut at the right edge.
pub fn threshold_shapes(axis: &ValueAxis, t: &[ThresholdLine], theme: Theme) -> Vec<OverlayShape> {
    let plot = &axis.plot;
    let (x0, x1) = (plot.x, plot.x + plot.width);
    let dash = f64::from(dash_tokens::size::CHART_DASH);
    let period = dash + f64::from(dash_tokens::size::CHART_DASH_GAP);
    let height = dash_tokens::border::HAIRLINE;
    let mut out = Vec::new();
    for l in t {
        let Some(v) = l.value.filter(|v| v.is_finite()) else {
            continue;
        };
        let ly = axis.y(v);
        if !(ly >= plot.y && ly <= plot.y + plot.height) {
            continue;
        }
        let y0 = js_round(ly) as f32;
        let c = colour(theme, state_role(l.state));
        let mut k = 0.0;
        loop {
            let start = x0 + k * period;
            if start >= x1 {
                break;
            }
            out.push(OverlayShape::Rect {
                css: [start as f32, y0, dash.min(x1 - start) as f32, height],
                colour: c,
            });
            k += 1.0;
        }
    }
    out
}

/// The event lines (TS `membersInView` and `drawEventLines`): each finite time in `view` (ends
/// included), in ascending order, at column `round(plot.x + (at − lo)/(hi − lo)·plot.width)`, 1 px
/// wide and the plot's height, `text-muted`; cut at the plot's right edge, and dropped there.
pub fn event_shapes(
    plot: &PlotRect,
    view: Range64,
    at_ms: &[f64],
    theme: Theme,
) -> Vec<OverlayShape> {
    let mut times: Vec<f64> = at_ms
        .iter()
        .copied()
        .filter(|t| t.is_finite() && *t >= view.lo && *t <= view.hi)
        .collect();
    times.sort_by(f64::total_cmp);
    let right = plot.x + plot.width;
    let c = colour(theme, ColourRole::TextMuted);
    times
        .into_iter()
        .filter_map(|t| {
            let x = js_round(plot.x + (t - view.lo) / (view.hi - view.lo) * plot.width);
            let w = (right - x).min(1.0);
            (w > 0.0).then_some(OverlayShape::Rect {
                css: [x as f32, plot.y as f32, w as f32, plot.height as f32],
                colour: c,
            })
        })
        .collect()
}
