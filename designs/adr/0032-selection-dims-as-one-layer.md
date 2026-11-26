# ADR-0032: While a selection is active, a line chart's unmatched series are dimmed together, as one layer; amends 0025

| | |
|---|---|
| **Status** | Accepted (2026-11-26, on merge of #68 Part C2c2, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0025](0025-chart-frame-selection.md), its line rule ("the others at `dimmed`"): the unmatched series are dimmed together, one layer composited once at `dimmed`, in every renderer. Decision 4 (per matched series, its underlay and then its line, in shown order) and the rest of ADR-0025 are unchanged |
| **Source** | Issue #68 Part C2c2 (the selection highlight on engine frames) |
| **See** | [T25](../technical/T25-inspector-and-pivots.md) T25-006, §10 `unit:selection-draw`; [T02](../technical/T02-vis-engine.md) §4.2, T02-025; [T05](../technical/T05-testing-and-performance.md) §7.1 (`e2e:engine-selection`); [ADR-0031](0031-gpu-engine-default-renderer.md) (the engine is the default line renderer) |

## Context

ADR-0025 draws a line chart's unmatched series "at `dimmed`" while a selection is relevant. The
interim Canvas 2D renderer set `globalAlpha` per series stroke. The engine draws a line as
round-capped capsules, one per segment, span and dot, and neighbouring capsules of one series
overlap at every sample joint, and almost everywhere in dense data. A per-instance alpha adds up
there: measured on lavapipe, a series drawn at 0.35 showed an effective alpha of 0.46 at the joints
of a 61-sample line and 0.6–0.8 at one or more samples per column. A per-stroke alpha adds up in
the same way where two dimmed series cross. [ADR-0031](0031-gpu-engine-default-renderer.md) makes the engine the default line renderer,
so the dimmed background must read the same, and calm, in both renderers.

## Decision

1. **One layer.** While a selection matches at least one shown series of a line chart, its
   unmatched series are drawn at full alpha into one layer, and the layer is composited onto the
   chart once at `dimmed` (`opacity.dimmed`, 0.35). One blend per pixel: overlapping capsules and
   crossing series add up inside the layer as they would at full alpha, and are dimmed once.
2. **In every renderer.** The engine draws the layer as a premultiplied `Rgba8Unorm` texture per
   renderer, at the target's size, while a list has an emphasis (T02 §4.2). Canvas 2D draws it on
   one scratch canvas per frame, with its existing `drawLineSeries` unchanged at alpha 1, and
   composites it with one `drawImage` at `dimmed`; the scratch is released to 0×0 when nothing
   is dimmed.
3. **Unchanged.** The guides are drawn first at full alpha. Then, per matched series in shown
   order, its `focus` underlay 4 px wider and then its line, at full alpha (ADR-0025 decision 4).
   Relevance, the interval band and the bar, heatmap and stat rules are as before. Bar segments
   never overlap and keep their per-segment alpha.

## Consequences

- The two renderers agree at crossings, and the parity tests compare them there (`e2e:engine-
  selection` S10).
- Compared with per-stroke alpha, a crossing of two dimmed series shows only the later one, dimmed,
  instead of a darker mix.
- While a selection matches, the engine holds one target-sized texture and adds 3 + 2m
  submissions per frame for m matched series (decimation is not repeated). The texture is
  released on the first frame without a match.
- Canvas 2D holds one canvas the size of the frame while a selection dims.

## Alternatives considered

- **Pre-blended opaque colours** (each unmatched colour mixed with the background, alpha 1): no
  build-up, but they hide the guides and every series under a dimmed one.
- **A layer or stencil per series**: exact per-series alpha, but up to 499 composites per frame.
- **Per-instance or per-stroke alpha** (the old rule): the build-up above.
