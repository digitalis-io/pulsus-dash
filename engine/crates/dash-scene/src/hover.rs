//! Hover and click picking on the f64 originals of a presentation (plan #68 C2b §3.2; ADR-0025,
//! ADR-0030 decision 2): Rust ports of the Canvas 2D line rules, so both engines answer alike
//! (`unit:hover-parity` checks them against `engine/fixtures/hover.json`):
//!
//! | Rust | TS |
//! |---|---|
//! | [`nearest_index`] | `canvas2d/pick.ts` `nearestIndex`: binary search, ties to the lower index |
//! | [`hover_at`] | `canvas2d/pick.ts` `hoverAt` with `hoverRows` (line): the rows of every shown series whose nearest sample is within half its own mean step, NaN omitted |
//! | [`pick_item`] | `canvas2d/select.ts` `pickItem` → `pickLine`: the row nearest the pointer's y, ties to the earlier |
//! | [`series_name`] | `data/frames.ts` `seriesName`: `__name__` first, the other keys sorted by UTF-16 code unit |
//! | [`overlay_item`] | `canvas2d/draw.ts` `drawOverlay`: crosshair, dots inside the plot, box band |
//!
//! The arithmetic is the TS's, operation for operation, so every f64 is bit-equal.

use std::sync::Arc;

use dash_axes::ValueAxis;
use dash_marks::desc::{MarkItem, OverlayShape};
use dash_scales::Range64;
use dash_tokens::{ColourRole, Theme, colour, series_palette};
use dash_wire::Chunk;
use serde::Serialize;

use crate::camera::js_round;

/// What a presentation picks on: its chunk, the series it shows (a prefix), its time view and its
/// value axis (`axis.plot` is the plot).
#[derive(Clone, Debug, PartialEq)]
pub struct PickSnap {
    pub chunk: Arc<Chunk>,
    pub shown: u32,
    pub view: Range64,
    pub axis: ValueAxis,
}

/// Where the hover is: nowhere, at a pointer (CSS px) or at a key index (the keyboard crosshair).
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
    /// The series key, 16 lower-case hex digits.
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

