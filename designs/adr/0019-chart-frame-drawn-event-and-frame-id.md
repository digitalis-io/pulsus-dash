# ADR-0019: The chart engine seam reports completed draws and carries a frame identity

| | |
|---|---|
| **Status** | Accepted (2026-11-21, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3, the `ChartFrame` seam: two additive members. The rest of ADR-0014 is unchanged |
| **Source** | Issue #90 (plan review r5) |
| **See** | [T02](../technical/T02-vis-engine.md) §0, [T03](../technical/T03-browser-runtime.md) §4.2, [T08](../technical/T08-dom-component-kit.md) §4.4 |

## Context

The panel editor's live preview (#90) must show a cached result in the first painted frame after a
change, and must never show a blank canvas. A resize clears a canvas, and a new canvas is blank
until the engine draws it in a later animation frame. `ChartFrame` cannot tell when the canvas
holds a complete image, so it cannot keep its caller's progress state over the frame for exactly
as long as the canvas is blank. Tests and traces also cannot attribute the engine's `chart-draw`
measures to one frame: the preview and the board panel behind it draw the same chart.

## Decision

1. **`drawn` event.** `FrameEvents` adds `drawn: DrawnEvent`. The engine emits it after each
   completed draw of the visible canvas at a non-empty size, hover redraws included. It never emits
   it at a zero size or after `dispose`.
2. **Frame identity.** `FrameInit` adds `readonly id?: string`. It is a diagnostic identity: it tags
   the engine's `chart-draw` measures (`detail.frame`, `null` without an id) and carries no
   behaviour.
3. **Every engine behind the seam implements both.** The later `WasmEngine` adapter (#68) emits
   `drawn` from a callback of its own when the worker reports the frame presented, never
   synchronously from `resize`.

The seam additions, verbatim:

```ts
export interface FrameInit {
  readonly timeZone: string;                // unchanged
  readonly keyTarget: HTMLElement | null;   // unchanged
  /** Diagnostic identity of the frame: tags its `chart-draw` measures (#90). */
  readonly id?: string;
}
/** The visible canvas was drawn completely at this size (#90). */
export interface DrawnEvent { readonly cssWidth: number; readonly cssHeight: number; readonly dpr: number }
export interface FrameEvents {
  hover: HoverEvent | null; brush: BrushEvent; select: SelectEvent; a11y: FrameSummary; // unchanged
  drawn: DrawnEvent;                        // new
}
```

## Consequences

- `ChartFrame` keeps its caller's progress state (`pending`) over the canvas until `drawn` reports
  a draw at the current size. Every resize, a new engine frame and a kind change show it again.
- The event list becomes `hover`, `brush`, `select`, `a11y`, `drawn`.
- `chart-draw` measures carry `detail.frame`, so a test or a trace can tell one frame's draws from
  another's.
- There is no new dependency and no bundle-budget change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A note on ADR-0014 §3 | It would change an Accepted ADR, which can change only through a later ADR |
