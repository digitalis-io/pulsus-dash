# 05 — Visualisation catalogue

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.10-rc · 2026-11-25 |
| **Requirement area** | `VIZ` |
| **Source draft** | plans/05-visualisation-catalogue.md (not tracked) |
| **Depends on** | [03 Interaction model](03-interaction-model.md) · [08 Visual language](08-visual-language.md) · [09 Performance contract](09-performance-contract.md) · [04 Surfaces](04-surfaces.md) · [07 Alerting](07-alerting.md) · [15 Estate navigation](15-estate-navigation.md) |
| **Technical designs** | [T02 Vis engine](../technical/T02-vis-engine.md) · [T01 Frontend architecture](../technical/T01-frontend-architecture.md) · [T05 Testing & performance](../technical/T05-testing-and-performance.md) · [T07 Scene query planner](../technical/T07-scene-query-planner.md) · [T21 Time, distribution & comparison panels](../technical/T21-time-and-distribution-panels.md) |
| **Mockups** | [06-metrics-workbench](../mockups/06-metrics-workbench.svg) · [05-service-lens](../mockups/05-service-lens.svg) · [07-logs-workbench](../mockups/07-logs-workbench.svg) · [08-traces-workbench](../mockups/08-traces-workbench.svg) · [22-topology-3d](../mockups/22-topology-3d.svg) · [03-infra-cluster](../mockups/03-infra-cluster.svg) · [14-board](../mockups/14-board.svg) · [16-gallery](../mockups/16-gallery.svg) · [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg) · [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg) · [21-floors-3d](../mockups/21-floors-3d.svg) · [22-topology-3d](../mockups/22-topology-3d.svg) · [25-fleet-line-stack-3d](../mockups/25-fleet-line-stack-3d.svg) |

Section numbers §1–§14 are kept identical to the source draft because other documents cite them
(e.g. "05 §11").

## 0. Purpose, scope & definitions

This document is the catalogue of every visualisation ("vis") Pulsus Dash ships: what each one is
for, when the auto-vis picks it, the data volume it must sustain, and how it degrades (its LOD
strategy). It also fixes the axis model (§1.1), vis configuration (§10), the panel parity map
(§11), the auto-vis rules (§12), data-vis accessibility (§13) and the showcase gallery (§14).

It does not define the rendering pipeline (see [T02](../technical/T02-vis-engine.md)), the
interaction grammar (see [03](03-interaction-model.md)) or colour and type tokens (see
[08](08-visual-language.md)).

**Definitions**

| Term | Meaning |
|---|---|
| **Vis** | A declarative composition of the shared GPU mark primitives (about 12) defined in [T02](../technical/T02-vis-engine.md) |
| **GPU vis** | Rendered by the shared chart engine (Rust/WASM, wgpu, one GPU device per page) into the viewport's own canvas, or into the Space scene. This is the default for every vis |
| **DOM vis** | Rendered as React components of the web application ([ADR-0014](../adr/0014-typescript-react-web-client.md)) because it is mostly text or form controls. Marked **DOM** in the tables |
| **Viewport** | One vis instance in a scene, with its own camera and axes |
| **Scale target** | The data volume a vis MUST render at the frame-rate targets of [09](09-performance-contract.md) §1 on its reference hardware |
| **LOD strategy** | How a vis reduces what it draws when data exceeds pixels, without hiding signal |
| **Universal interactions** | Hover crosshair synced on time; click → Inspector; brush; baseline ghost; anomaly overlay; pivot chips ([03](03-interaction-model.md) §5) |
| **Auto** | The vis the auto-vis rules (§12) pick from data shape and Perspective |
| **Milestone** | The column of that name in the tables below gives the earliest milestone in which the row MUST be available ([12](12-roadmap.md)) |

### 0.1 General requirements

#### VIZ-001 — GPU rendering by one shared engine
**MUST** · M-UI0 · SRE, Engineer, Platform, NOC

Every vis in this catalogue not marked **DOM** MUST be drawn by the Dash chart engine
([T02](../technical/T02-vis-engine.md)): one Rust/WASM engine in one worker with one GPU device per
page, drawing each viewport into its own canvas through the `ChartFrame` seam
([ADR-0014](../adr/0014-typescript-react-web-client.md) §3). The Atlas and a Lens are each one scene
on one canvas. A vis marked **DOM** MUST render as React components of the web application. No vis
MAY use a third-party JavaScript charting, mapping, 3D or diagram library.

*Acceptance:* Given the shipped bundle, when its dependency allowlist and lockfile are inspected, then
no JS charting, mapping, 3D or diagram library is present; and given any non-DOM vis on screen with
the engine active, when the frame is captured, then it is drawn by the engine into its viewport's
canvas, one GPU device serves every canvas on the page, and nothing is drawn by DOM, SVG or the
interim renderer.

> **Note:** until the engine lands, line, stacked bars, heatmap and stat are drawn by the in-house
> Canvas 2D renderer behind the same seam ([ADR-0014](../adr/0014-typescript-react-web-client.md)
> §4). That renderer meets the library clause but not the engine clause, so VIZ-001 stays M-UI0 and
> is met when the engine draws every non-DOM vis of that milestone (decision D6).

#### VIZ-002 — Every vis is a composition of shared mark primitives
**MUST** · M-UI0 · Engineer

Every vis MUST be expressed as a declarative composition of the shared GPU mark primitives defined in
[T02](../technical/T02-vis-engine.md), so that LOD, picking, theming and the universal interactions
are implemented once.

*Acceptance:* Given the vis engine source, when any vis in Tables 5-1 to 5-9 is inspected, then it is
defined as a spec over T02 mark primitives and has no private draw pipeline outside them.

#### VIZ-003 — Universal interactions on every vis
**MUST** · M-UI1 · SRE, Engineer, Platform, NOC

Every vis MUST support the universal interactions: a hover crosshair synced on time across all
viewports in the scene; click → Inspector; brush; baseline ghost; anomaly overlay; and pivot chips.
Where an interaction has no meaning for a vis (e.g. a time crosshair on a categorical bar chart), the
vis MUST still accept it without error and MUST say why it does not apply in its tooltip.

*Acceptance:* Given a board with one viewport of each vis available at the milestone, when the user
hovers a time-series viewport, then every time-based viewport shows the crosshair at the same instant
within one frame; and for each viewport, click opens the Inspector, brush produces a selection, and
the baseline ghost, anomaly overlay and pivot chips can be toggled.

#### VIZ-004 — Scale targets per vis
**MUST** · M-UI0 · SRE, Engineer, Platform, NOC

Each vis in Tables 5-1, 5-4, 5-5 and 5-6 that lists a scale target MUST render that volume at the
frame targets of [09](09-performance-contract.md) §1 (60 fps during pan/zoom, never below 45 fps
p99 on reference hardware (b)) from the milestone listed in its row.

*Acceptance:* Given the gallery page (§14) for a vis seeded at its listed target volume, when the
CI frame-time benchmark pans and zooms it on reference hardware (b), then p99 frame rate is ≥ 45 fps
and median is ≥ 60 fps.

#### VIZ-005 — LOD never hides signal silently
**MUST** · M-UI0 · SRE, Engineer

Each vis MUST apply the LOD strategy in its table row. An LOD reduction MUST keep extremes visible
(outliers, peaks, worst states), and when data is not drawn at full fidelity the viewport's coverage
meter (§2) MUST say so.

*Acceptance:* Given a line of 10⁶ points containing a single-sample spike, when it is drawn in a
1 000 px wide viewport, then the spike's value is visible; and given a viewport drawing a density
field instead of points, then its coverage meter states the reduction.

## 1. Time-series (2D)

**Table 5-1 — Time-series vis**

| Vis | Auto-chosen when | Scale target @60 fps | LOD strategy | Milestone |
|---|---|---|---|---|
| **Line** | gauges, rates | 1 000 series × 100k pts (10⁸ raw, ~10⁶ drawn) | Per-pixel-column min/max/first/last decimation on GPU (compute shader), which is visually lossless; switch from rollup to raw source past stored resolution | M-UI0 |
| **Area / stacked** (absolute, 100 %) | composition (by status, by level) | 200 series | same as Line | M-UI1 |
| **Bars over time** (time-binned) | counts per interval (deploys/h, errors/min) | 10k bars | Re-bin to pixel width; stacked / grouped | M-UI1 |
| **Band (min/max/avg)** | many series of the same metric (> 50 series) | 10k series collapsed to a band + outliers drawn individually | "Collapse crowd, keep outliers": series within the band are hidden; deviants drawn | M-UI1 |
| **Heatmap (time × bucket)** | histograms (`_bucket`, native histograms), span durations | 10k × 200 cells, continuous zoom | Re-bucket on GPU; log/linear Y; brush → Universal Compare | M-UI1 |
| **Scatter (time × value)** | spans, events | **10M points** | Point sprites with density-based alpha; zoomed out → density field (KDE splat); zoomed in → individual clickable points | M-UI0 |
| **Box / OHLC over time** (candlestick-style) | distribution per step when a heatmap is too dense: min / p25 / p50 / p75 / max, or open/high/low/close for business/financial series | 5 000 boxes | One instanced glyph per step; morphs into a heatmap when zooming out | M-UI5 |
| **Stat / big number** | single value | — | Value + sparkline + baseline delta + state colour | M-UI1 |
| **State timeline** (event-driven) | state that changes at irregular times (alert state, pod phase, deploy version) | 5 000 rows | Run-length merged segments; value-mapped colours + text | M-UI3 |
| **Status history** (periodic grid) | state sampled on a fixed step (up/down per minute, SLO met per hour) | 5 000 rows × 2 000 cols | Cells re-binned to pixel width; worst state wins when merging | M-UI5 |
| **Calendar heatmap** | daily/weekly seasonality, SLO compliance per day, on-call load | 5 years | Day cells grouped by week/month | M-UI5 |
| **Small multiples** | per-entity breakdown (pods, routes) | 1 000 tiles | Instanced quads; sorted by "care" score ([01a](01a-audiences-and-perspectives.md) §2.3) | M-UI2 |
| **Sparkline** | in tables, Inspector, Atlas tooltips | 10k on screen | Pre-decimated to tile width | M-UI2 |
| **SLO burn / error-budget chart** | SLO objects | — | Budget remaining line + multi-window burn-rate bands + alert thresholds ([07](07-alerting.md)) | M-UI4 |

#### VIZ-006 — Line decimation is visually lossless
**MUST** · M-UI0 · SRE, Engineer

The Line vis MUST decimate on the GPU per pixel column, keeping min, max, first and last of each
column, so that the drawn result is visually identical to drawing every raw point. A line whose
values lie beyond the clip box of its draw's value encoding ([T02-014](../technical/T02-vis-engine.md#t02-014--precision-f64-on-the-cpu-f32-relative-to-an-encoding-origin))
MAY be decimated on the CPU, with f64 segment clipping; this fallback MUST keep the same first, last,
min and max per column, and is covered by the same acceptance test. The T2 tier decimates on the
CPU by the same rule ([T02](../technical/T02-vis-engine.md) §4.4). When the visible
range is finer than the stored rollup resolution, the line MUST switch from the rollup to the raw
source without user action.

*Acceptance:* Given 1 000 series × 100k points, when the decimated render is compared with a
reference render of every raw point, then the golden-image diff is zero at the pixel level for
line coverage; the reference draws every raw point at its pixel column's centre; the comparison
runs on both CPU paths; and when the user zooms past the rollup step, then the data source badge
changes to raw and new points appear without the user changing the query.

#### VIZ-007 — Band collapses the crowd and keeps outliers
**MUST** · M-UI1 · SRE, Platform

When a time-series viewport holds more than 50 series of the same metric, the auto-vis MUST draw a
min/max/avg band and MUST draw individually every series that leaves the band. Hidden series MUST be
listed in the legend as "N in band".

*Acceptance:* Given 800 pod series of which 3 deviate, when the viewport renders, then the band and
exactly the 3 deviant series are drawn and the legend reads "797 in band".

#### VIZ-008 — Scatter density and point modes
**MUST** · M-UI0 · SRE, Engineer

