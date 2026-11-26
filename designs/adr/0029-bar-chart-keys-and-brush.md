# ADR-0029: The bar chart takes keys and brushes (`keyTarget` mirror, `PickEvent.source`, focus mark, brush band); amends 0028 §4

| | |
|---|---|
| **Status** | Accepted (2026-11-26, on merge of #173 Part 3a, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0028](0028-chart-seam-bar-chart.md) §4 (the bar chart's events and `keyTarget`), within the [ADR-0014](0014-typescript-react-web-client.md) §3 seam. The rest of ADR-0028 is unchanged |
| **Source** | Issue #173 Part 3a (T22 I1: the bar chart's interactions at unit and component level) |
| **See** | [T22](../technical/T22-value-categorical-and-table-panels.md) T22-008, T22-010, T22-011, §4.3, §5.1; [T25](../technical/T25-inspector-and-pivots.md) T25-005, T25-007; [T08](../technical/T08-dom-component-kit.md) T08-016; VIZ-003 |

## Context

ADR-0028 gave the bar chart `mark` and `pick` for the pointer only: `keyTarget` is null, the
engine ignores keys, and a drag emits nothing ("the brush is #173 Part 3"). T22-010 requires the
arrows, Home/End, Enter, Shift+arrow and Esc on the bars; T22-008 and §4.3 require a brush over the
bars that writes the covered keys; and T08-016 requires a visible focus. The focus index, the
brush anchor and the brushed bands depend on the drawn layout, which only the engine knows, and
the surfaces need to tell a keyboard pick (focus returns, no pointer position) from a pointer one.

## Decision

1. **The key target.** For a bar chart, `FrameInit.keyTarget` is the chart's mirror listbox: a
   visually hidden `role="listbox"` with one option per drawn bar in draw order, one tab stop,
   rendered by the component before the frame is created. Line, bars and heatmap keep the
   crosshair slider; stat keeps null. The component sets the listbox's `aria-activedescendant` to
   the option of a keyboard `mark` and selects the options whose keys are in the page selection.
   The listbox is marked `data-escape-ladder`, so Escape on it reaches the T25 ladder (T25-007).
2. **`PickEvent.source`.**

   ```ts
   export interface PickEvent { keys: string[]; gesture: 'click' | 'brush'; source: 'pointer' | 'keyboard' }
   ```

3. **Keys** on `keyTarget` (n = drawn rows, f = the focus index, a = the brush anchor):

   | Input | Effect | Emits |
   |---|---|---|
   | `focus` | f = min(f ?? 0, n − 1) | `mark` {source `keyboard`, f} |
   | ArrowRight / ArrowDown, ArrowLeft / ArrowUp | f ± 1, clamped to [0, n − 1]; a = null | `mark` |
   | Home / End | f = 0 / n − 1; a = null | `mark` |
   | Shift + any of the above | a ??= f, then f moves | `mark`, then `pick` {rows a…f in draw order, `brush`, `keyboard`} |
   | Enter, Space | — | `pick` {[key f], `click`, `keyboard`} |
   | Escape | a = null | nothing; not prevented |
   | `focusout` | f = a = null | `mark` null |

   Ctrl, Meta or Alt: ignored and not prevented; handled keys are prevented. With n = 0 nothing is
   emitted. New data clamps f to n − 1 (null at n = 0) and sets a = null.
4. **The pointer brush.** A left press with no modifier whose travel reaches `chart-brush-min`
   brushes the bands from the band at the press to the band at the pointer, each clamped to
   [0, n − 1]; the release emits `pick` {their keys in draw order, `brush`, `pointer`}.
   `pointercancel` and `lostpointercapture` emit nothing. A press released within
   `chart-brush-min` emits `pick` as before, with `source: 'pointer'`.
5. **The overlay.** In the overlay pass, the brushed bands are filled with `selection` across the
   plot while the press lasts, and a 2 px `focus` stroke surrounds band f, from the name band's
   left edge to the plot's right edge (horizontal) or from the plot top to the name band's bottom
   (vertical). Neither redraws the layer. Both are dropped on `dispose`.
6. **Every engine implements (1)–(5) before it replaces `engine/index.ts`,** with ADR-0028. Until
   then a bar chart stays on Canvas 2D, also under `engine=wasm`.

## Consequences

- `PickEvent` gains a required member; the only consumer is the bar chart path.
- The frame listens for `focus` on its key target, besides `keydown` and `focusout`.
- A bar chart has one more tab stop (its listbox); the keyboard coverage scripts count it.
- Choosing what a pick does (filter, select, inspect) stays outside the engine: the panel's
  `barAction` decides it (T22 §4.3, #173 Part 3a).
- There is no dependency or bundle change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keys handled in `ChartFrame` | Two owners of the focus index; the brushed rows and the focus band need the engine's layout |
| A DOM brush over the canvas | The band geometry is the engine's; a DOM copy would drift from it |
| Reusing the crosshair slider | A slider names one value in a range; a bar chart is a list of items, read as a listbox with options |
