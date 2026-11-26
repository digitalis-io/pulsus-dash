//! The shared selection on a line frame (plan #68 C2c2 §3.2; ADR-0025, T25-006): its keys matched
//! against the frame's shown series (relevance) and its interval band. Ports of the Canvas 2D
//! `selection.ts` `matchedKeys` and `drawSelectionBand`.

use dash_axes::PlotRect;
use dash_marks::{Emphasis, OverlayShape};
use dash_scales::Range64;
use dash_tokens::{ColourRole, Theme, colour, opacity};
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
pub fn matched(chunk: &Chunk, shown: usize, sel: &SelectionIn) -> Option<Vec<bool>> {
    if sel.keys.is_empty() {
        return None;
    }
    let flags: Vec<bool> = chunk
        .series
        .iter()
        .take(shown)
        .map(|s| sel.keys.contains(&s.key_hash))
        .collect();
    flags.iter().any(|m| *m).then_some(flags)
}

/// The Line item's emphasis of a match (plan #68 C2c2 §4.2): `opacity.dimmed`, `focus` and the
/// underlay 4 px wider than the line (T25-006).
pub fn emphasis(matched: Vec<bool>, theme: Theme) -> Emphasis {
    Emphasis {
        matched,
        dimmed: opacity::DIMMED,
        focus: colour(theme, ColourRole::Focus),
        underlay_extra_css: 4.0,
    }
}

/// TS `drawSelectionBand`: `[x(from), max(x(to ?? from) − x(from), 1 device px)]` over the
/// plot's height, cut to the plot (at least 1 device px wide), in `selection`; None without an
/// interval (`from_ms` None), with an empty view, or wholly outside the plot. Drawn whatever the
/// keys: relevance applies to dimming only.
pub fn selection_band(
    plot: &PlotRect,
    view: Range64,
    sel: &SelectionIn,
    dpr: f32,
    theme: Theme,
) -> Option<OverlayShape> {
    let from = sel.from_ms?;
    let span = view.hi - view.lo;
    // As TS `!(span > 0)`: NaN spans too.
    let positive = span > 0.0;
    if !positive {
        return None;
    }
    let x = |t: f64| plot.x + (t - view.lo) / span * plot.width;
    let x0 = x(from);
    let x1 = x(sel.to_ms.unwrap_or(from));
    let min = 1.0 / if dpr > 0.0 { f64::from(dpr) } else { 1.0 };
    let right0 = x0 + (x1 - x0).max(min);
    // As TS `!(right0 >= plot.x) || !(x0 <= right)`: a NaN end draws nothing.
    let inside = right0 >= plot.x && x0 <= plot.x + plot.width;
    if !inside {
        return None;
    }
    let left = x0.max(plot.x);
    let right = right0.min(plot.x + plot.width);
    Some(OverlayShape::Rect {
        css: [
            left as f32,
            plot.y as f32,
            (right - left).max(min) as f32,
            plot.height as f32,
        ],
        colour: colour(theme, ColourRole::Selection),
    })
}