The Scatter vis MUST render up to 10⁷ points. When zoomed out it MUST show a density field; when
zoomed in far enough that points separate, it MUST show individual points that can be clicked,
hovered and brushed.

*Acceptance:* Given 10⁷ spans, when fully zoomed out, then a density field is drawn at ≥ 60 fps;
and when zoomed in until fewer than 10⁵ points are visible, then each point is individually clickable
and opens its span in the Inspector.

#### VIZ-009 — State merging rules
**MUST** · M-UI3 · SRE, NOC, Platform

The State timeline MUST merge consecutive equal states into one segment. The Status history MUST
re-bin cells to pixel width and, when merging cells, MUST show the worst state of the merged cells.

*Acceptance:* Given a status history of 2 000 one-minute cells with one "down" minute, when it is
drawn in 400 px, then the pixel column containing that minute shows "down".

#### VIZ-010 — Line, area and bar style options
**MUST** · M-UI1 · Engineer, SRE

Line, area and bar vis MUST offer, at parity with incumbent dashboard tools:
- interpolation: linear, smooth, step-before, step-after;
- null handling: gaps, connect under a threshold, or zero;
- gradient: opacity, hue or scheme;
- stacking groups;
- multiple X and Y axes on any side, stacked or central (§1.1);
- log and symlog scales;
- soft min/max;
- negative-Y transform;
- per-series overrides.

*Acceptance:* Given an imported time-series panel that uses each option above, when it is
rendered, then each option has the same visible effect as in the source tool.

#### VIZ-011 — Overlays on any time vis
**MUST** · M-UI1 · SRE, Engineer, NOC

Every time-based vis MUST support these overlays:
- baseline ghost band and anomaly band (expected range);
- threshold lines and areas;
- time regions (business hours, maintenance windows);
- event markers (deploy ◆, config ⚙, alert ⚠);
- exemplars;
- forecast (dashed, with a confidence cone);
- annotations;
- cursor sync.

*Acceptance:* Given a Line viewport, when each overlay is enabled in turn, then it renders aligned
to the time axis and survives pan/zoom; and given a Heatmap viewport, the same overlays are
available.

> **Note:** Forecast and anomaly bands depend on baselines and anomaly scores, which are
> Dash-derived state stored in PostgreSQL ([ADR-0012](../adr/0012-derived-state-in-postgres.md)).

#### VIZ-012 — Exemplars link to traces
**MUST** · M-UI2 · SRE, Engineer

Exemplar dots MUST be drawn from PromQL `query_exemplars` and TraceQL-metrics `trace:id` exemplars,
both served by PulsusDB, and clicking one MUST open its trace.

*Acceptance:* Given a latency heatmap with exemplars, when the user clicks an exemplar dot, then the
trace waterfall for that `trace_id` opens with the Context time preserved.

### 1.1 Axes as a design tool

Incumbent dashboard tools stop at "left or right Y axis". Dash has a first-class axis model and treats axes as
first-class, draggable objects: any number per side, each with an id, colour, scale and range. Any
series or annotation can bind to any axis. Each pattern below is there because it answers an
observability question better than a second panel would. Mockups:
[06-metrics-workbench](../mockups/06-metrics-workbench.svg) (secondary Y, time-shifted X),
[05-service-lens](../mockups/05-service-lens.svg) (stacked lanes).

**Table 5-2 — Axis patterns**

| Pattern | Observability use | Default trigger | Milestone |
|---|---|---|---|
| **Secondary Y axis** (left + right) | Different units on one time base: RPS (left) vs p99 latency (right), queue depth vs consumer lag. The axis takes its series' colour so you can tell which scale applies | Two series with incompatible units in one viewport | M-UI1 |
| **Multiple X axes** (bottom + top) | **Time-shifted overlay.** Under A/B Everything (`C`) or the baseline ghost (`Shift+C`), the comparison window gets its own top time axis in its own colour, labelled in real time ("last Tue 14:00") rather than "−7d". **Drag the top axis to slide B against A**, e.g. to line up two incident onsets or two deploys. "Align on onset" snaps it automatically using the CUSUM onset detector of T15 (draft) | Compare is on | M-UI1 (ghost) · M-UI3 (align on onset) |
| **Vertically stacked Y axes** (strip chart) | A service's RED + saturation as 4–6 lanes in **one** viewport: one time axis, one camera, one crosshair, each lane with its own Y scale, like an oscilloscope. Denser and better aligned than small multiples. It is the default body of the Lens "golden signals" strip | Lens header; ≤ 8 lanes | M-UI2 |
| **Central / base-value axis** | Delta charts: a series minus its baseline, drawn around a zero line through the middle of the plot. The base value can also be an SLO threshold or capacity limit, so "above the line" means "bad" | Compare "Difference" mode; threshold-relative mode | M-UI3 |
| **Static X axis** | Live tail and NOC walls: the tick labels stay fixed while data scrolls under them (no tick shimmer on a 4K wall) | Live mode on walls/TV | M-UI5 |
| **Discontinuous time axis** | Batch jobs, market hours, business-hours-only SLOs: collapses gaps with a visible break mark (⫽), so nothing is silently hidden. The break shows how much time it removed | Data has known recurring gaps, or the user opts in | M-UI5 |
| **Vertical (rotated) chart** | Time runs down the page next to logs, the trace waterfall or the incident timeline, so rows line up with log lines | Side-by-side with a vertical list | M-UI4 |
| **Log / symlog axes** | Latency spans of 1 ms–60 s; error counts that hit zero | Range spans more than 3 decades | M-UI1 |
| **Draw behind axes** | Full-bleed plots for walls and sparkline-dense tiles: axes overlay the data with translucent bands | Wall/TV mode, tiles < 200 px | M-UI5 |

Engine side: [T02](../technical/T02-vis-engine.md) §4.3 (axis system).

#### VIZ-013 — Axes are first-class objects
**MUST** · M-UI1 · Engineer, SRE

A viewport MUST support any number of axes on each side. Each axis MUST have an id, colour, scale and
range, and any series, threshold, annotation or event marker MUST be bindable to any axis.

*Acceptance:* Given a viewport spec with three Y axes on the left and one on the right, when it
renders, then all four axes are drawn with their own ranges and each series plots against the axis
its spec names.

#### VIZ-014 — Axis patterns and default triggers
**MUST** · M-UI1 · Engineer, SRE, NOC, Platform

Each axis pattern in Table 5-2 MUST be available from its listed milestone and MUST be applied
automatically when its default trigger holds, unless the user has set the axes manually.

*Acceptance:* For each row of Table 5-2, given data meeting the default trigger, when the viewport is
auto-configured, then the listed pattern is applied; and given a viewport whose axes the user has set
manually, then no pattern is auto-applied.

#### VIZ-015 — Time-shifted comparison axis
**MUST** · M-UI1 · SRE, Engineer

When a baseline ghost (`Shift+C`) or A/B comparison (`C`) is on, the comparison window MUST get its
own top X axis, drawn in the comparison colour and labelled in real time (e.g. "last Tue 14:00"),
not as an offset. Dragging that axis MUST slide window B against window A; the slide MUST be undoable.

*Acceptance:* Given a p99 line with a −7d ghost, when the ghost is on, then a top axis appears
labelled with the real dates of last week; when the user drags it by 20 minutes, then the ghost
moves by 20 minutes and the axis labels update; and `⌘Z` restores the previous offset.

#### VIZ-016 — Align on onset
**SHOULD** · M-UI3 · SRE, IC

A comparison axis SHOULD offer "Align on onset", which snaps window B so that the change-point
onsets detected in A and B coincide.

*Acceptance:* Given two incident windows whose onsets are 37 minutes apart relative to their window
starts, when the user chooses "Align on onset", then the top axis slides by 37 minutes ± one sample
step and both onsets lie on the same pixel column.

#### VIZ-017 — Stacked lanes in one viewport
**MUST** · M-UI2 · SRE, Engineer

A viewport MUST support vertically stacked Y-axis lanes that share one time axis, one camera and one
crosshair, each lane with its own Y scale. Lanes MUST be limited to 8 per viewport for readability.
The Lens "golden signals" strip MUST use this pattern by default.

*Acceptance:* Given a service Lens, when it opens, then RED + saturation are drawn as 4–6 lanes in
one viewport; panning one lane pans all; and adding a ninth lane is refused with a suggestion to split
the viewport.

#### VIZ-018 — Axis count hint
**MUST** · M-UI1 · Engineer

Auto-configuration MUST NOT create more than 2 axes per side (4 in total). A user MUST be able to
add more, and doing so MUST show a "consider stacking" hint. Stacked lanes are not counted towards this limit.

*Acceptance:* Given a viewport with 2 left axes, when the user adds a third left axis, then it is
added and a "consider stacking" hint appears; and given 6 stacked lanes, no hint appears.

#### VIZ-019 — Axis colour and ownership glyph
**MUST** · M-UI1 · Engineer, SRE

When a viewport has more than one axis on a dimension, each axis MUST take the colour of its series,
and each series MUST show a matching axis-ownership glyph in the legend. Colour MUST NOT be the only
cue (§13).

*Acceptance:* Given RPS on the left and p99 on the right, when rendered in greyscale, then each
series' legend glyph still identifies its axis.

#### VIZ-020 — Per-axis interaction
**MUST** · M-UI1 · Engineer, SRE

Dragging an axis MUST pan that axis only; wheel over an axis MUST zoom that axis only; double-click on
an axis MUST fit that axis to its data. Each change MUST be undoable and MUST show a "manual range"
pin on the axis until reset ([03](03-interaction-model.md) §4.1).

*Acceptance:* Given two Y axes, when the user wheels over the right axis, then only the right axis
range changes, a manual-range pin appears on it, and `⌘Z` restores it.

#### VIZ-021 — Crosshair reads every bound axis
**MUST** · M-UI1 · SRE, Engineer

The crosshair tooltip MUST show the value of every series against its own bound axis, including the
comparison window's real time, in one line (e.g. "12:22 · 1.8k rps · p99 2.4 s · last Tue 12:22 ·
0.4 s").

*Acceptance:* Given a viewport with left, right and top axes, when the user hovers a point in time,
then the tooltip lists one value per series with the correct unit for its axis and the comparison
timestamp.

#### VIZ-022 — Overlays declare their axis
**MUST** · M-UI1 · SRE, Engineer

Every annotation, threshold and event marker MUST declare the axis it is bound to, and MUST stay
correctly placed when axes move independently.

*Acceptance:* Given a threshold bound to the right axis, when the user pans only the left axis, then
the threshold does not move relative to the right axis.

#### VIZ-023 — Static X axis on walls
**MUST** · M-UI5 · NOC

In live mode on a wall or TV, time axes MUST keep tick labels fixed while data scrolls beneath them.

*Acceptance:* Given a live viewport in Wall mode, when 60 s of data scroll past, then tick label
positions do not change between frames.

#### VIZ-024 — Discontinuous time axis is never silent
**MUST** · M-UI5 · Business, SRE

When a time axis collapses gaps, each collapsed gap MUST be marked with a visible break mark (⫽) that
states how much time it removed.

*Acceptance:* Given a business-hours-only SLO chart over a week, when gaps are collapsed, then every
night and weekend gap shows a ⫽ mark with its duration (e.g. "⫽ 15 h").

## 2. Distributions & comparisons

**Universal Compare** (`B` on any selection, any signal) renders as three linked panes:
- **Different:** attributes ranked by divergence, with selection vs baseline bars;
- **Unchanged:** dimensions that ruled themselves out;
- **Coverage:** what fraction of data the answer rests on.

Every viewport also carries a **coverage meter**.

**Table 5-3 — Distribution & comparison vis**

