# ADR-0025: The chart engine seam carries the selection (`setSelection`, `select` item); amends 0014 §3

| | |
|---|---|
| **Status** | Accepted (2026-11-25, on merge of #192, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3, the `ChartFrame` seam, after [ADR-0019](0019-chart-frame-drawn-event-and-frame-id.md), [ADR-0020](0020-chart-camera-commit-and-value-range.md), [ADR-0022](0022-chart-thresholds-and-stat-sparkline.md) and [ADR-0023](0023-chart-event-markers.md): one method, one event shape and the drawing rules of the shared selection. The rest of ADR-0014 is unchanged |
| **Source** | Issue #192 (T25 I1: the Inspector host, the shared selection with its highlight, the Esc ladder and pivots) |
| **See** | [T25](../technical/T25-inspector-and-pivots.md) §4.1 (T25-005, T25-006), §4.2, §5; [T02](../technical/T02-vis-engine.md) T02-009, T02-025; VIZ-003, INT-034 |

## Context

T25-006 makes the page's selection shared: a click on a mark, a series-table row or a log line
selects, and every panel draws the selection on its next frame, the source included (T02-025).
The highlight must follow the camera preview, so it is drawn in the engine's layer pass, not by
DOM over the canvas (T02-009). T25-005 makes a click on a mark open the Inspector, so the engine
must say which mark a click hit. The seam (ADR-0014 §3) reserved a `select` event the Canvas 2D
engine never emitted (`{ key, tMs }`), and it had no way in for the selection.

## Decision

1. **One method.** `ChartFrame` adds `setSelection(sel: FrameSelection | null): void`. An equal
   selection (same keys in order, same interval) redraws nothing; `null` is none:

   ```ts
   export interface FrameSelection {
     readonly keys: readonly string[];  // series or stream keys; [] = none
     readonly fromMs: number | null;    // an interval [fromMs, toMs); null = none
     readonly toMs: number | null;
   }
   ```

2. **The `select` event.** It replaces the reserved shape. The engine emits it for a click: a left
   press with no modifier in the plot that travelled less than `chart-brush-min` CSS px
   (Euclidean, the largest distance over every move and the release) and committed no camera move.
   `item` is the mark under it, or null for an empty click:

   ```ts
   export type HoverItem =
     | { kind: 'point'; key: string; tMs: number; value: number }
     | { kind: 'bucket'; index: number; tMs: number; toMs: number; count: number }; // T21 adds 'segment'
   export interface SelectEvent { source: 'pointer' | 'keyboard'; item: HoverItem | null }
   ```

   Line: the hover row at the snapped time whose y is nearest the pointer (ties: earlier draw
   order). Bars: on the drawn buckets (merged to one per CSS px when there are more), the stacked
   segment containing the pointer's y, else the nearest edge (ties: lower stack index). Heatmap: the
   bucket under the pointer (`index` is the bound index; `toMs` the next column start, or the
   column start plus the last step).
3. **Relevance.** A frame dims only when at least one selection key is among its own keys (series
   keys; a stat's first series). Otherwise it draws only the interval.
4. **Drawing, in the layer pass.** Line: unselected series at `opacity.dimmed`, then each selected
   series over a `focus` underlay `chart-line + 4` px wide. Bars: unselected segments at `dimmed`, a
   selected segment with a 2 px `focus` stroke inset 1 px. Line and heatmap with an interval: a
   `selection` band over [x(fromMs), max(x(toMs) − x(fromMs), 1 device px)] across the plot, after
   the marks and before the thresholds. Stat: its key selected → a 2 px `focus` ring inset 1 px. A
   null selection, or empty keys with no interval, makes exactly the calls of a frame without one.
5. **Every engine behind the seam implements (1)–(4).** The WASM engine (#68) maps the highlight
   to its layer pass before it replaces `engine/index.ts`.

## Consequences

- `ChartFrame` gains one method; `FrameEvents.select` changes shape (it was never emitted).
  `FrameSummary` and `FrameInit` are unchanged. The Canvas 2D context type gains `globalAlpha` and
  `strokeRect`.
- New tokens: `color.selection` (accent at 16 %), `opacity.dimmed` (0.35).
- A frame with no selection draws exactly as before, so the parity fixtures and the gallery
  goldens are unchanged.
- There is no dependency or bundle change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A DOM overlay for the highlight | It lags the camera preview and breaks T02-009 (one axis transform) |
| Hit-testing in the component | The component does not know the drawn geometry (merged bars, the value axis); the engine does |
| Picking bars on the raw samples | A click would name a bucket that is not the one drawn under the pointer when buckets merge |
| A note on ADR-0014 §3 | It would change an Accepted ADR, which can change only through a later ADR |
