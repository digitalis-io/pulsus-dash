//! The shared selection on a line frame (plan #68 C2c2 §3.2; ADR-0025, T25-006): its keys matched
//! against the frame's shown series (relevance) and its interval band. Ports of the Canvas 2D
//! `selection.ts` `matchedKeys` and `drawSelectionBand`.

use dash_axes::PlotRect;
use dash_marks::OverlayShape;
use dash_scales::Range64;
use dash_tokens::Theme;
use dash_wire::Chunk;

/// The page selection as the worker holds it (`FrameSelection`): only keys that are exactly 16
/// lower-case hex digits are kept (any other string matches no series key, as the TS string
/// compare); `from_ms`/`to_ms` the interval (None = none).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SelectionIn {
    pub keys: Vec<u64>,
    pub from_ms: Option<f64>,
    pub to_ms: Option<f64>,
}

impl SelectionIn {
    /// From the TS selection: each key kept as its `u64` only when it is exactly 16 lower-case hex
    /// digits (C1's `key_hash` rule), so `00000000000000A1` matches nothing, as in TS.
    pub fn new<'a>(
        keys: impl IntoIterator<Item = &'a str>,
        from_ms: Option<f64>,
        to_ms: Option<f64>,
    ) -> Self {
        let keys = keys
            .into_iter()
            .filter(|k| {
                k.len() == 16
                    && k.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .filter_map(|k| u64::from_str_radix(k, 16).ok())
            .collect();
        Self {
            keys,
            from_ms,
            to_ms,
        }
    }
}

/// TS `matchedKeys` over the shown series: one flag per shown series, None when no key is among
/// them (the frame then dims nothing).
pub fn matched(_chunk: &Chunk, _shown: usize, _sel: &SelectionIn) -> Option<Vec<bool>> {
    None
}

/// TS `drawSelectionBand`: None without an interval or wholly outside the plot.
pub fn selection_band(
    _plot: &PlotRect,
    _view: Range64,
    _sel: &SelectionIn,
    _dpr: f32,
    _theme: Theme,
) -> Option<OverlayShape> {
    None
}