| Vis | Use | Milestone |
|---|---|---|
| **Compare bars** (selection vs baseline, per attribute value) | Attribute-divergence compare output for spans/logs/metric labels; sorted by significance | M-UI3 |
| **Histogram** (standalone, any numeric field) | Value distribution of a reduced field (latency of selected spans, request sizes, pod memory); bucket size auto/explicit, stacked by group (VIZ-090) | M-UI5 |
| **Histogram / CDF / ECDF overlay** | Latency before vs after; version A vs B (VIZ-090) | M-UI3 |
| **Box / violin plot** (categorical X) | Distribution per version, region or pod; outliers individually clickable | M-UI5 |
| **XY chart** (arbitrary X × Y) | Correlation between two non-time fields: CPU vs latency per pod, request size vs duration. Points / lines / both; **bubble** (size field) and colour field; log/symlog axes; regression line + r²; 10⁷ points | M-UI5 |
| **Trend** (sequential non-time X) | Curves over a numeric axis: latency vs load (RPS), throughput vs concurrency, cost vs replicas. The capacity-planning view for Lee (Platform) | M-UI5 |
| **Parallel coordinates** | Many attributes per entity/span at once (high-cardinality exploration); brush on any axis filters the scene | M-UI5 |
| **Delta table** | Release compare: signal × version with Δ and significance | M-UI5 |
| **Treemap** | Cardinality by label (metrics cardinality explorer), log volume by service, cost, ownership | M-UI1 |
| **Sunburst** | Same uses as treemap, for hierarchies deeper than two levels | M-UI5 |
| **Funnel / Sankey** | Journeys ([04](04-surfaces.md) §4.14), traffic splits by route/version, log routing | M-UI5 |

#### VIZ-025 — Universal Compare
**MUST** · M-UI3 · SRE, Engineer, Platform

Pressing `B` on any selection or brush, on any signal (spans, log fields, metric labels, profile
frames, entities), MUST open Universal Compare with three linked panes: Different (attributes ranked
by divergence, with selection vs baseline bars), Unchanged (dimensions that ruled themselves out) and
Coverage (fraction of data the answer rests on). Clicking a value MUST filter every viewport in the
scene.

*Acceptance:* Given a brushed region of a span scatter, when the user presses `B`, then the three
panes appear; and when the user clicks `version=2.31` in Different, then every viewport in the scene
filters to that value in one undoable step.

#### VIZ-026 — Compare answers locally first
**MUST** · M-UI3 · SRE, Engineer

Universal Compare MUST first answer from data already held in the browser and then refine from the
server, marking the result ⚡ local, ☁ server or ✓ exact ([09](09-performance-contract.md) §4).

*Acceptance:* Given a loaded span sample, when the user presses `B`, then a local result is shown
within 16 ms of the keypress, badged ⚡ local, and is replaced by the server result badged ☁ or ✓.

#### VIZ-027 — Coverage meter on every viewport
**MUST** · M-UI1 · SRE, Engineer, Platform

Every viewport MUST carry a coverage meter that states when its data is sampled, truncated, missing
a shard (timeout), missing a dimension (cardinality cap) or limited by retention. Full coverage MUST
be shown as such ("100 %"), never as absence of the meter.

*Acceptance:* Given a query for which PulsusDB returns `truncated: true`, when the viewport renders,
then the coverage meter shows "truncated" with a one-click "narrow" suggestion; and given a complete
result, it shows "100 %".

#### VIZ-028 — Distribution vis available
**MUST** · M-UI3 · SRE, Engineer, Platform, Business

Each vis in Table 5-3 MUST be available from its listed milestone with the behaviours in its Use
column. Brushing an axis of a parallel-coordinates vis, or clicking a compare bar, MUST filter the
scene.

*Acceptance:* For each row of Table 5-3 at its milestone, given matching data, when the vis is
selected, then it renders with the listed options (e.g. XY chart shows a regression line and r² when
enabled).

#### VIZ-090 — Histogram and cumulative overlay
**MUST** · M-UI3 · SRE, Engineer, Platform, Business

The Histogram (Table 5-3) MUST bin a numeric result (one value per series, or every sample of a range
pooled) with auto, count or width bins on a linear or log value axis, stack or overlay groups by a
label, and overlay a CDF or an exact ECDF. A result with histogram buckets (`le` series) MUST be drawn
with one bin per returned bucket from the cumulative counts, never binned as values and never with
invented counts, and its quantiles MUST be labelled as estimates. Values it cannot draw (≤ 0 or
crossing 0 on a log axis, infinite, outside the drawable magnitude 1e−290…1e290, or malformed,
incompatible or invalid bucket families) MUST be counted on the coverage meter, which totals them,
with the per-group breakdown one action away; every group MUST be told apart without colour.

*Acceptance:* Given latencies for versions A and B grouped by `version` with ECDF, when drawn, then two
curves show, each ends at 100 %, the tooltip reads the exact share ≤ x for each, and in greyscale the
groups differ by dash; and given 3 zero values on a log axis, then the meter reads "3 ≤ 0 not shown (log)";
and given buckets 0.1, 0.5, 1 and +Inf with cumulative counts 3, 8, 9 and 10, then the bins read "≤ 0.1",
"0.1 – 0.5", "0.5 – 1" and "> 1" with counts 3, 5, 1 and 1, and the median reads "≈ 0.26 (estimate)".

## 3. Topology & space (3D / 2.5D)

**Space is 3D, signals are 2D, and both are linked** (VIZ-077, [15](15-estate-navigation.md)
EST-064). The estate, global views, infrastructure, service maps and topology default to 3D; time
series, distributions, tables, logs, trace waterfalls and flame graphs default to 2D; a 3D signal
view (§3.1) is used only where a third dimension carries meaning. Every 3D vis flattens to its 2D
equivalent with `T`.

**Table 5-4 — Topology & space vis**

| Vis | Use | Scale | Notes | Milestone |
|---|---|---|---|---|
| **Graph (force/layered)** | Atlas Topology, Lens dependency mini-map, node-graph panel equivalent (arc-segmented node rings for status split, edge thickness/colour bound to fields) | 10k nodes / 50k edges | Layout computed incrementally in a worker (stable positions; pinned seeds per org); clustering LOD; particle edges via instanced quads. **3D layered** (depth = tier or layer) is the Atlas default for large graphs (VIZ-073); flat 2D layered is its `T` equivalent and the default for small graphs and the mini-map | M-UI2 (mini-map) · M-UI3 (Atlas scale, 3D layered) |
| **City / containment world (3D)** | Atlas Map (L0–L2), City and Infra views; the infra floor | 10k buildings + 50k pod blocks at the frame targets ([09](09-performance-contract.md) PRF-043); 50k buildings with LOD | Plateaus, districts, buildings, pod slabs, container cells ([15](15-estate-navigation.md) Table 15-9); footprint = capacity, height = load, colour = health; instanced boxes; key + ambient lighting, depth fog and contact shadows per [08](08-visual-language.md) §10; cut-away on focus; 2D equivalent: treemap or heat grid (VIZ-074) | M-UI3 |
| **Globe / map** | Multi-region, Atlas Map view | — | Globe at the highest altitude, flattening to the ground plane of the 3D world as the camera descends; regions as plateaus placed geographically; the flat geomap (§7) is the `T` equivalent | M-UI3 |
| **Heat grid / hexbin wall** (host-map and hexagon status-grid style) | 2D equivalent of the Infra city (`T`); Alerts-room hexbin wall | 100k cells | One cell per instance, grouped by parent; semantic zoom into cells; hexagon or square tiling | M-UI3 |
| **Floors (stacked)** | App floor above the infra city with runs-on threads ([15](15-estate-navigation.md) §3.3) | Selection threads only | Graph + City in one scene; threads as M6 curves; split 2D under `T` | M-UI3 |
| **3D surface** ("latency landscape") | Histogram over time | 2k × 200 | Specified as the latency surface 3D signal view (§3.1, VIZ-079) | M-UI3 |
| **Trace skyline** | 3D waterfall extruded by service | 50k spans | — | M-UI3 |
| **Flame landscape** | Profile over time | 100k frames × time | 2D fallback is the default | M-UI3 |

Mockups: [22-topology-3d](../mockups/22-topology-3d.svg) and
[22-topology-3d](../mockups/22-topology-3d.svg) (2D), [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg)
and [03-infra-cluster](../mockups/03-infra-cluster.svg) (2D), [21-floors-3d](../mockups/21-floors-3d.svg).

#### VIZ-029 — Graph layout is stable and incremental
**MUST** · M-UI3 · SRE, NOC, Platform

The Graph vis MUST compute layout incrementally in a worker without blocking the render thread, MUST
keep node positions stable across refreshes, and MUST seed positions from a per-org pinned layout so
that the same estate looks the same tomorrow.

*Acceptance:* Given a 10k-node graph, when one node is added, then no existing node moves more than
5 % of the viewport width and no frame exceeds 16 ms; and given two sessions on different days with
the same topology, node positions match.

#### VIZ-030 — Graph clustering LOD and truncation honesty
**MUST** · M-UI3 · SRE, NOC, Platform

The Graph vis MUST collapse distant groups into single aggregate nodes and expand them as the camera
approaches, holding 10 000 nodes / 50 000 edges at the frame targets. When the source service graph
is truncated (e.g. by a PulsusDB edge cap), the coverage meter MUST show how many edges were dropped.

*Acceptance:* Given 10k nodes / 50k edges, when the user zooms from estate to a single namespace,
then aggregates expand smoothly at ≥ 60 fps median on reference hardware (b); and given a
`service_graph` response truncated at 1 000 edges, the coverage meter reads "edges truncated" with
the count.

> **Note:** The 10k / 50k target assumes PulsusDB raises its `service_graph` edge cap to ≥ 50 000
> (assumption A1 in the [designs README](../README.md)). If it does not, topology falls back to
> client-side aggregation and the coverage meter shows truncation.

#### VIZ-031 — 3D only when it encodes a dimension
**MUST** · M-UI3 · SRE, Platform, NOC

A 3D vis MUST encode an extra data dimension (height = metric, depth = service, tier, lane or time,
the vertical axis = layer of the stack) or aid navigation at scale. The estate's spatial vis are 3D
by default under this rule ([15](15-estate-navigation.md) EST-055). Every 3D view MUST have a 2D
equivalent reachable with `T`. There MUST NOT be 3D pie charts or decorative perspective on 2D
charts.

*Acceptance:* Given any 3D vis in Table 5-4, when the user presses `T`, then the 2D equivalent shows
the same data and selection; and the vis spec schema rejects 3D or perspective on pie, bar and line
vis.

#### VIZ-086 — True 3D only
**MUST** · M-UI3 · SRE, Platform, NOC, Engineer

Every 3D vis MUST be a real 3D scene: geometry with depth in world space, a camera the user can
orbit, pan and dolly (perspective by default; the orthographic toggle of VIZ-078 is a projection of
the same scene), depth-tested occlusion, and lighting per [08](08-visual-language.md) VL-023. A 2D vis
MUST NOT imitate depth: no bevels, extruded-looking fills or textures, drop shadows, isometric skins
or lighting-like gradient shading. Gradients that encode data (VIZ-010 gradient fill, ramps of VL-006)
are not shading. A vis type either has a true 3D form under VIZ-031 or stays 2D.

*Acceptance:* Given each 3D vis at its milestone, when the camera orbits between two poses, then a mark
that occludes another at the first pose no longer occludes it at the second, and the per-pixel depth
order matches the scene geometry; and given any 2D vis spec carrying a depth, perspective, bevel,
shadow or shading property, when validated, then it is rejected.

#### VIZ-032 — Heat grid semantic zoom
**MUST** · M-UI3 · Platform, NOC

The heat grid MUST draw one cell per instance, grouped by parent, with hexagon or square tiling, and
MUST support semantic zoom into a cell (e.g. node → its pods) per [15](15-estate-navigation.md) §6.
It is the 2D equivalent of the Infra city and the Alerts-room hexbin wall; it is not the default
Infra view.

*Acceptance:* Given 100k pod cells, when rendered, then the grid holds the frame targets; and when the
user zooms on a node cell past the expansion threshold, then its pods appear as child cells.

#### VIZ-073 — 3D layered topology for large graphs
**MUST** · M-UI3 · SRE, NOC, Platform

