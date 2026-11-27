# ADR-0022: The chart engine seam carries threshold lines and draws a stat sparkline; amends 0014 §3

| | |
|---|---|
| **Status** | Accepted (2026-11-22, on merge of #64 Part B, under the owner's standing authorisation for pipeline design changes) |
| **Amended by** | [ADR-0037](0037-stat-graph-mode-none.md) (decision 4: `graphMode: 'none'` draws the value alone) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3, the `ChartFrame` seam, after [ADR-0019](0019-chart-frame-drawn-event-and-frame-id.md) and [ADR-0020](0020-chart-camera-commit-and-value-range.md): two additive members and one drawing rule. The rest of ADR-0014 is unchanged |
| **Source** | Issue #64, the owner's scope addition of 2026-11-19 (threshold lines with their labels; stat tiles with a sparkline) |
| **See** | [T02](../technical/T02-vis-engine.md) §4.5, T02-003, T02-004, T02-009; Table 5-1 (Stat); VIZ-011, VIZ-057, VIZ-067 |

## Context

The owner's scope addition on #64 asks for dashed threshold lines with their labels (for example an
SLO) on time series, and for stat tiles with a state chip and a sparkline. T02-009 binds a
threshold to the axis transform it belongs to, so it must move with the value axis, camera preview
included. Table 5-1 describes Stat as a value with a sparkline. The seam's `VisSpec` (ADR-0014 §3)
has no member for either, and T02-004 allows state colours in marks only through `StateEncoding`.

## Decision

1. **Threshold lines in the spec.** `VisSpec` line and bars add `readonly thresholds?: readonly
   ThresholdLine[]` (absent means none). At most 8 are drawn, in spec order, as dashed lines in the
   state's colour on the default value axis:

   ```ts
   export type ThresholdState = 'watch' | 'degraded' | 'failing';
   /** A horizontal threshold on the value axis (T02-009: the default axis). */
   export interface ThresholdLine {
     /** Data units; a non-finite value is not drawn. */
     readonly value: number;
     readonly state: ThresholdState;
     /** Display text, drawn after the state glyph; plain text, never markup. */
     readonly label: string;
   }
   ```

2. **Labels are never dropped.** A threshold's label is drawn after its state glyph. Colliding
   labels stack, a long label is truncated with an ellipsis, and labels that cannot fit are gathered
   into one `+N` chip. A label whose line is off the pinned axis sits at the plot edge. The engine
   reports every label box in `FrameSummary.thresholdLabels` (line and bars; `[]` otherwise):

   ```ts
   /** A threshold label as laid out, CSS px relative to the canvas. */
   export interface ThresholdLabelBox {
     readonly box: PlotRect;
     /** The full text: `${glyph} ${label}`, or for an overflow chip every hidden label, joined by '; '. */
     readonly text: string;
     /** Truncated with an ellipsis, or an overflow chip (`+N`): the DOM shows `text` on hover/focus. */
     readonly clipped: boolean;
   }
   ```

3. **The auto domain includes thresholds.** The auto value domain is widened to every finite
   threshold (for bars, the stacked totals after the bucket merge, widened). A manual `valueRange`
   (ADR-0020) wins.
4. **Stat sparkline.** A stat with series data draws a sparkline of its first series under the
   value, from a frame 104 CSS px tall. The sparkline is a trend glyph: it joins the series'
   finite points in the window across absent and non-finite ones (on the step grid a sparse series
   is mostly absent points, T04-005), and a single finite point is a dot. The spec is unchanged.
5. **State colours and glyphs only from `StateEncoding`** (T02-004): the marks take a state's
   colour from `StateEncoding[s].colour` and its glyph from `StateEncoding[s].glyph`.
6. **Every engine behind the seam implements (1)–(4).** The WASM engine (#68) implements them before
   it replaces `engine/index.ts`.

## Consequences

- There is no new method or event: `FrameEvents`, `ChartFrame` and `FrameInit` are unchanged.
- `thresholdLabels` is not part of the Rust parity fixtures. The fixture generator projects each
  summary to the existing fields and selects the parity entries by an explicit list.
- The gallery gains two entries, `line-thresholds` and `stat-sparkline`.
- There is no dependency or bundle change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| DOM threshold lines over the canvas | They lag the camera preview and break T02-009 (one axis transform) |
| Dropping labels that collide | A threshold would lose its label; the owner asked for the label (and T08 for every state to be named) |
| A stat `sparkline` flag | Series data already decides; a flag adds a state with no use |
| A note on ADR-0014 §3 | It would change an Accepted ADR, which can change only through a later ADR |
