# ADR-0036: The line `VisSpec` carries `area`; engines shade 1–4 series; amends 0014 §3

| | |
|---|---|
| **Status** | Accepted (on merge of #282 Part 2b, under the owner's approval of shaded charts, 2026-11-27) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3 (the chart engine seam): one optional member on the line spec. The rest of ADR-0014 is unchanged |
| **Source** | Issue #282 Part 2b (the visual refresh of the line chart); owner approval of the concept with shaded charts, 2026-11-27 |
| **See** | [T02](../technical/T02-vis-engine.md) §4.4 (the area pass, the gap and piecewise rules); [08](../product/08-visual-language.md) §3.1 and VL-004; [T05](../technical/T05-testing-and-performance.md) §7.1 |

## Context

The refreshed line chart shades the space under each series with a vertical gradient of the
series hue. The seam (ADR-0014 §3) carries only data and validated specs, and both engines (the
GPU engine, ADR-0031, and Canvas 2D) must draw the same picture (T02-029). Which charts are shaded
is an application decision (a line chart in Explore and on boards), while how the area follows the
line is an engine contract.

## Decision

1. The line `VisSpec` gains one optional member:

   ```ts
   readonly area?: boolean;   // absent or false = no area (every existing caller and fixture)
   ```

2. **Renderer contract.** With `area: true`, an engine draws a gradient area under each shown
   series when 1 to 4 series are shown, there is no selection at all (keys or an interval, matched
   or not) and the chart is 2D (no lanes). Each series' area runs from `opacity.chart-area` ÷ shown
   at the plot's top edge to 0 at its bottom, so the stacked tint never exceeds `chart-area`
   (0.18). Every area of a layer is drawn before any stroke.
3. **One gap rule.** The area lies under the line's joins: it starts at the first drawn point,
   ends at the last, closes straight down at each, and breaks where the line breaks. A NaN breaks
   only the join between the last finite sample before it and the first finite sample after it;
   columns without samples are joined (A.15.2). The Canvas 2D line follows the same rule.
4. **The piecewise edge rule.** A join's span splits where the line crosses the plot's top and
   bottom rows: above the plot the area fills from the top, inside from the line, below not at all.
   The GPU rebuilds clipped ends from the cut parameter it already carries; Canvas 2D classes ends
   in value space and projects only in-range values, fraction first. Piece boundaries agree within
   ±1 device px (`engine/fixtures/area-pieces.json`).
5. The application turns the area off (`area: false`) while forced colours are active or reduced
   transparency is asked for; the engine has no media query.

## Consequences

- No new method or event; `ChartFrame`, `FrameEvents` and `FrameInit` are unchanged.
- The GPU engine adds one instanced draw per Line item over the line's own instances: no compute
  pass, buffer or read-back.
- Bars, heatmaps and stacked series are not shaded; a user switch for the area is a follow-up.

## Alternatives considered

| Alternative | Why not |
|---|---|
| An envelope area from the decimated column ranges | A new pass, and the area would differ from the line |
| A stencil per series | Needs a depth-stencil attachment on WebGL2 |
| The engine reads `forced-colors` itself | Media queries belong to the application; the worker has none |
| Always shade, no spec member | Every existing caller and golden would change; the seam keeps the choice with the application |