The Graph vis in the Atlas Topology view MUST default to a 3D layered layout, with depth assigned by
tier or layer (edge → gateway → services → data → external), when the graph visible after clustering
LOD exceeds 300 nodes (a per-user setting), and MUST default to the flat 2D layered layout otherwise.
`T` MUST switch between the two, keeping each node's in-tier position so that the 2D layout is the 3D
one seen front-on. Mockup: [22-topology-3d](../mockups/22-topology-3d.svg).

*Acceptance:* Given a 2 000-service graph, when Topology opens, then it is 3D layered with each tier
on its own depth plane; given 40 services, then it opens 2D layered; and `T` on the 3D graph morphs
to 2D within 250 ms with each node's horizontal order preserved.

#### VIZ-074 — Containment world vis
**MUST** · M-UI3 · Platform, NOC, SRE

The City / containment-world vis MUST draw containment as plateaus, districts, buildings, pod slabs
and container cells ([15](15-estate-navigation.md) Table 15-9) using instanced extruded boxes (T02
M11), with footprint, height and colour bound to the active layer, a cut-away of a building's walls
on focus revealing its pod slabs, and the lighting, fog, ground grid and contact shadows of
[08](08-visual-language.md) §10. It MUST have a 2D equivalent on `T` (treemap for City, heat grid for
Infra, flat map for Map). Mockup: [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg).

*Acceptance:* Given 10 000 buildings and 50 000 pod blocks, when rendered, then it meets
[09](09-performance-contract.md) PRF-043; focusing a building removes its near walls and shows one
slab per pod; and `T` shows the treemap with the same selection.

#### VIZ-075 — 3D edges are arcs with traffic particles
**MUST** · M-UI3 · SRE, NOC, Platform

In 3D scenes, edges MUST be drawn as arcs lifted above the ground plane (height ∝ distance, so short
edges stay low) carrying traffic particles whose rate ∝ request rate, with thickness bound to the
edge field. Under `prefers-reduced-motion`, particles MUST become static dashes
([08](08-visual-language.md) VL-016).

*Acceptance:* Given two edges at 10 and 1 000 rps, then the second carries particles at 100× the
rate (±10 %); and with reduced motion both are static dashes of different thickness.

#### VIZ-076 — 3D labels are billboards with leader lines
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Labels in every 3D vis MUST be screen-aligned MSDF billboards ([08](08-visual-language.md) VL-011)
anchored by a leader line, placed each frame by a greedy pass in care-score order that culls any
label that would overlap a placed one, and MUST always place the focused, selected and origin labels.

*Acceptance:* Given 10 000 labelled buildings, when the camera orbits 360°, then no frame has
overlapping labels, the focused label is in every frame, and the label pass stays within the frame
budget of PRF-043.

#### VIZ-077 — Space is 3D, signals are 2D, and both are linked
**MUST** · M-UI3 · SRE, NOC, Platform, Engineer

Spatial vis (Table 5-4 estate and topology rows) MUST default to 3D; signal vis (Tables 5-1 to 5-3,
§4, §6) MUST default to 2D, and a 3D signal view (§3.1) MUST be used only when opted into or chosen
by the auto-vis rules (§12) where a third dimension carries meaning. A 2D chart MUST be dockable
beside or inside every 3D scene, with hover and selection in 3D driving the 2D slice, a brush in 2D
highlighting in 3D, and one shared time cursor, as in [15](15-estate-navigation.md) EST-064.

*Acceptance:* As EST-064; and given a new board, when a time-series query is added, then it renders
as a 2D line chart, not a 3D view.

### 3.1 3D signal views

3D signal views show 2D signals with a third dimension that carries real meaning (many series side
by side, distributions over time, a third attribute). They are opt-in, or offered by auto-vis where
the rule in the table holds. Each has a 2D equivalent on `T` and a table view on `Shift+T`.

**Table 5-4a — 3D signal views**

| Vis | Use | Scale | Notes | Milestone |
|---|---|---|---|---|
| **Fleet line stack** (headline) | Line charts of every member of a group (all nodes in a cluster, all pods of a service, all instances in a pool) in one zoomable 3D chart | 2 000 lanes × full window | X = time, Y = value, Z = one lane per member; band + outlier LOD at distance; auto-offered at > 50 series of one metric (VIZ-085) | M-UI3 |
| **Latency surface** | Histogram buckets × time × count | 2k × 200 | Surface mesh (T02 M11 height field), height colour map, contours, optional wireframe; drives two 2D slices (VIZ-079) | M-UI3 |
| **Waterfall of distributions** | Per-interval latency or size distributions | 500 intervals × 200 bins | Line strips stacked along depth; orthographic toggle (VIZ-081) | M-UI3 |
| **Span point cloud** | Spans by duration × time × chosen attribute | 10⁷ spans | Pixel or sphere markers; densifies to volume/heat when zoomed out (VIZ-082) | M-UI2 |
| **3D columns** | Two categorical dimensions × a value (e.g. region × tier × error rate) | 100 × 100 | 3D variant of the Segments matrix; 2D stays the Segments default (VIZ-080) | M-UI5 |
| **3D scatter** | Three numeric attributes per entity (e.g. CPU × memory × p99) | 10⁵ points | Size / colour as 4th and 5th channels; log axes (VIZ-083) | M-UI5 |
| **Imported 3D models** | Data-centre and rack geometry for the physical-layout variant | — | glTF, geometry only (VIZ-084) | M-UI6 |
| **3D flame** | Profile hot spots | 10⁵ frames | X share, Z depth, Y self; top = icicle (VIZ-105) | M-UI3 |

Mockup: [25-fleet-line-stack-3d](../mockups/25-fleet-line-stack-3d.svg).

#### VIZ-078 — Shared 3D chart features
**MUST** · M-UI3 · SRE, Engineer, Platform

Every 3D signal view MUST provide:
- an axis cube with per-plane visibility, by default hiding the planes nearest the camera, with
  gridlines and axis bands;
- linear and log axes, except that an axis whose positions are shares of a whole (the X axis of partition layouts: flame, icicle and similar) MUST stay linear, while their height axis offers linear, √ and log;
- a perspective / orthographic toggle;
- orbit, zoom and reset (double-click on empty space);
- camera presets front, top and side, reachable from the orbit gizmo ([03](03-interaction-model.md)
  INT-043) and by keyboard through it;
- per-point tooltips;
- colours and type from the same tokens as 2D ([08](08-visual-language.md) VL-021);
- its 2D equivalent on `T` and the table view on `Shift+T` (VIZ-066).

*Acceptance:* Given each 3D signal view at its milestone, when the camera orbits, then the near axis
planes hide and the far ones show; each preset is reachable with the keyboard only; double-click on
empty space restores the initial pose; and `Shift+T` shows the data as a table; and in the 3D flame the X axis offers no log scale while the height axis does.

#### VIZ-079 — Latency surface
**MUST** · M-UI3 · SRE, Engineer

The latency surface MUST draw histogram buckets × time × count as a surface mesh with a height colour
map (a sequential ramp, [08](08-visual-language.md) VL-006), contour lines, an optional wireframe and
a linked colour legend, updating in place in LIVE mode. Selecting a time row or a bucket column MUST
drive two linked 2D slice charts: the distribution at time t, and that bucket over time.

*Acceptance:* Given a bimodal latency histogram over 1 h, when the user selects the row at 12:20,
then the docked 2D chart shows the distribution at 12:20 with both modes; selecting the 2 s bucket
shows that bucket's count over time; and in LIVE mode new rows appear at the front without a reload.

#### VIZ-080 — 3D columns for segments
**MAY** · M-UI5 · NOC, SRE, Business

Dash MAY offer a 3D variant of the Segments matrix: two categorical dimensions × a value as cylinder
or box columns, coloured by health. The 2D matrix MUST remain the Segments default.

*Acceptance:* Given region × tier × error rate, when the user selects the 3D variant, then each
column's height is its error rate and its colour its health; and Segments opens in 2D for a new user.

#### VIZ-081 — Waterfall of distributions
**MUST** · M-UI3 · SRE, Engineer

The waterfall of distributions MUST stack per-interval latency or size distributions along depth as
line strips with per-point gradient colour. Hover and selection MUST use a closest-to-camera hit
test and drive linked 2D slices. An orthographic toggle MUST allow reading without perspective
distortion.

*Acceptance:* Given 60 one-minute distributions, when the user hovers where two strips overlap on
screen, then the nearer strip is picked and its 2D distribution is shown; and with orthographic on,
equal values on near and far strips have equal screen heights.

#### VIZ-082 — Span point cloud
**MUST** · M-UI2 · SRE, Engineer

The span point cloud MUST draw up to 10⁷ spans as points with duration × time × a chosen attribute,
as pixel or sphere markers coloured by status, and MUST densify to a volume or heat rendering when
zoomed out so that no region becomes an unreadable blob. It is the 3D companion of the span-duration
scatter (Table 5-1).

*Acceptance:* Given 10⁷ spans, when rendered, then [09](09-performance-contract.md) PRF-017 is met;
zooming out switches to the density rendering and the coverage meter states it; and clicking a point
opens its trace.

#### VIZ-083 — 3D scatter
**SHOULD** · M-UI5 · Platform, SRE

Dash SHOULD offer a 3D scatter of three numeric attributes per entity, with marker size or colour as
a 4th or 5th channel, log axes and per-point tooltips.

*Acceptance:* Given nodes with CPU, memory and p99, when the 3D scatter opens with log p99 and size =
pod count, then each node is placed by its three values and the tooltip shows all five.

#### VIZ-084 — Imported 3D models for physical layout
**MAY** · M-UI6 · Platform, NOC

Dash MAY import glTF models for data-centre and rack geometry, used as geometry only (no textures,
[08](08-visual-language.md) VL-027) in the physical-layout variant ([15](15-estate-navigation.md)
EST-021).

*Acceptance:* Given a glTF model of a hall, when imported, then racks stand at their modelled positions
with hosts coloured by the active layer and no texture is drawn.

#### VIZ-085 — Fleet line stack
**MUST** · M-UI3 · SRE, Platform, NOC, Engineer

The fleet line stack MUST draw every member of a group (all nodes in a cluster, all pods of a
service, all instances in a pool) as its own time-series line laid along depth: X = time, Y = value,
Z = one lane per member.
- **Lanes** MUST be orderable by care score (default), name, rack/zone, or similarity clustering, and
  shown as line strips or filled ribbons.
- **Colour** per point MUST encode either the value (gradient) or health; outlier lanes MUST be lifted
  and lit while normal lanes recede into the depth fog ([08](08-visual-language.md) VL-024).
- **Navigation:** the camera orbits, zooms and dollies along depth; zoom is per axis, with wheel = time,
  `Shift`+wheel = value, `Alt`+wheel = lane depth ([03](03-interaction-model.md) §4.1); double-click
  on a lane MUST fly to it and open the linked 2D chart of that member; a brush on time MUST apply to
  all lanes.
- **Presets:** an orthographic "flat front" preset MUST turn it into an overlay of all lines and a
  "top" preset into a lane × time heatmap, each transition animated in ≤ 250 ms.
- **Linked 2D:** hovering a lane MUST highlight it and show its 2D series and value; the shared time
  cursor MUST be drawn as a plane through all lanes.
- **Data:** it MUST use the planner's per-series fetch with LOD ([T07](../technical/T07-scene-query-planner.md));
  lanes beyond the budget MUST be drawn as aggregated bands, and the coverage meter MUST say so.
- **Auto-vis:** it MUST be offered when a query returns more than 50 series of the same metric, as a
  3D alternative to band + outliers.

Mockup: [25-fleet-line-stack-3d](../mockups/25-fleet-line-stack-3d.svg).

*Acceptance:* Given 2 000 node CPU series over 6 h, when the stack opens, then it holds 60 fps median
on reference hardware (a) ([09](09-performance-contract.md) PRF-046) with band + outlier LOD on
distant lanes; `Alt`+wheel changes only lane spacing; double-click on a lane flies to it and docks
its 2D chart; "flat front" and "top" each complete in ≤ 250 ms; and with a 1 000-lane budget, the
coverage meter reads "1 000 of 2 000 lanes, rest as bands".

#### VIZ-105 — 3D flame
**MUST** · M-UI3 · Engineer, SRE

