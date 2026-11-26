//! Hover and click picking on the f64 originals (plan #68 C2b §3.2): test-first stubs.

use std::sync::Arc;

use dash_axes::ValueAxis;
use dash_marks::desc::MarkItem;
use dash_scales::Range64;
use dash_tokens::Theme;
use dash_wire::Chunk;
use serde::Serialize;

/// What a presentation picks on: its chunk, the series it shows, its time view and value axis.
#[derive(Clone, Debug, PartialEq)]
pub struct PickSnap {
    pub chunk: Arc<Chunk>,
    pub shown: u32,
    pub view: Range64,
    pub axis: ValueAxis,
}

/// Where the hover is: nowhere, at a pointer (CSS px) or at a key index.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HoverAt {
    None,
    Pointer { x: f64, y: f64 },
    Key(u32),
}

/// The TS `HoverEvent.source`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Pointer,
    Keyboard,
}

/// The TS `HoverEvent`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverOut {
    pub source: Source,
    pub t_ms: f64,
    pub x_css: f64,
    pub y_css: f64,
    pub rows: Vec<HoverRowOut>,
}

/// The TS `HoverRow` of a line.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HoverRowOut {
    pub key: String,
    pub name: String,
    pub colour_index: u8,
    pub value: f64,
}

/// The TS `HoverItem` of a line.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HoverItem {
    Point {
        key: String,
        #[serde(rename = "tMs")]
        t_ms: f64,
        value: f64,
    },
}

/// Stub.
pub fn nearest_index(_n: usize, _t: impl Fn(usize) -> f64, _t_ms: f64) -> Option<usize> {
    None
}

/// Stub.
pub fn hover_at(_s: &PickSnap, _at: HoverAt) -> Option<HoverOut> {
    None
}

/// Stub.
pub fn pick_item(_s: &PickSnap, _x: f64, _y: f64) -> Option<HoverItem> {
    None
}

/// Stub.
pub fn series_name(_labels: &[(String, String)]) -> String {
    String::new()
}

/// Stub.
pub fn overlay_item(
    _s: &PickSnap,
    _h: Option<&HoverOut>,
    _box_x: Option<(f64, f64)>,
    _theme: Theme,
) -> MarkItem {
    MarkItem::Overlay { shapes: Vec::new() }
}
