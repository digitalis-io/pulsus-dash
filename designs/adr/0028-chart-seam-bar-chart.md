# ADR-0028: The chart engine seam carries the bar chart (`barchart`, `categories`, `mark`, `pick`, `coverage`); amends 0014 §3

| | |
|---|---|
| **Status** | Accepted (2026-11-26, on merge of #173 Part 2, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3, the `ChartFrame` seam, after [ADR-0019](0019-chart-frame-drawn-event-and-frame-id.md), [ADR-0020](0020-chart-camera-commit-and-value-range.md), [ADR-0022](0022-chart-thresholds-and-stat-sparkline.md), [ADR-0023](0023-chart-event-markers.md) and [ADR-0025](0025-chart-frame-selection.md): one vis kind, one data member, one validation issue, two events and three summary members, with the layout and the drawing every engine shares. The rest of ADR-0014 is unchanged |
| **Source** | Issue #173 Part 2 (T22 I1: the bar chart's engine seam, Canvas 2D bars, the cap and fit, labels, the meter and the gallery) |
| **See** | [T22](../technical/T22-value-categorical-and-table-panels.md) §4.1, §4.2, §4.5, §5.1 (T22-001, T22-004, T22-006, T22-008); [T02](../technical/T02-vis-engine.md) T02-003, T02-005; VIZ-004, VIZ-005, VIZ-027, VIZ-067, VIZ-069 |

## Context

T22 draws the bar chart from reduced categories: the panel reduces, sorts, caps and evaluates
thresholds, and the engine draws the drawn rows in data order (T22 §2). The seam (ADR-0014 §3)
carries time series, heatmaps and scalars only; it has no categorical data, no way to say which bar
the pointer is on or which bar was clicked, and no place for the coverage the meter reads. The cap
also depends on the plot's category extent, which the panel must know before it mounts a frame,
and the WASM engine (#68) must lay the frame out exactly as the panel planned it.

## Decision

1. **The kind and its data.** `VisKind` adds `barchart` (I3 adds `pie`). The spec:

   ```ts
   export interface BarchartSpec {
     kind: 'barchart'; title: string; unit: Unit;
     orientation: 'horizontal' | 'vertical'; valueLabels: boolean;
     names?: 'hidden';                 // set by the panel's fit
     valueRange?: ValueRange;          // absent = auto: [min(0, drawn, thresholds), max(0, …)], nice-rounded
     thresholds?: ThresholdLine[];     // ≤ 8 drawn (ADR-0022)
     ghost: boolean;                   // a dashed bar at each finite baseline
     anomaly: boolean;                 // nothing drawn until Epic #9
   }
   ```

   `FrameData` adds `{ kind: 'categories'; categories: CategoryRow[]; coverage: Coverage }` (the
   drawn rows in draw order, and the panel's coverage, T22 §5.1).
2. **Validation.** For `barchart`, `validateFrameData` returns, in order: `kind` unless the data
   is `categories`; `{ code: 'cap'; count; max: 200 }` over 200 rows; `key` for the first key that
   is not 16 lower-case hex digits or repeats. `emptyFrameData` is no rows with `EMPTY_COVERAGE`.
   The engine never caps: the panel does (T22-006).
3. **One extent and one layout, exact in every engine.** `categoryExtent(spec, cssW, cssH)`:
   horizontal `cssH − space.2 − (T ? EVENT_BAND : 0) − BOTTOM`; vertical
   `cssW − (BAR_VALUE_BAND + space.2 + chart-tick) − space.2 − (T ? GLYPH_COL : 0)`, with T = the
   spec has threshold lines, `BAR_VALUE_BAND` 48, `GLYPH_COL` = `LABEL_HEIGHT + space.1`, and a
   floor of 0. `barLayout(spec, rows, cssW, cssH, measure)` gives the plot, the visible names and
   the value-label rooms (T22 §4.2 as amended by #173 Part 2); the panel's fit and every engine
   call the same layout with the axis font's widths.
4. **Events.** `FrameEvents` adds:

   ```ts
   mark: MarkEvent | null;  // { source, key, index (draw order), xCss, yCss (bar value end, band centre), rows: [one HoverRow] }
   pick: PickEvent;         // { keys: string[]; gesture: 'click' | 'brush' }; keys [] = an empty click
   ```

   `mark` goes out when the band under the pointer changes (the band spans the name band and the
   plot across the category axis) and `null` once when it leaves every band. `pick` goes out for a
   left press with no modifier released within `chart-brush-min` CSS px (the brush is #173
   Part 3). A bar chart ignores the wheel, gestures, double click, context menu and keys, stores
   `setTimeWindow`, and never emits `hover`, `brush`, `commit` or `select`; `FrameInit.keyTarget`
   is null for it.
5. **Summary.** `FrameSummary` adds `coverage?: Coverage` (copied from the data, categories only),
   `namesHidden?: true` and `valuesHidden?: true` (bar chart only). A bar chart reports
   `seriesTotal = coverage.total`, `seriesShown = coverage.drawn`, the min and max of the drawn
   finite values, `last: null`, `valueAxis` `{ domain, manual: valueRange set }`, the plot, the
   threshold glyph boxes (`text` `glyph label`, `clipped: true`) and no event labels. Other kinds
   have none of the three members.
6. **Drawing.** Bars in data order across the category extent, each `max(1, round(0.7 · band))`
   thick and centred, from x(0) to x(v) clamped to the domain; state colour with a state, else the
   row's own series colour (T22-004); no gradient, pattern or shadow (T22-001); no bar for a
   non-finite value. Names never thinned, never clipped or overlapping: fitted in the middle and
   told apart with suffixes, else all hidden. Value labels outside the plot in the rooms the
   layout keeps. Dashed threshold lines across the value axis with their glyphs. The ghost a 1 px
   dashed `text-muted` rectangle of the bar's thickness from 0 to the baseline. The selection per
   ADR-0025 (others at `dimmed`, a focus ring on each selected bar; no selection or a foreign one
   makes exactly the calls of none); intervals and event markers are ignored.
7. **Every engine implements (1)–(6) before it replaces `engine/index.ts`.** Until then a bar
   chart stays on Canvas 2D, also under `engine=wasm`. `anomaly` draws nothing until Epic #9.

## Consequences

- The seam gains one kind, one data member, one issue code, two events and three optional summary
  members; existing kinds draw and report exactly as before, so their gallery goldens and parity
  fixtures are unchanged.
- The Canvas 2D context type gains `rotate` and `translate` (vertical names); `ThemeColours` gains
  `ghost` (`text-muted`; there is no `text-secondary` token).
- The panel's fit (`vis/barchart.ts`) and the engine share `categoryExtent` and `barLayout`, so a
  fit never mounts a frame whose plot is shorter than its minimum.
- The chart gallery gains five bar charts and greyscale goldens; `bench:frame-interim-categories`
  is report only.
- There is no dependency or bundle change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| The engine caps the rows | T22-006 keeps the cap with the panel, which also builds the table and the meter from every row |
| Re-capping after the `a11y` summary reports the plot | The first frame would draw a different set of bars, and a resize would loop through the summary |
| Planning the bar chart in `framePlan` | `framePlan` has no size; the cap and the fit need the cell's |
| Reusing `hover` and `select` for bars | They carry a time (`tMs`) a bar chart does not have, and `select` items are time marks |
