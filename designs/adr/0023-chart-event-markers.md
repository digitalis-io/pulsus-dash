# ADR-0023: The chart engine seam carries event markers (`setEvents`, `eventLabels`); amends 0014 §3

| | |
|---|---|
| **Status** | Accepted (2026-11-23, on merge of #64 Part C, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3, the `ChartFrame` seam, after [ADR-0019](0019-chart-frame-drawn-event-and-frame-id.md), [ADR-0020](0020-chart-camera-commit-and-value-range.md) and [ADR-0022](0022-chart-thresholds-and-stat-sparkline.md): one method, one summary member and the drawing rules of the event mark. The rest of ADR-0014 is unchanged |
| **Source** | Issue #64 Part C (INT-031 at M-UI1: deploy or event markers as vertical lines with a label above the plot area) |
| **See** | [T02](../technical/T02-vis-engine.md) §4.5, T02-004, T02-008, T02-009, T02-019; [T04](../technical/T04-wire-format-and-data-plane.md) §0 (`events/1`); [T11](../technical/T11-postgres-schema.md) §4.4 (`annotations`); INT-031, VIZ-011, VIZ-022 |

## Context

INT-031 asks for events (deploys, config changes, feature flags, notes) as vertical markers on every
time chart. T02-009 binds an overlay to the axis transform it belongs to, so a marker must move with
the time axis, camera preview included; markers drawn in the DOM over the canvas would lag the
preview. Events are not part of a panel's data or of its spec: one board reads them once for every
panel, and they change on their own schedule (CI posts deploys). The seam (ADR-0014 §3) has no
member for them.

## Decision

1. **One method.** `ChartFrame` adds `setEvents(events: readonly EventMarker[]): void`. It replaces
   the frame's events; `[]` means none. Events are not in `VisSpec` or `FrameData`:

   ```ts
   export type EventKind = 'deploy' | 'config' | 'flag' | 'annotation';
   export interface EventMarker {
     readonly id: string;
     readonly atMs: number; // non-finite → not drawn
     readonly endMs: number | null; // tooltip only
     readonly kind: EventKind;
     readonly title: string; // plain text (T02-019)
   }
   ```

2. **The label band.** On line, bars and heatmap, a frame whose last `setEvents` held at least one
   event, in view or not, reserves a band of one label line above the plot (the plot is shorter by
   it), so a pan never moves the plot. With `[]` the layout is unchanged. Stat ignores events.
3. **Layering.** Each event in view (finite `atMs` in the drawn window) is a solid 1 CSS px line in
   `text-muted` across the plot, at `Math.round(x) + 0.5` of the frame's time transform (the
   preview's during a gesture). The order is: axes, series (paths, bars, cells), thresholds, event
   lines, value-label chips, event labels, then the overlay. Filled marks never hide a line. The
   lines are clipped to the plot when the value axis is pinned.
4. **Labels are never dropped.** A label is `${glyph} ${title}` with the kind's glyph
   (◆ deploy, ⚙ config, ⚑ flag; a note has none, T02-008). Events less than `target-min` apart
   form a group. Groups are placed left to right in the band: at the group's line, else
   right-aligned against the next group, truncated with an ellipsis, or shortened to the glyph; a
   group of two or more is a `+N` chip (`99+` past 99). A group that cannot fit merges into the
   previous one; with no previous one every group becomes one chip, and if even that does not fit,
   one box spans the band without text. No box leaves the band or overlaps another, and every event
   in view is in exactly one box. The engine reports the boxes:

   ```ts
   export interface EventLabelBox {
     readonly box: PlotRect;
     readonly x: number; // CSS px of the first member's line
     readonly ids: readonly string[]; // members, (atMs, id) order
     readonly text: string; // full label(s), joined by '; '
     readonly clipped: boolean; // truncated, or a `+N` chip
   }
   // FrameSummary: readonly eventLabels: readonly EventLabelBox[]; // x order; [] for stat
   ```

5. **Colour and text.** The mark uses `text-muted` only, never a state colour (T02-004), and draws
   text with `fillText` only (T02-019). The DOM gives every box a focusable target of at least the
   minimum target size, whose tooltip and accessible name list its events (T08-010).
6. **Every engine behind the seam implements (1)–(5).** The WASM engine (#68) maps them to M1
   verticals and M9 glyphs ([T02](../technical/T02-vis-engine.md) §4.5 Overlays) before it replaces
   `engine/index.ts`.

## Consequences

- `ChartFrame` gains one method; `FrameEvents` and `FrameInit` are unchanged. `FrameSummary` gains
  `eventLabels`, which is not part of the Rust parity fixtures (the fixture generator projects each
  summary to the parity fields).
- A frame without events draws exactly as before, so the parity fixtures and the existing gallery
  goldens are unchanged. The gallery gains an eleventh entry, `line-events`.
- Click-to-compare (INT-031's second clause) is deferred to INT-030: a click on a marker does
  nothing yet.
- There is no dependency or bundle change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Events in `VisSpec` or `FrameData` | Events are the board's, read once per window for every panel; in the spec they would be saved with it, in the data they would be fetched per panel |
| DOM markers over the canvas | They lag the camera preview and break T02-009 (one axis transform) |
| Dropping labels that collide | An event would be on the chart without a name; every event in view stays reachable by keyboard |
| A note on ADR-0014 §3 | It would change an Accepted ADR, which can change only through a later ADR |
