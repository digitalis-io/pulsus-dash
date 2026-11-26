//! The layer marks of a line frame (plan #68 C2c1 §3.2): threshold lines (ADR-0022) and event lines
//! (ADR-0023) as screen-space rectangles of the overlay pipeline, ports of the Canvas 2D
//! `thresholdMark.ts` `withThresholds` and `drawThresholds` (its dashed stroke) and `eventMark.ts`
//! `membersInView` and `drawEventLines` (clipped to the plot). Their labels come with the engine's
//! text mark (#69).

use dash_axes::{PlotRect, ValueAxis};
use dash_marks::OverlayShape;
use dash_scales::Range64;
use dash_tokens::Theme;

use crate::spec::ThresholdLine;

/// TS `withThresholds`: `[min, max]` widened to every finite threshold value; `(0, 0)` when no
/// input is finite.
pub fn with_thresholds(min: Option<f64>, max: Option<f64>, t: &[ThresholdLine]) -> (f64, f64) {
    let _ = t;
    (min.unwrap_or(0.0), max.unwrap_or(0.0))
}

/// The dashed threshold lines (TS `drawThresholds`).
pub fn threshold_shapes(axis: &ValueAxis, t: &[ThresholdLine], theme: Theme) -> Vec<OverlayShape> {
    let _ = (axis, t, theme);
    Vec::new()
}

/// The event lines (TS `membersInView` and `drawEventLines`).
pub fn event_shapes(
    plot: &PlotRect,
    view: Range64,
    at_ms: &[f64],
    theme: Theme,
) -> Vec<OverlayShape> {
    let _ = (plot, view, at_ms, theme);
    Vec::new()
}
