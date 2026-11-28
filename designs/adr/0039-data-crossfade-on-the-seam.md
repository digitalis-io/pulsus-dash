# ADR-0039: The series `FrameData` carries `transition: 'crossfade'`; both engines fade the line over 150 ms

| | |
|---|---|
| **Status** | Accepted (on merge of #304, owner's delegate, 2026-11-27) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3 (the seam's series data gains an optional member) |
| **Source** | Issue #304 Part B (zoom paints at once from held data, then refines) |
| **See** | [T02](../technical/T02-vis-engine.md) T02-007 (data crossfade); [T04](../technical/T04-wire-format-and-data-plane.md) §4.4 v1 note (ranks); [08](../product/08-visual-language.md) VL-015, VL-016 |

## Context

A zoom paints its first frame from data held at other steps (rank 0) and replaces it with the
view's own step when it lands (PRF-027). Cutting from one to the other jumps; T02-007 asks for a
crossfade on data replacement. The seam had no way to say that a `setData` replaces a fill.

## Decision

1. The series `FrameData` gains `transition?: 'crossfade'`: a line frame fades from the series it
   drew before to the new ones over 150 ms; ignored with nothing drawn yet and by other kinds.
2. `ChartFrame` strips `transition` under `prefers-reduced-motion: reduce` (VL-016): an instant cut.
3. **Canvas 2D** keeps the drawn layer as a bitmap and composites it at `1 − t` over the new layer,
   clipped to the plot, each frame for 150 ms; a new `setData`, a window change or a resize ends it.
4. **GPU/WASM** (`frame_crossfade(id, on)` before every `data` and `data-chunk`): the frame's
   previous chunk is drawn under the new one, each through the dim layer at its share of the fade
   (`1 − t` and `t`, every series unmatched); the frame keeps presenting until `t = 1`; a camera
   change or a new `data` without the flag drops the fade. Axes, thresholds, events and the hover
   are the new data's from the first frame.
5. A panel sets `transition` only on the rank 1 answer of a view that started over a rank 0 fill;
   pans and new keys cut.

## Consequences

- A fade never delays input: the camera applies to the new data at once (PRF-003).
- The wasm `data` / `data-chunk` messages carry `crossfade: true` only when set, so existing
  messages are unchanged.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A DOM cross-dissolve of two canvases | Doubles the frame's canvases and breaks the shared engine canvas model |
| Resampling the fill onto the new grid and tweening values | Fabricates samples (T04-005) |
