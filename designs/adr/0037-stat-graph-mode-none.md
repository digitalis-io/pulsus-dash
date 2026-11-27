# ADR-0037: A stat's graph mode `none` draws the value alone; amends 0022 decision 4

| | |
|---|---|
| **Status** | Accepted (on merge of the #297 fix, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0022](0022-chart-thresholds-and-stat-sparkline.md) decision 4 (the stat sparkline): one optional spec member that turns the sparkline off. The rest of ADR-0022 is unchanged |
| **Source** | Issue #297 (a stat with graph mode none still drew a sparkline) |
| **See** | [T22](../technical/T22-value-categorical-and-table-panels.md) §5.1 (the stat `VisSpec`), §6 (`graphMode` option); [T05](../technical/T05-testing-and-performance.md) §7.1 (`e2e:board-stat-graph-none`) |

## Context

ADR-0022 decision 4 draws a sparkline under every stat with series data in a frame at least 104 CSS
px tall, and leaves the spec unchanged; it rejected a sparkline flag because series data already
decided. T22 later added the board option `graphMode` (`sparkline` | `none`, default `sparkline`)
for stat panels, imported from other dashboards, and listed `graphMode` on the stat `VisSpec`
(§5.1). The board validated and stored the option, but no renderer honoured it (#297), because
ADR-0022 still required the sparkline.

## Decision

1. The stat `VisSpec` gains one optional member:

   ```ts
   | { readonly kind: 'stat'; readonly title: string; readonly unit: Unit;
       /** Absent = 'sparkline' (ADR-0022 decision 4). */
       readonly graphMode?: 'sparkline' | 'none' }
   ```

2. **Renderer contract.** With `graphMode: 'none'` a stat draws its formatted value alone, centred
   in the frame (as a scalar stat does), and no sparkline, whatever its data and height. With
   `graphMode` absent or `'sparkline'`, ADR-0022 decision 4 applies unchanged. The summary
   (`FrameSummary`) does not depend on the mode.
3. A board stat panel sets `graphMode: 'none'` from `options.graphMode: "none"`; absent and
   `sparkline` leave the member absent, so existing specs, fixtures and goldens are unchanged.
4. Every engine behind the seam implements (2). Stats are drawn by Canvas 2D in every engine mode
   (the routing engine sends every non-line kind to Canvas 2D); the WASM engine implements (2) when
   it draws stats (#69).

## Consequences

- There is no new method or event; `ChartFrame`, `FrameEvents` and `FrameInit` are unchanged.
- The other stat modes of T22 §5.1 (`colourMode`, `textMode`, `orientation`, `valueRange`) stay
  with #174.
- No dependency or bundle change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep ADR-0022 and drop the option | Imported dashboards set graph mode none; the option is in the board spec (T22 §6) |
| Hide the sparkline in the DOM over the canvas | The value would stay off-centre, and the canvas is the renderer's (ADR-0014 §3) |
