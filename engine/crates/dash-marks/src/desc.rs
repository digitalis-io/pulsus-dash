//! What a frame draws: pure data, no wgpu (plan #68 §3.10).

use std::sync::Arc;

use dash_scales::encode::Encoding;
use dash_tokens::Rgba8;
use dash_wire::Chunk;

/// One viewport's draw list.
#[derive(Clone, Debug)]
pub struct DrawList {
    pub clear: Rgba8,
    /// CSS px.
    pub css: (f64, f64),
    pub dpr: f32,
    /// Reduced from the camera's f64 `DMat4` (column-major).
    pub view_proj: [[f32; 4]; 4],
    /// Slots 0–7 series, 8 `chart-grid`, 9 `chart-axis` (the baseline).
    pub palette: [Rgba8; 10],
    /// Plot rect in CSS px; manual axis only.
    pub clip: Option<[f32; 4]>,
    pub items: Vec<MarkItem>,
}

/// A mark item.
#[derive(Clone, Debug)]
pub enum MarkItem {
    /// One hairline per value tick.
    Guides {
        /// y CSS px, rounded.
        lines: Vec<f32>,
        /// x, y, w, h CSS px.
        plot: [f32; 4],
        /// The plot's bottom baseline, y CSS px: `round(plot.y + plot.h) − 1` (#282 Part 2b).
        baseline: f32,
    },
    /// A line over the series `series` of `chunk`.
    Line {
        chunk: Arc<Chunk>,
        series: std::ops::Range<u32>,
        /// The time window [from, to] in ms (unrounded f64); the renderer derives and caches
        /// the column ranges from it (A.15.1).
        window: (f64, f64),
        /// Columns (whole CSS px of the plot).
        n: u32,
        plot: [f32; 4],
        encoding: Encoding,
        /// (ku, ou) reduced to f32.
        axis: (f32, f32),
        colour_slots: Vec<u8>,
        /// None = lane 0 for all (2D).
        lanes: Option<Vec<u16>>,
        width_css: f32,
        /// The selection's emphasis (plan #68 C2c2 §3.3): None = no series matched, one pass.
        emphasis: Option<Emphasis>,
        /// A.3.3: CPU decimation with f64 segment clipping, on T1 and T2.
        far: bool,
        /// The gradient area under the line's joins (ADR-0036); None = no area.
        area: Option<Area>,
    },
    /// The overlay (plan #68 C2b §3.2): crosshair, hover dots and box band, drawn last, unclipped,
    /// in CSS px.
    Overlay { shapes: Vec<OverlayShape> },
}

/// How a Line item highlights the matched series (plan #68 C2c2 §3.2; ADR-0025, ADR-0032).
#[derive(Clone, Debug, PartialEq)]
pub struct Emphasis {
    /// Per series of the item: matched by the selection.
    pub matched: Vec<bool>,
    /// The opacity the unmatched series' layer is composited at (`opacity.dimmed`).
    pub dimmed: f32,
    /// The underlay colour (`focus`).
    pub focus: Rgba8,
    /// The underlay is this much wider than the line, CSS px.
    pub underlay_extra_css: f32,
}

/// A Line item's area (ADR-0036): a vertical gradient under each join, `alpha_top` at the plot's
/// top edge to 0 at its bottom, drawn before any stroke of the layer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    /// `opacity.chart-area` ÷ the series shown (1–4).
    pub alpha_top: f32,
}

/// One overlay shape, CSS px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OverlayShape {
    /// x, y, w, h.
    Rect { css: [f32; 4], colour: Rgba8 },
    Disc {
        centre: [f32; 2],
        r_css: f32,
        colour: Rgba8,
    },
}

/// ADR-0019's `drawn` event.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrawnEvent {
    pub css_width: f64,
    pub css_height: f64,
    pub dpr: f64,
}