The flame graph MUST offer a true 3D form ([VIZ-086](#viz-086--true-3d-only)): boxes with X =
share, depth = stack depth and height = self or total, in an orbitable perspective scene whose top
view is the icicle, with the VIZ-078 features and a linked docked icicle. Scroll MUST dolly about
the cursor. A click on a frame or suspect MUST fly to it, and one gesture MUST return to the whole
profile. Labels MUST stay legible, tiny frames MUST merge with a count, and diff and sandwich MUST
work in 3D. Mockup: [40-flame-3d](../mockups/40-flame-3d.svg).

*Acceptance:* Given 10⁵ frames, `T` morphs to 3D in ≤ 250 ms; orbit meets
[09](09-performance-contract.md) PRF-001 on (a) and (b); a frame click frames its subtree at 80 %
and `Shift+F` shows the whole profile, each in ≤ 250 ms; labels are ≥ 11 px.

## 4. Traces, logs, profiles

**Table 5-5 — Traces, logs and profiles vis** (all M-UI2 unless marked)

| Vis | Notes | Scale |
|---|---|---|
| **Waterfall** | Critical path highlighted; collapsible by service; span events as ticks; span links; trace-to-trace diff (trace-panel parity + diff) | 50k-span traces, virtualised |
| **Span scatter** | See §1 Scatter; colour by status, service or version | 10⁷ points |
| **Trace service map** | Per-trace mini graph (the "node graph" toggle of common trace panels) | — |
| **Log stream** | GPU text (MSDF glyph atlas), virtualised; severity gutter; minimap of error density; JSON tree expand; wrap / prettify; dedupe (exact, numbers, signature); context lines around a hit | 10⁶ lines in memory, unbounded with paging |
| **Log volume** | Stacked bars by level above the stream (§1 Bars over time) | 10k bars |
| **Log patterns list** | Pattern + sparkline + count + NEW badge; diff vs baseline | — |
| **Flame graph / icicle** | Animated zoom; search highlight; diff colouring; sandwich view (callers + callees of one function); 3D flame (VIZ-105); top suspects (VIZ-106) | 10⁵+ frames |
| **Call tree / top table** | Synced with the flame graph | — |

Mockups: [07-logs-workbench](../mockups/07-logs-workbench.svg),
[08-traces-workbench](../mockups/08-traces-workbench.svg).

#### VIZ-033 — Waterfall
**MUST** · M-UI2 · SRE, Engineer

The Waterfall MUST highlight the critical path, collapse by service, show span events as ticks,
follow span links, virtualise traces of up to 50k spans, and diff two traces.

*Acceptance:* Given a 50k-span trace, when it opens, then the critical path is highlighted and
scrolling holds the frame targets; and given two selected traces, "diff" shows aligned waterfalls
with per-span duration deltas.

#### VIZ-034 — Log stream
**MUST** · M-UI2 · SRE, Engineer, Support

The Log stream MUST render as GPU text from an MSDF glyph atlas, virtualised to 10⁶ lines in memory
and unbounded with paging. It MUST provide a severity gutter, a minimap of error density, JSON tree
expand, wrap and prettify, dedupe (exact, numbers, signature) and context lines around a hit.

*Acceptance:* Given 10⁶ log lines, when the user flings the scroll from top to bottom, then frame
rate holds the targets; and each listed feature can be toggled and has a visible effect.

#### VIZ-035 — Log patterns with NEW badge
**MUST** · M-UI2 · SRE, Engineer

The Log patterns list MUST show each pattern with a sparkline and count, and MUST mark with a NEW
badge any pattern absent from the baseline window.

*Acceptance:* Given a pattern that first appears at 12:22 and a −7d baseline, when the list renders,
then the pattern carries NEW and patterns present in the baseline do not.

#### VIZ-036 — Flame graph
**MUST** · M-UI2 · Engineer, SRE

The Flame graph / icicle MUST render 10⁵+ frames with animated zoom into any frame, search highlight
of all matching frames, diff colouring, and a sandwich view; the call tree / top table MUST stay
synced with it.

*Acceptance:* Given a 10⁵-frame profile, when the user searches `json::`, then every matching frame
is highlighted and the top table filters to them; clicking a frame zooms with animation in ≤ 250 ms.

#### VIZ-106 — Flame top suspects
**MUST** · M-UI2 · Engineer, SRE

The flame graph MUST show a suspects rail whose first row is always the hottest current
frame (largest self; if no frame has self time, the non-root frame with the largest total, or the root when it
is the only frame), then up to four functions ranked by self share plus growth against the previous window,
with text badges. One action on a row MUST select its frame, bring it into view and open its
detail. Regressed functions MUST glow in proportion to growth ([08](08-visual-language.md) VL-004).

*Acceptance:* Given any non-empty profile, when it opens, then ① is the largest-self current
frame (or, with no self time, the largest-total non-root frame, the root only when it is the sole frame) and one click on ① (or `Tab`) shows its detail; a function that grew from 9 % to 18 % is
REGRESSED and glows.

## 5. Categorical & single-value

**Table 5-6 — Categorical & single-value vis**

| Vis | Use | Notes | Scale | Milestone |
|---|---|---|---|---|
| **Bar chart** (categorical X) | Top-N routes, errors by version, cost by team | Horizontal/vertical, grouped/stacked, value labels, sorted by value by default; bars are clickable filters | — | M-UI2 |
| **Bar gauge** | Many values against one scale (disk % per host, quota per tenant) | Basic / gradient / LCD-segment modes; threshold colours; unfilled track shows headroom | 2 000 rows virtualised | M-UI5 |
| **Gauge** (radial) | One value against thresholds on a wall/NOC | Supported for parity with incumbent dashboard tools, but the auto-vis prefers **Bullet** (more precise per pixel) | — | M-UI5 |
| **Bullet** | Value + target + qualitative ranges (SLO target, capacity) | Default for "value vs threshold" | — | M-UI1 |
| **Pie / donut** | Proportions, ≤ 6 parts | Allowed but guarded: > 6 slices auto-switches to a bar chart, with a notice. Never 3D | — | M-UI5 |
| **Stat** | §1 Stat; grid of stats with colour mode (value / background), text mode, graph mode, orientation | — | — | M-UI5 (grid) |
| **Radar** | Multi-dimension score per entity (golden signals vs baseline) | Plugin parity; de-emphasised | — | M-UI5 |
| **Value-mapped text** | Status words ("PRIMARY", "DEGRADED") | Through value mappings (§10) | — | M-UI5 |

#### VIZ-037 — Bars are filters
**MUST** · M-UI2 · SRE, Engineer, Business

A categorical bar chart MUST sort by value by default, and clicking a bar MUST filter the scene to
that category.

*Acceptance:* Given errors by version, when the chart renders, then bars are sorted descending; and
when the user clicks `2.31`, then every viewport in the scene filters to `version=2.31`.

#### VIZ-038 — Pie guard
**MUST** · M-UI5 · Business, NOC

A pie or donut with more than 6 slices MUST automatically render as a bar chart and MUST show a
notice saying so. A pie MUST NOT be rendered in 3D.

*Acceptance:* Given a pie query returning 9 categories, when it renders, then a bar chart is shown
with the notice "9 parts: shown as bars".

#### VIZ-039 — Bullet preferred for value vs threshold
**MUST** · M-UI1 · NOC, SRE, Business

When a single value has a threshold or target, the auto-vis MUST pick Bullet, not Gauge. Gauge MUST
remain available when chosen explicitly or imported.

*Acceptance:* Given a single-value query with a threshold, when the auto-vis runs, then a Bullet is
shown; and given an imported gauge panel, then a Gauge is shown.

#### VIZ-095 — Stat baseline delta
**MUST** · M-UI1 · SRE, NOC, Business

A stat with a baseline offset MUST show the change of its value against the same query over the
window shifted back by that offset: an arrow and a signed percentage in a neutral colour, with the
baseline value and offset in its tooltip. When the baseline is missing, zero or not finite, the stat
MUST show its value without a delta and say why in its tooltip.

*Acceptance:* Given a stat at 120/s with baseline offset 1d where the shifted window gives 100/s,
then it shows `▲ 20 %` and the tooltip says `100/s 1 d ago`; and given a shifted value of 0, then no
delta is shown and the tooltip says `No baseline: 0 1 d ago`.

## 6. Tables

The table is a first-class vis, not an afterthought. In practice it is the most-used panel type in
enterprise dashboards. It is a **DOM** vis for ≤ 10k rows and a GPU text grid above that.

**Table 5-7 — Table cell types**

| Group | Cell types |
|---|---|
| Incumbent-tool parity | auto; coloured text; coloured background (basic or gradient, optionally the whole row); gauge (basic / gradient / LCD); sparkline; JSON view; pill / tags; Markdown (sanitised, always); image; data link; action button |
| Pulsus additions | entity chip with health glyph and hover Lens preview; state glyph (five-state scale, [08](08-visual-language.md)); inline mini-heatmap; delta vs baseline with arrow and significance; **pivot chips per row** |

#### VIZ-040 — Table cell types
**MUST** · M-UI5 · Engineer, SRE, Platform, Business

The table MUST support every cell type in Table 5-7.

*Acceptance:* Given an imported table panel using each parity cell type, when it renders, then
each column renders with the equivalent cell type; and an entity column renders as entity chips
whose hover shows a Lens preview.

#### VIZ-041 — Table interactions
**MUST** · M-UI5 · Engineer, SRE, Platform, Support

The table MUST provide:
- column filters (contains/regex, expression, comparison);
- multi-column sort;
- frozen columns;
- column resize, reorder and hide;
- grouped rows and nested tables;
- footer calculations (sum, mean, p95…) on all or filtered rows;
- pagination or virtual scroll;
- text wrap;
- copy as TSV or Markdown;
- export as CSV or Parquet.

*Acceptance:* Given a 5 000-row table, each listed interaction can be performed and is reflected in
the copy and export outputs (e.g. exporting after a filter exports only filtered rows).

#### VIZ-042 — Rows are selection sources
**MUST** · M-UI1 · SRE, Engineer, Platform

Clicking a table row whose key is an entity or span MUST select it in the scene, so that every other
viewport highlights it, exactly as clicking a chart mark does.

*Acceptance:* Given a table of pods next to a small-multiples viewport, when the user clicks a row,
then the matching tile is highlighted and the Inspector shows that pod.

#### VIZ-043 — GPU text grid above 10k rows
**MUST** · M-UI5 · Engineer, Platform

A table with more than 10 000 rows MUST switch to the GPU text grid (the same MSDF text as logs) and
MUST scroll 10⁶ rows at the frame targets, keeping the interactions of VIZ-041.

*Acceptance:* Given a 10⁶-row result, when the user scrolls end to end, then frame rate holds the
targets and sorting by a column completes without a long task over 16 ms on the main thread.

## 7. Geospatial

**Table 5-8 — Geospatial layers**

| Layer | Use | Notes | Milestone |
|---|---|---|---|
| **Markers** | Sites, PoPs, data centres, edge nodes | Size/colour/symbol/rotation from fields; text labels; clustering at low zoom; target 10⁵ markers, with at most 5 000 drawn in the 2D core and the rest disclosed by the coverage meter (VIZ-027) | M-UI3 |
| **Heatmap / hexbin** | User error density, RUM latency by geo | GPU splat; re-binned per zoom | M-UI5 |
| **Choropleth (GeoJSON regions)** | Country/state/region health, revenue at risk by market | Style rules by feature property; bundled world/country shapes | M-UI5 |
| **Routes / arcs** | Traffic between regions, replication lag, CDN → origin | Great-circle arcs with flow particles (same pipeline as Atlas edges) | M-UI3 |
| **Network on map** | Service graph or WAN topology placed geographically | Node-graph data + coordinates (network-layer parity with existing geomap panels) | M-UI5 |
| **Day/night terminator** | Follow-the-sun NOC context | — | M-UI5 |
| **Track / last-position** | Moving assets (fleet, IoT) | Icon at last point + trailing route | M-UI5 |

#### VIZ-044 — Geospatial layers
**MUST** · M-UI3 · NOC, Business, Platform

The geomap MUST support each layer in Table 5-8 from its listed milestone.

*Acceptance:* For each row at its milestone, given matching data, when the layer is enabled, then it
renders with the listed notes (e.g. markers cluster at low zoom and separate when zoomed in).

*Staging (#184, [T24](../technical/T24-geo-schematic-and-widget-panels.md#t24-091--camera-and-picking)):*
step 1b ships the Markers row in the 2D geomap: size and colour from fields, a symbol per panel, text
labels and clustering, with at most 5 000 drawn markers (the T22-006 cap, disclosed by the coverage
meter); symbol and rotation from fields follow with part G (#186). The acceptance is unchanged.

#### VIZ-045 — Location sources
**MUST** · M-UI3 · NOC, Platform

The geomap MUST resolve locations by auto-detection (lat/lon, geohash, lookup fields), explicit
coordinates, geohash, and a lookup gazetteer covering ISO country codes, region codes, airport/IATA
codes and cloud region ids (e.g. `eu-west-1`).

*Acceptance:* Given a series labelled `cloud.region="eu-west-1"` with no coordinates, when it is put
on a map, then it is placed at the AWS Ireland region without configuration.

#### VIZ-046 — Own basemap renderer, offline basemap
**MUST** · M-UI3 · NOC, Admin

Basemaps MUST be vector tiles drawn by the Dash wgpu renderer, with no JS map library. Basemap sources
MUST be pluggable (OSM vector-tile styles, XYZ raster, customer-hosted tiles). A low-detail basemap MUST
be bundled for air-gapped installs ([11](11-enterprise.md)).

*Acceptance:* Given an install with no outbound network, when a map opens, then the bundled basemap
renders with country outlines and no failed network requests.

*Staging (#184, [T24](../technical/T24-geo-schematic-and-widget-panels.md#t24-087--delivery-validation)):*
step 1a bundles the offline data (country outlines, coast and border lines, and the gazetteer) as
same-origin assets; step 1b draws it in the 2D geomap; the pluggable basemap sources are part F
(#185); drawing with the wgpu renderer follows #68. The acceptance is unchanged.

#### VIZ-047 — Maps share the camera and Context
**MUST** · M-UI3 · NOC, Platform

Maps MUST use the shared camera model ([03](03-interaction-model.md)), MUST support view sync
across viewports, and MUST be able to write the visible bounds into Context as a filter (parity with the
"sync view to variable" option of existing geomap panels).

*Acceptance:* Given two synced map viewports, when one pans, then the other follows; and with "bounds
as filter" on, when the user zooms to Europe, then other viewports filter to entities inside the
bounds.

*Note (#184 step 2, [T24](../technical/T24-geo-schematic-and-widget-panels.md#t24-097--sync)):* on
a board, maps with `sync` on share one view in the board URL (`map=*_…`) and follow each other's
committed moves; with `boundsFilter` on, a map writes its visible bounds as the board's map area
(`geo=`), a filter like `f=`. The other panels keep only the returned series inside the area, by the
same location rules as the geomap, and disclose the rest on the coverage meter; log lines, traces,
profiles and scalars are not filtered yet and say so (T24-098, §4.15). Explore has no maps yet. The
acceptance is unchanged.

## 8. Schematics (canvas and flowchart panel equivalent)

NOC and operations teams draw their own diagrams: a factory line, a payment rail, a network rack, a
call-centre floor. Incumbent dashboard tools do this with a canvas panel and flowchart/diagram plugins. Pulsus
**Schematic** covers it with an editor (DOM room + canvas), data binding, auto-generation, import
and audited actions. All schematic requirements land in M-UI5.

#### VIZ-048 — Schematic editor
**MUST** · M-UI5 · NOC, Platform

The Schematic editor MUST provide:
- shapes, text, icons (custom SVG) and images;
- metric value, server/rack and entity tile elements (an entity tile shows that entity's live health);
- connectors anchored between elements, with direction, dash style and animated flow bound to a metric;
- constraints/anchoring, alignment, snap, layers and groups.

*Acceptance:* Given a blank schematic, a user can place each element type, connect two elements with
an anchored connector whose flow speed is bound to a metric, and the connector stays attached when
either element moves.

#### VIZ-049 — Schematic data binding to fields and entities
**MUST** · M-UI5 · NOC, Platform, IC

Any element property (colour, size, text, visibility, rotation, flow speed) MUST be bindable to a
field through thresholds, value mappings or expressions. Elements MUST be bindable to entities; an
entity-bound element MUST open that entity's Lens and MUST join the incident causal-path highlight
([06](06-ai-copilot.md)).

*Acceptance:* Given an element bound to `payments`, when an incident's causal path includes
`payments`, then the element is highlighted as on-path; and clicking it opens the payments Lens.

#### VIZ-050 — Auto-schematic
**SHOULD** · M-UI5 · NOC, Platform

The editor SHOULD generate a starting layout from a Journey or a topology subgraph, which the user
then edits.

*Acceptance:* Given the Checkout journey, when the user chooses "Generate from journey", then a
schematic with one entity-bound element per step and connectors between them is created.

#### VIZ-051 — Schematic import
**MUST** · M-UI5 · NOC, Admin

Schematic MUST import canvas-panel JSON from existing dashboards, and SVG and draw.io files with element IDs mapped to
bindings (flowchart-plugin parity).

*Acceptance:* Given an existing canvas panel and a flowchart-plugin draw.io diagram, when imported, then
elements, positions and bindings are preserved and unmapped items are listed in the import report.

#### VIZ-052 — Schematic actions are audited
**MUST** · M-UI5 · NOC, Admin

Schematic element buttons MUST trigger only the audited, RBAC-checked actions of the Act surface
([04](04-surfaces.md), [11](11-enterprise.md)). They MUST NOT issue unauthenticated raw HTTP calls.

*Acceptance:* Given a button bound to a restart action, when a user without the action's permission
clicks it, then it is refused; when a permitted user clicks it, the action runs and an audit entry
is written; and the schematic schema has no raw-HTTP action type.

> **Rationale:** a deliberate departure from the canvas panels of incumbent tools, whose buttons can call arbitrary URLs.

## 9. Widgets (board furniture)

**Table 5-9 — Widgets** (all M-UI5)

| Widget | Incumbent-tool equivalent | Notes |
|---|---|---|
| **Alert / incident list** | Alert list | Grouped by incident (not raw alerts); filters by team, severity, state; salience-aware on walls |
| **Change feed** | Annotations list | Deploys, config changes, flags, annotations; filter by entity in Context |
| **Board list** | Dashboard list | Starred / recent / search / tag; "used during incidents" ranking |
| **Text / Markdown** | Text | Markdown with `{{entity}}`/Context variables; HTML always sanitised (no raw HTML or script) |
| **Feed** | News | RSS/Atom fetched by the BFF (never by the browser), plus vendor status pages (cloud provider, PSP), which are more useful to operations than news |
| **Clock / time zones** | (plugin: Clock) | Multi-zone NOC clock; countdown to maintenance window |
| **On-call / roster** | (on-call tool panels) | Who is on call now/next per team; link to page |
| **Entity list** | — | Live list of entities matching a filter, sorted by care score |
| **Journey row** | — | [04](04-surfaces.md) §4.14 |
| **Embedded Investigation** | — | Live card of an open investigation |

Mockup: [14-board](../mockups/14-board.svg).

#### VIZ-053 — Widgets available
**MUST** · M-UI5 · NOC, SRE, Business, IC

Each widget in Table 5-9 MUST be available as a board viewport with the behaviour in its Notes
column.

*Acceptance:* For each row, given a board, the widget can be added and shows live content (e.g. the
alert list groups three alerts of one incident under one row).

#### VIZ-054 — Markdown and HTML are always sanitised
**MUST** · M-UI1 · Admin, Engineer

Any Markdown or HTML rendered by any vis or widget (table Markdown cells, Text widget, Feed items,
tooltips) MUST be sanitised. Raw HTML and script MUST NOT execute.

*Acceptance:* Given a Text widget containing `<script>` and an `onerror=` image, when rendered, then
neither executes and the sanitiser logs the removal.

#### VIZ-055 — Feeds are fetched server-side
**MUST** · M-UI5 · Admin, NOC

The Feed widget MUST fetch RSS/Atom and vendor status pages through the BFF. The browser MUST NOT
contact the feed origin.

*Acceptance:* Given a Feed widget, when the board loads, then the browser's network log shows no
request to the feed's origin and the items are delivered by the BFF.

#### VIZ-056 — No arbitrary iframes
**MUST** · M-UI1 · Admin

No vis or widget MAY embed an iframe of an arbitrary site. Links MUST open in a new tab instead.

*Acceptance:* Given an imported panel containing an iframe, when imported, then it becomes a
link that opens in a new tab and the import report notes the change.

> **Rationale:** iframes weaken the CSP and break the single-scene model.

## 10. Vis configuration (field-config parity)

These are needed for 1:1 dashboard import and expected by every power user.

**Table 5-10 — Field configuration**

| Feature | Notes | Milestone |
|---|---|---|
| **Units & formatting** | Full unit catalogue (SI/IEC bytes, durations, rates, currency, percent, custom), decimals, min/max | M-UI1 |
| **Thresholds** | Absolute / percentage; colour steps; drawn as lines/areas; drag to edit, which shares a gesture with alert authoring ([07](07-alerting.md)) | M-UI1 |
| **Value mappings** | Value / range / regex / special (null, NaN, true/false) → text + colour + icon | M-UI5 |
| **Overrides** | By field name, regex, type, query, or value; any property | M-UI5 |
| **Data links** | URL templates with field/Context variables; **pivot chips** are the structured, preferred form | M-UI5 |
| **Transformations** | Reduce, join (by field / time / labels), merge, group-by, pivot ("rows to fields"), organise/rename, filter by value, calculate field (binary/unary/expressions), sort, limit, histogram, partition, config-from-query, extract fields (JSON/logfmt/regex), labels-to-fields, concatenate, series-to-rows | M-UI5 |
| **Legends** | List / table, placement, values (last, mean, max…), click to isolate, shift-click to multi-select | M-UI1 |
| **Tooltips** | Single / all / hidden; sort; pinned tooltips (click to keep); tooltip from field | M-UI1 |
| **Repeat** | Repeat viewport per variable value or per entity; the Lens and small-multiples mechanism generalises it | M-UI5 |

#### VIZ-057 — Field configuration parity
**MUST** · M-UI1 · Engineer, SRE, Admin

Every feature in Table 5-10 MUST be available from its listed milestone and MUST give identical
formatted output in the browser and in the headless server-side renderer; both implementations MUST
pass one shared fixture corpus of inputs and expected outputs.

*Acceptance:* Given an imported panel using units, thresholds, value mappings and overrides,
when rendered in the browser and when rendered headless by the BFF, then both outputs are identical
and match the source tool's formatting of the same values.

#### VIZ-058 — Transformations run locally, push down when possible
**MUST** · M-UI5 · Engineer

Transformations MUST execute in the local WASM engine
([T01](../technical/T01-frontend-architecture.md) §3). The scene query planner
([T07](../technical/T07-scene-query-planner.md)) MUST push a transformation down to PulsusDB or the
BFF when an equivalent server-side operation exists.

*Acceptance:* Given a "group-by + reduce" transformation that PromQL can express, when the board
loads, then the query sent to PulsusDB includes the aggregation; and given a "join by field" that it
cannot express, then the join runs in the browser and the result is the same.

#### VIZ-059 — Threshold drag shares the alert gesture
**MUST** · M-UI4 · SRE, Engineer

Dragging a threshold on a chart MUST use the same gesture and handles as dragging an alert condition
in the rule editor ([07](07-alerting.md)).

*Acceptance:* Given a viewport with a threshold, when the user drags it and chooses "Create alert",
then the rule editor opens with the threshold value prefilled.

## 11. Panel parity map

This table is **normative**: dashboard import MUST map each standard panel type to the listed equivalent.
It was checked against the published visualisation lists of incumbent dashboard tools
on 2026-11-18 (25 standard types).

**Table 5-11 — Standard panel parity**

| Standard panel type | Pulsus equivalent | Pulsus difference |
|---|---|---|
| Time series | §1 Line / Area / Bars over time | 10⁸ points; band+outliers; baseline/anomaly/forecast overlays |
| State timeline | §1 State timeline | Same, plus click → state transition evidence |
| Status history | §1 Status history | Same, plus worst-wins re-binning |
| Bar chart | §5 Bar chart | Bars are filters |
| Histogram | §2 Histogram | Compare overlay A/B |
| Heatmap | §1 Heatmap | Brush → Universal Compare; 3D landscape toggle |
| Pie chart | §5 Pie / donut | Guarded at ≤ 6 slices |
| Candlestick | §1 Box / OHLC over time | Also used for latency distribution per step |
| Gauge | §5 Gauge (Bullet preferred) | — |
| Trend | §2 Trend | Capacity curves |
| XY chart | §2 XY chart | Regression; 10⁷ points |
| Stat | §1/§5 Stat | Baseline delta built in |
| Bar gauge | §5 Bar gauge | Virtualised to 2 000 rows |
| Table | §6 Table | Entity chips, pivots, GPU grid for 1M rows |
| Logs | §4 Log stream + volume + patterns | GPU text; patterns NEW vs baseline |
| Node graph | §3 Graph | It *is* the Atlas; 10k nodes |
| Traces | §4 Waterfall + trace map | Trace diff; critical path |
| Flame graph | §4 Flame / icicle | Diff, sandwich, flame landscape over time |
| Canvas | §8 Schematic | Entity binding, audited actions, auto-schematic |
| Geomap | §7 Geospatial | Own wgpu tile renderer; cloud-region gazetteer; offline basemap |
| Dashboard list | §9 Board list | Incident-usage ranking |
| Alert list | §9 Alert / incident list | Incident-grouped |
| Annotations list | §9 Change feed | Includes derived deploys/config changes |
| Text | §9 Text / Markdown | Always sanitised |
| News | §9 Feed | BFF-fetched; vendor status pages |

**Table 5-12 — Common panel plugins covered**

| Plugin kind | Pulsus equivalent |
|---|---|
| Hexagon status grid | §3 Heat grid / hexbin wall |
| Flowchart / diagram | §8 Schematic |
| Clock | §9 Clock |
| Sankey | §2 Funnel / Sankey |
| Treemap | §2 Treemap |
| General-purpose JS chart wrappers | §2 and §5; radar, parallel coordinates, sunburst and calendar are first-class. No arbitrary-JS escape hatch |
| World map | §7 Geospatial |
| Discrete / Gantt | §1 State timeline |

#### VIZ-060 — Standard panel types import 1:1
**MUST** · M-UI5 · Admin, Engineer, SRE

Dashboard import ([04](04-surfaces.md) §4.3) MUST map each standard panel type in Table
5-11 to its listed Pulsus equivalent, preserving queries, field configuration (§10) and layout.

*Acceptance:* Given a corpus dashboard containing one panel of each of the 25 standard types, when
imported, then the import report shows 25 of 25 mapped, and each panel renders with the listed
equivalent vis.

*Staging (#184 step 2, [T24](../technical/T24-geo-schematic-and-widget-panels.md#t24-099--auto-vis-row-8-import)):*
the Geomap row's options mapping is designed in T24 §4.19 and ships at M-UI3 as a pure function
(`importGeomap`, every output valid board spec v8, with ordered import notes); the corpus acceptance
runs at M-UI5 with the dashboard import (#158). Layers other than markers are noted as not mapped
yet (part G). The acceptance is unchanged.

#### VIZ-061 — Common plugins import
**MUST** · M-UI5 · Admin, NOC

Dashboard import MUST map each plugin in Table 5-12 to its listed equivalent.

*Acceptance:* Given panels of each plugin in Table 5-12, when imported, then each maps to its listed
equivalent and the import report marks them mapped.

#### VIZ-062 — Unknown plugin fallback
**MUST** · M-UI5 · Admin, Engineer

A panel of a plugin not covered by Tables 5-11 or 5-12 MUST import as a Table of the same query, with
a "could not map" note in the import report.

*Acceptance:* Given a panel of an unknown plugin type, when imported, then a table viewport runs the
panel's query and the import report lists the panel under "could not map" with its plugin id.

#### VIZ-063 — Declarative vis spec for third parties
**SHOULD** · M-UI5 · Engineer, Admin

Because third-party JavaScript in the page would bypass the CSP and dependency controls
([ADR-0014](../adr/0014-typescript-react-web-client.md) §7, §9; [T18](../technical/T18-security.md)),
which rules out React-based panel plugins of the kind incumbent tools use, third-party vis SHOULD be
authored as a declarative vis spec
(marks + encodings, in the grammar-of-graphics style) compiled to the mark pipelines. There MUST NOT be an
arbitrary-JS vis extension point.

*Acceptance:* Given a third-party spec for a bespoke chart, when loaded, then it renders through the
mark pipelines with the universal interactions; and no API accepts JS code for a vis.

#### VIZ-064 — Sandboxed WASM vis modules
**MAY** · M-UI6 · Engineer, Admin

Dash MAY load sandboxed WASM vis modules written against a stable mark/scene API. Such a module MUST
have no DOM access and MUST be capability-scoped.

*Acceptance:* Given a WASM vis module that attempts DOM or network access, when loaded, then the
attempt fails and the module still renders through the mark API.

## 12. Auto-vis decision

The auto-vis picks a vis from the data shape and the Perspective. Rules are evaluated top to bottom;
the first match wins.

**Table 5-13 — Auto-vis rules**

| # | Data shape | Vis |
|---|---|---|
| 1 | Entity set (no query) | Lens template for the entity type |
| 2 | Signal = profiles | Flame graph |
| 3 | Signal = spans | Scatter (duration × time) + RED summary |
| 4 | Signal = logs, lines > 10k | Volume + patterns (stream on demand) |
| 5 | Metric type = histogram | Heatmap (+ p50/p95/p99 lines option) |
| 6 | Metric type = counter | `rate()` line |
| 7 | Query returns 1 series, 1 value | Stat (Bullet if a threshold/target exists) |
| 8 | Has geo fields / region codes | Geomap |
| 9 | State-like values (enum/bool) | State timeline (Status history if regular step) |
| 10 | Series count > 50 | Band + outliers (or small multiples if the user picked "breakdown") |
| 11 | Reduced to N categories | Bar chart (pie only if ≤ 6 and parts sum to a whole) |
| 12 | Two numeric non-time fields | XY chart (Trend if X is sequential) |
| 13 | Result has many columns | Table |
| 14 | Otherwise (gauge-type metric, time series) | Line |

#### VIZ-065 — Auto-vis rules
**MUST** · M-UI1 · SRE, Engineer, NOC, Business

When a viewport's vis is "auto", Dash MUST pick the vis by applying Table 5-13 top to bottom and
taking the first match, restricted to the vis available at the current milestone. A Perspective MAY
change the encoding preset (e.g. wall density) but MUST NOT change which rule matches. The user MUST
be able to override the choice, and the override MUST persist with the viewport.

*Acceptance:* Given a fixture query per row of Table 5-13, when each is run with vis "auto", then
the listed vis is chosen; and after the user switches one to Table, reloading keeps Table.

*Staging (#184 step 2, [T24](../technical/T24-geo-schematic-and-widget-panels.md#t24-099--auto-vis-row-8-import)):*
row 8 ships at M-UI3 on boards, after rows 5–7: at least 2 series, at least half of them with a
non-empty location label (the T24 §4.10 aliases; no gazetteer lookup, so the choice never changes
when the map data loads) → Geomap. Panels stored before board spec v8 are marked `legacyAuto` and
keep their vis until the panel is edited and saved (the editor previews row 8 first), so no stored
board switches silently. Explore does not apply row 8 yet. The acceptance is unchanged.

## 13. Accessibility of data vis

#### VIZ-066 — Table view and CSV for every vis
**MUST** · M-UI1 · Engineer, SRE, Business, Admin

Every vis MUST offer a table view of its data with `Shift+T` and an exportable CSV of the same data.

*Acceptance:* Given any viewport, when the user presses `Shift+T`, then the same data appears as a
table, and "Export CSV" downloads it.

#### VIZ-067 — Colour is never the only channel
**MUST** · M-UI1 · NOC, SRE, Business

State and series identity (per group for spatial marks grouped by `groupBy`; the series of a group
then differ in the tooltip, the table and the Inspector) MUST be encoded by a second channel (shape,
ring, pattern or glyph) in addition to colour ([08](08-visual-language.md)).

*Acceptance:* Given any vis showing state, when rendered with a greyscale filter, then every state
and every series or group is still distinguishable.

#### VIZ-068 — Screen-reader summary per viewport
**MUST** · M-UI6 · Business, Engineer

Every viewport MUST expose a generated screen-reader summary describing what changed, when, and the
current value against baseline (e.g. "p99 latency, checkout, rose from 0.4 s to 2.8 s at 12:22,
currently 2.1 s, 7× baseline").

*Acceptance:* Given the storyboard incident, when a screen reader focuses the checkout p99 viewport,
then it reads a summary containing the metric, entity, change, onset time, current value and
baseline ratio.

## 14. Showcase gallery

Dash ships a **public vis gallery**. It has three jobs:
1. **Sales/demo:** it shows the speed and the axis/interaction depth without needing a PulsusDB.
2. **Documentation:** every spec option has a runnable example.
3. **Test corpus:** every gallery page is also a golden-image test and a frame-time benchmark
   ([T05](../technical/T05-testing-and-performance.md) §4.2–4.3), so the gallery can never drift from
   what ships.

Mockup: [16-gallery](../mockups/16-gallery.svg).

#### VIZ-069 — Gallery is the vis test corpus
**MUST** · M-UI1 · Engineer

Every vis and every axis or interaction pattern (§1.1) MUST have a gallery page, added in the same
milestone as the vis. Every gallery page MUST run in CI as a golden-image test and a frame-time
benchmark at its target volume from [09](09-performance-contract.md) §3.

*Acceptance:* Given the CI run for a milestone, when it completes, then every vis listed for that
milestone in Tables 5-1 to 5-10 and every Table 5-2 row has a gallery page with a passing golden-image
test and a frame-time result.

#### VIZ-070 — Gallery runs on seeded synthetic data
**MUST** · M-UI1 · Engineer, Business

Each gallery page MUST run live on seeded synthetic telemetry at the vis's target volume, without a
PulsusDB, and MUST produce the same frames for the same seed.

*Acceptance:* Given the gallery started with no PulsusDB reachable, when any page opens, then it
renders at its target volume; and two runs with the same seed produce identical golden images.

#### VIZ-071 — Public gallery at /gallery
**MUST** · M-UI5 · Business, Engineer

The gallery MUST be served at `/gallery` by every install and MUST also be bundled offline in the
binary.

*Acceptance:* Given an air-gapped install, when a user opens `/gallery`, then every page loads with
no outbound requests.

#### VIZ-072 — Gallery page controls
**MUST** · M-UI5 · Engineer, Business

Each gallery page MUST provide:
- the declarative spec, editable in place, with a live re-render;
- a live fps / frame-time and point-count readout;
- a tier switch (WebGPU / WebGL2) and a theme switch;
- a "use in a board" button that copies the spec.

*Acceptance:* Given a gallery page, when the user edits a colour in the spec, then the vis re-renders
within one second; the readout shows fps and point count; switching to WebGL2 re-renders on that
tier; and "use in a board" puts a spec on the clipboard that renders identically when pasted into a
board.

## 15. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| VIZ-001 | GPU rendering by one shared engine | MUST | M-UI0 |
| VIZ-002 | Every vis is a composition of shared mark primitives | MUST | M-UI0 |
| VIZ-003 | Universal interactions on every vis | MUST | M-UI1 |
| VIZ-004 | Scale targets per vis | MUST | M-UI0 |
| VIZ-005 | LOD never hides signal silently | MUST | M-UI0 |
| VIZ-006 | Line decimation is visually lossless | MUST | M-UI0 |
| VIZ-007 | Band collapses the crowd and keeps outliers | MUST | M-UI1 |
| VIZ-008 | Scatter density and point modes | MUST | M-UI0 |
| VIZ-009 | State merging rules | MUST | M-UI3 |
| VIZ-010 | Line, area and bar style options | MUST | M-UI1 |
| VIZ-011 | Overlays on any time vis | MUST | M-UI1 |
| VIZ-012 | Exemplars link to traces | MUST | M-UI2 |
| VIZ-013 | Axes are first-class objects | MUST | M-UI1 |
| VIZ-014 | Axis patterns and default triggers | MUST | M-UI1 |
| VIZ-015 | Time-shifted comparison axis | MUST | M-UI1 |
| VIZ-016 | Align on onset | SHOULD | M-UI3 |
| VIZ-017 | Stacked lanes in one viewport | MUST | M-UI2 |
| VIZ-018 | Axis count hint | MUST | M-UI1 |
| VIZ-019 | Axis colour and ownership glyph | MUST | M-UI1 |
| VIZ-020 | Per-axis interaction | MUST | M-UI1 |
| VIZ-021 | Crosshair reads every bound axis | MUST | M-UI1 |
| VIZ-022 | Overlays declare their axis | MUST | M-UI1 |
| VIZ-023 | Static X axis on walls | MUST | M-UI5 |
| VIZ-024 | Discontinuous time axis is never silent | MUST | M-UI5 |
| VIZ-025 | Universal Compare | MUST | M-UI3 |
| VIZ-026 | Compare answers locally first | MUST | M-UI3 |
| VIZ-027 | Coverage meter on every viewport | MUST | M-UI1 |
| VIZ-028 | Distribution vis available | MUST | M-UI3 |
| VIZ-029 | Graph layout is stable and incremental | MUST | M-UI3 |
| VIZ-030 | Graph clustering LOD and truncation honesty | MUST | M-UI3 |
| VIZ-031 | 3D only when it encodes a dimension | MUST | M-UI3 |
| VIZ-032 | Heat grid semantic zoom | MUST | M-UI3 |
| VIZ-033 | Waterfall | MUST | M-UI2 |
| VIZ-034 | Log stream | MUST | M-UI2 |
| VIZ-035 | Log patterns with NEW badge | MUST | M-UI2 |
| VIZ-036 | Flame graph | MUST | M-UI2 |
| VIZ-037 | Bars are filters | MUST | M-UI2 |
| VIZ-038 | Pie guard | MUST | M-UI5 |
| VIZ-039 | Bullet preferred for value vs threshold | MUST | M-UI1 |
| VIZ-040 | Table cell types | MUST | M-UI5 |
| VIZ-041 | Table interactions | MUST | M-UI5 |
| VIZ-042 | Rows are selection sources | MUST | M-UI1 |
| VIZ-043 | GPU text grid above 10k rows | MUST | M-UI5 |
| VIZ-044 | Geospatial layers | MUST | M-UI3 |
| VIZ-045 | Location sources | MUST | M-UI3 |
| VIZ-046 | Own basemap renderer, offline basemap | MUST | M-UI3 |
| VIZ-047 | Maps share the camera and Context | MUST | M-UI3 |
| VIZ-048 | Schematic editor | MUST | M-UI5 |
| VIZ-049 | Schematic data binding to fields and entities | MUST | M-UI5 |
| VIZ-050 | Auto-schematic | SHOULD | M-UI5 |
| VIZ-051 | Schematic import | MUST | M-UI5 |
| VIZ-052 | Schematic actions are audited | MUST | M-UI5 |
| VIZ-053 | Widgets available | MUST | M-UI5 |
| VIZ-054 | Markdown and HTML are always sanitised | MUST | M-UI1 |
| VIZ-055 | Feeds are fetched server-side | MUST | M-UI5 |
| VIZ-056 | No arbitrary iframes | MUST | M-UI1 |
| VIZ-057 | Field configuration parity | MUST | M-UI1 |
| VIZ-058 | Transformations run locally, push down when possible | MUST | M-UI5 |
| VIZ-059 | Threshold drag shares the alert gesture | MUST | M-UI4 |
| VIZ-060 | Standard panel types import 1:1 | MUST | M-UI5 |
| VIZ-061 | Common plugins import | MUST | M-UI5 |
| VIZ-062 | Unknown plugin fallback | MUST | M-UI5 |
| VIZ-063 | Declarative vis spec for third parties | SHOULD | M-UI5 |
| VIZ-064 | Sandboxed WASM vis modules | MAY | M-UI6 |
| VIZ-065 | Auto-vis rules | MUST | M-UI1 |
| VIZ-066 | Table view and CSV for every vis | MUST | M-UI1 |
| VIZ-067 | Colour is never the only channel | MUST | M-UI1 |
| VIZ-068 | Screen-reader summary per viewport | MUST | M-UI6 |
| VIZ-069 | Gallery is the vis test corpus | MUST | M-UI1 |
| VIZ-070 | Gallery runs on seeded synthetic data | MUST | M-UI1 |
| VIZ-071 | Public gallery at /gallery | MUST | M-UI5 |
| VIZ-072 | Gallery page controls | MUST | M-UI5 |
| VIZ-073 | 3D layered topology for large graphs | MUST | M-UI3 |
| VIZ-074 | Containment world vis | MUST | M-UI3 |
| VIZ-075 | 3D edges are arcs with traffic particles | MUST | M-UI3 |
| VIZ-076 | 3D labels are billboards with leader lines | MUST | M-UI3 |
| VIZ-077 | Space is 3D, signals are 2D, and both are linked | MUST | M-UI3 |
| VIZ-078 | Shared 3D chart features | MUST | M-UI3 |
| VIZ-079 | Latency surface | MUST | M-UI3 |
| VIZ-080 | 3D columns for segments | MAY | M-UI5 |
| VIZ-081 | Waterfall of distributions | MUST | M-UI3 |
| VIZ-082 | Span point cloud | MUST | M-UI2 |
| VIZ-083 | 3D scatter | SHOULD | M-UI5 |
| VIZ-084 | Imported 3D models for physical layout | MAY | M-UI6 |
| VIZ-085 | Fleet line stack | MUST | M-UI3 |
| VIZ-086 | True 3D only | MUST | M-UI3 |
| VIZ-090 | Histogram and cumulative overlay | MUST | M-UI3 |
| VIZ-095 | Stat baseline delta | MUST | M-UI1 |
| VIZ-105 | 3D flame | MUST | M-UI3 |
| VIZ-106 | Flame top suspects | MUST | M-UI2 |

## 16. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft |
| 1.0-rc2 | 2026-11-18 | 3D-first estate per owner brief: §3 intro, Table 5-4 rows (Graph, City, Globe, Heat grid, 3D surface; Floors added), VIZ-031 and VIZ-032 edited in place; VIZ-073 to VIZ-077 added; §3.1 3D signal views (Table 5-4a, VIZ-078 to VIZ-085, incl. the fleet line stack) added (R11–R13) |
| 1.1-rc | 2026-11-19 | Decisions D7 and D8 (roadmap Q13): GPU vis and DOM vis definitions; VIZ-001 revised in place (one shared engine and GPU device, one canvas per viewport, DOM vis in React, interim-renderer note); VIZ-057 parity by shared fixtures instead of one shared Rust implementation (the BFF is Go); VIZ-063 rationale no longer cites the JS shim (R14) |
| 1.2-rc | 2026-11-21 | VIZ-006: CPU fallback for lines beyond the value encoding's clip box (same first/last/min/max, same acceptance test); reference placement stated (#68) |
| 1.3-rc | 2026-11-24 | VIZ-086 (owner, #150); T21 |
| 1.4-rc | 2026-11-24 | #151: VIZ-095 (T22) |
| 1.5-rc | 2026-11-24 | #152: VIZ-105, VIZ-106; VIZ-078 partition-axis exemption (owner); Tables 5-4a, 5-5 |
| 1.6-rc | 2026-11-25 | #154: VIZ-090 (T21) |
| 1.7-rc | 2026-11-25 | #206: VIZ-090 bucket sources (T21) |
| 1.8-rc | 2026-11-25 | #184: VIZ-046 staging (offline data in step 1a, drawing in step 1b, sources in part F, wgpu with #68; T24) |
| 1.9-rc | 2026-11-25 | #184 step 1b: VIZ-067 identity per group for grouped spatial marks, and its acceptance covers every series or group; Table 5-8 Markers: target 10⁵, 5 000 drawn in the 2D core; VIZ-044 staging (markers in step 1b, symbol and rotation from fields in part G; T24) |
| 1.10-rc | 2026-11-25 | #184 step 2: VIZ-047 note (sync through `map=*`, the bounds filter as the `geo=` map area, the panels it filters and those it does not yet); VIZ-065 row 8 staging (a synchronous label test after rows 5–7; `legacyAuto` keeps stored boards; not in Explore yet); VIZ-060 Geomap staging (the T24 §4.19 mapping at M-UI3, the corpus at M-UI5; T24) |

## Resolved during formalisation

| # | Issue in draft | Resolution |
|---|---|---|
| R1 | The draft gave no milestones per vis | Added a Milestone column to every vis table, derived from the roadmap ([12](12-roadmap.md)): core time-series M-UI0/1, signal vis M-UI2, spatial/compare M-UI3, alert/SLO M-UI4, panel-parity breadth (tables, geomap, schematics, widgets, field config, transformations) M-UI5 |
| R2 | §12 auto-vis rules were an unordered list whose conditions overlap (e.g. a histogram with > 50 series; spans that also have geo fields) | Table 5-13 is ordered, first match wins; signal-type rules come before metric-shape rules, and a final default "Line" row was added |
| R3 | Log stream text was "MSDF" here but "SDF" in 04 §4.5 | MSDF everywhere |
| R4 | "Band" trigger said "> 50 pods" in §1 but "series count > 50" in §12 | Normalised to "> 50 series of the same metric" |
| R5 | Treemap and sunburst shared one row, but the metrics cardinality explorer (04 §4.4, M-UI1) needs a treemap long before panel-parity breadth | Split: Treemap M-UI1, Sunburst M-UI5 |
| R6 | The gallery had no milestone, yet it is the golden-image/benchmark corpus that CI needs from the start | Gallery as test corpus from M-UI1 (pages added with each vis); public `/gallery` with spec editor and "use in a board" at M-UI5, when boards exist |
| R7 | "At most 2 axes per side" read as a hard limit and as a default in different sentences | It is a default with a "consider stacking" hint; more axes are allowed; stacked lanes are capped at 8 |
| R8 | Sanitisation and no-iframe rules were scattered across §6, §9 | Consolidated into VIZ-054 and VIZ-056, applying to every vis and widget from M-UI1 |
| R9 | The 10k/50k Graph target depended on a PulsusDB edge cap of 1 000 | Kept per assumption A1, with the coverage meter showing edge truncation as the degradation (VIZ-030) |
| R10 | "Sandboxed WASM vis modules" had no timing beyond "later" | MAY at M-UI6; the declarative spec is SHOULD at M-UI5 |
| R11 | 1.0-rc2: §3 made 3D a toggle from 2D for the estate, contrary to the owner's brief | Estate and topology vis are 3D by default with 2D on `T` (VIZ-073, VIZ-074, [15](15-estate-navigation.md) EST-055); "SSAO-lite" replaced by the restrained depth cues of [08](08-visual-language.md) §10 |
| R12 | 1.0-rc2: the owner clarified "a combination of 2D and 3D" | Space is 3D, signals are 2D, linked (VIZ-077); 3D signal views are opt-in or auto-offered (§3.1) |
| R13 | 1.0-rc2: milestones of the 3D signal views | Fleet line stack, latency surface and waterfall at M-UI3 (they reuse the M11 mesh and M1 polyline primitives); span point cloud at M-UI2 with the span scatter; 3D columns, 3D scatter at M-UI5; imported models at M-UI6 |
| R14 | 1.1-rc: VIZ-001, VIZ-057 and VIZ-063 assumed a Leptos DOM, a JS shim and a Rust BFF | Revised to ADR-0014 and ADR-0015; the library ban and the no-arbitrary-JS rule are unchanged |