/// The index of the time nearest `t_ms` among `n` increasing times `t(0..n)` (binary search; ties
/// to the lower index); None when `n` is 0.
pub fn nearest_index(n: usize, t: impl Fn(usize) -> f64, t_ms: f64) -> Option<usize> {
    if n == 0 {
        return None;
    }
    let (mut lo, mut hi) = (0, n - 1);
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if t(mid) < t_ms {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    // lo is the first index with t ≥ t_ms (or n − 1).
    if lo > 0 && t_ms - t(lo - 1) <= t(lo) - t_ms {
        return Some(lo - 1);
    }
    Some(lo)
}

/// Samples of series `s`.
fn len(c: &Chunk, s: usize) -> usize {
    (c.offsets[s + 1] - c.offsets[s]) as usize
}

impl PickSnap {
    /// The reference times: series 0's (none when nothing is shown).
    fn ref_len(&self) -> usize {
        if self.shown == 0 {
            0
        } else {
            len(&self.chunk, 0)
        }
    }

    fn ref_at(&self, i: usize) -> f64 {
        if i < self.ref_len() {
            self.chunk.t_ms(0, i)
        } else {
            f64::NAN
        }
    }

    /// TS `hoverRows` (line) at reference index `i`: (tMs, rows).
    fn rows_at(&self, i: usize) -> (f64, Vec<HoverRowOut>) {
        let t_ms = self.ref_at(i);
        let c = &*self.chunk;
        let mut rows = Vec::new();
        for s in 0..(self.shown as usize).min(c.series.len()) {
            let n = len(c, s);
            let t = |k: usize| c.t_ms(s, k);
            let Some(j) = nearest_index(n, t, t_ms) else {
                continue;
            };
            // Half the mean sample step of the series; ∞ for one sample.
            let half = if n > 1 {
                (t(n - 1) - t(0)) / (n - 1) as f64 / 2.0
            } else {
                f64::INFINITY
            };
            if (t(j) - t_ms).abs() > half {
                continue;
            }
            let value = c.series_values(s)[j];
            if !value.is_finite() {
                continue;
            }
            let meta = &c.series[s];
            rows.push(HoverRowOut {
                key: format!("{:016x}", meta.key_hash),
                name: series_name(&meta.labels),
                colour_index: dash_colour::series_colour_index(meta.key_hash, &meta.labels),
                value,
            });
        }
        (t_ms, rows)
    }

    /// The time at CSS x.
    fn t_at(&self, x: f64) -> f64 {
        let (plot, v) = (&self.axis.plot, self.view);
        v.lo + ((x - plot.x) / plot.width) * (v.hi - v.lo)
    }

    /// The CSS x of time `t`.
    fn x_of(&self, t: f64) -> f64 {
        let (plot, v) = (&self.axis.plot, self.view);
        plot.x + ((t - v.lo) / (v.hi - v.lo)) * plot.width
    }
}

/// The keyboard crosshair of `at` validated against `s` (code review r1): the main thread sends
/// key indices from the stage it has, which can be an older presentation's (a `setData` that
/// shortened series 0 before its stage arrived). An index past the last sample becomes the last
/// sample, so End still means "last"; with no sample there is no hover. Pointer and none pass
/// through. [`hover_at`] stays the TS rule; the worker calls it with this.
pub fn key_on(s: &PickSnap, at: HoverAt) -> HoverAt {
    match at {
        HoverAt::Key(i) => match s.ref_len() {
            0 => HoverAt::None,
            n => HoverAt::Key(i.min(u32::try_from(n - 1).unwrap_or(u32::MAX))),
        },
        other => other,
    }
}

/// The hover at `at` (TS `hoverAt`, line): the keyboard crosshair at a reference index (y = the
/// plot's top), or the pointer's nearest reference sample; None for no hover or no sample.
pub fn hover_at(s: &PickSnap, at: HoverAt) -> Option<HoverOut> {
    let plot = &s.axis.plot;
    match at {
        HoverAt::None => None,
        HoverAt::Key(i) => {
            let (t_ms, rows) = s.rows_at(i as usize);
            Some(HoverOut {
                source: Source::Keyboard,
                t_ms,
                x_css: s.x_of(t_ms),
                y_css: plot.y,
                rows,
            })
        }
        HoverAt::Pointer { x, y } => {
            let i = nearest_index(s.ref_len(), |k| s.ref_at(k), s.t_at(x))?;
            let (t_ms, rows) = s.rows_at(i);
            Some(HoverOut {
                source: Source::Pointer,
                t_ms,
                x_css: s.x_of(t_ms),
                y_css: y,
                rows,
            })
        }
    }
}

/// The point under a click at (x, y) (TS `pickItem` → `pickLine`): of the hover rows at the
/// nearest reference sample, the one whose y is nearest; None for no row.
pub fn pick_item(s: &PickSnap, x: f64, y: f64) -> Option<HoverItem> {
    let plot = &s.axis.plot;
    if !(plot.width > 0.0 && s.view.hi > s.view.lo) {
        return None;
    }
    let i = nearest_index(s.ref_len(), |k| s.ref_at(k), s.t_at(x))?;
    let (t_ms, rows) = s.rows_at(i);
    let mut best: Option<(&HoverRowOut, f64)> = None;
    for r in &rows {
        let d = (s.axis.y(r.value) - y).abs();
        // Rows are in draw order: a tie keeps the earlier one.
        if best.is_none_or(|(_, b)| d < b) {
            best = Some((r, d));
        }
    }
    best.map(|(r, _)| HoverItem::Point {
        key: r.key.clone(),
        t_ms,
        value: r.value,
    })
}

/// `"v"` with `\`, `"` and newlines escaped (TS `quoted`).
fn quoted(v: &str) -> String {
    let v = v
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    format!("\"{v}\"")
}

/// `name{k="v", …}`: `__name__` first (empty when absent), the other keys sorted by UTF-16 code
/// unit as JS sorts strings (TS `seriesName`).
pub fn series_name(labels: &[(String, String)]) -> String {
    let name = labels
        .iter()
        .find(|(k, _)| k == "__name__")
        .map_or("", |(_, v)| v.as_str());
    let mut pairs: Vec<&(String, String)> =
        labels.iter().filter(|(k, _)| k != "__name__").collect();
    pairs.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let body: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", quoted(v)))
        .collect();
    format!("{name}{{{}}}", body.join(", "))
}

/// The overlay of a presentation (TS `drawOverlay`, in its order, unclipped): with a hover, the
/// 1 px crosshair at `round(x)` (`text-muted`) and a dot of radius 2 × `chart-line` per row whose y
/// is inside the plot (its series colour); with a box band, the band (`brush`).
pub fn overlay_item(
    s: &PickSnap,
    h: Option<&HoverOut>,
    box_x: Option<(f64, f64)>,
    theme: Theme,
) -> MarkItem {
    let plot = &s.axis.plot;
    let mut shapes = Vec::new();
    if let Some(h) = h {
        shapes.push(OverlayShape::Rect {
            css: [
                js_round(h.x_css) as f32,
                plot.y as f32,
                1.0,
                plot.height as f32,
            ],
            colour: colour(theme, ColourRole::TextMuted),
        });
        let palette = series_palette(theme);
        for r in &h.rows {
            let y = s.axis.y(r.value);
            // A manual value axis can leave a value outside the plot: no dot there.
            if !(y >= plot.y && y <= plot.y + plot.height) {
                continue;
            }
            shapes.push(OverlayShape::Disc {
                centre: [h.x_css as f32, y as f32],
                r_css: 2.0 * dash_tokens::size::CHART_LINE,
                colour: palette[usize::from(r.colour_index) % palette.len()],
            });
        }
    }
    if let Some((x0, x)) = box_x {
        shapes.push(OverlayShape::Rect {
            css: [
                x0.min(x) as f32,
                plot.y as f32,
                (x - x0).abs() as f32,
                plot.height as f32,
            ],
            colour: colour(theme, ColourRole::Brush),
        });
    }
    MarkItem::Overlay { shapes }
}
