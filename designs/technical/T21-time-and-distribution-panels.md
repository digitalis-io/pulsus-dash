# T21 — Time, distribution & comparison panels

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.2-rc · 2026-11-25 |
| **Milestone** | M-UI3 (state timeline; histogram CDF/ECDF overlay) · M-UI5 (standalone histogram) |
| **Related ADRs** | [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0014](../adr/0014-typescript-react-web-client.md) |
| **Source draft** | plans (not tracked) |

## 1. Context & problem

Part 1 of T21 is the **state timeline** of [05](../product/05-visualisation-catalogue.md)
Table 5-11 (#150). Part 2a (#154) adds the **histogram** of Table 5-3
([VIZ-090](../product/05-visualisation-catalogue.md#viz-090--histogram-and-cumulative-overlay)) and the
**non-time interactions** that the XY chart (#201) and the trend panel (#202) reuse. Bucket histograms
are Part 2a-ii (#206).

The histogram bins raw values: one value per series for an instant result, or every sample of a range
result pooled. Bins are auto, count or width, on a linear or log value axis. Groups by a label are
stacked or overlaid, with "other (n)" beyond seven, and a CDF or an exact ECDF can be overlaid. A
per-panel worker computes the frame, and the frame carries each series' contribution, so selection,
the Inspector and the table are exact. The histogram has no time axis: the window only scopes the
query. Mockup [42-histogram](../mockups/42-histogram.svg) shows both group modes.

The state timeline is a `VisSpec` variant. The interim Canvas 2D frame draws it now, and the engine
draws it later. 3D forms are engine-only and true 3D
([VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only)).

Missing data is never shown as a state. Standard panel types treat a gap longer than the query step as
no data, and here it is drawn as Unknown rather than blank. Values are PulsusDB's per-step evaluation,
and the panel states that.

A click opens the shared Inspector (#164). The Inspector separates two things: the part under the
pointer, and the run as drawn.

## 2. Goals / non-goals

**Goals:** the state timeline (§4, §5), the true-3D rule (T21-001) and its gates
([T05](T05-testing-and-performance.md) §7.1). Part 2a: the histogram over raw values (T21-012 to
T21-016), the non-time interactions, and the `Vis.options` keys of both kinds (§5).

**Non-goals**
- XY (#201) and trend (#202); Part 2a defines the non-time forms they reuse.
- Histograms of histogram buckets (#206).
- A baseline-distribution outline (follow-up); value-axis zoom; a log count axis.
- Universal Compare (VIZ-025); violin and box plots.
- Candlestick (#161).
- Status history (its own issue, §11).
- Style and overlays (#159).
- Full field configuration and import (#158).
- Screen-reader text (#160).
- The Inspector itself (#164).
- Multiple axes.
- Ghost, anomaly and forecast.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [VIZ-009](../product/05-visualisation-catalogue.md#viz-009--state-merging-rules) | T21-004, T21-005 | `unit:state-runs` |
| [VIZ-031](../product/05-visualisation-catalogue.md#viz-031--3d-only-when-it-encodes-a-dimension), [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only) | T21-001, T21-006; §4.3 | `ci:spec-lint`; `golden:3d-occlusion` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | T21-007 | `unit:autovis-table` (row 9) |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis), [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel) | §4.2, T21-003 | `e2e:table-csv`; `golden:greyscale` |
| [VIZ-003](../product/05-visualisation-catalogue.md#viz-003--universal-interactions-on-every-vis) | §4.2, T21-009 (Inspector via #164) | `e2e:chart-select`; `e2e:chart-hover` |
| [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) | T21-010, T21-015 (facts; the text is #160) | `unit:summary-facts` |
| [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity), [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) | T21-011, §4.5 (subset; co-satisfied by #158) | `unit:board-spec`; `unit:state-runs` |
| [VIZ-005](../product/05-visualisation-catalogue.md#viz-005--lod-never-hides-signal-silently) | §7, T21-002 | `golden:interim-gallery`; `bench:frame-gallery` |
| [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) | §10 | `ci:gallery-manifest` |
| [VIZ-077](../product/05-visualisation-catalogue.md#viz-077--space-is-3d-signals-are-2d-and-both-are-linked), [VIZ-078](../product/05-visualisation-catalogue.md#viz-078--shared-3d-chart-features), [VIZ-079](../product/05-visualisation-catalogue.md#viz-079--latency-surface), [VIZ-085](../product/05-visualisation-catalogue.md#viz-085--fleet-line-stack) | §4.3 (co-satisfied with T02) | `golden:3d-occlusion`; `replay:3d-linked-2d` |
| [VIZ-028](../product/05-visualisation-catalogue.md#viz-028--distribution-vis-available), [VIZ-090](../product/05-visualisation-catalogue.md#viz-090--histogram-and-cumulative-overlay), [VIZ-005](../product/05-visualisation-catalogue.md#viz-005--lod-never-hides-signal-silently) | T21-012 to T21-014, T21-016 | `unit:dist-bins`; `golden:interim-gallery` |
| [VIZ-003](../product/05-visualisation-catalogue.md#viz-003--universal-interactions-on-every-vis) | T21-015 | `e2e:hist-inspect`; `unit:inspector-model` |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis), [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel) | T21-014, T21-015 | `e2e:table-csv`; `golden:greyscale` |
| [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | T21-016 | `unit:hist-worker`; `bench:rooms-long-tasks` |

## 4. Design

### 4.1 Design rules

#### T21-001 — True 3D only
**MUST** — A 3D form is a world-space engine scene. It has a depth buffer and depth-tested M1, M4 and
M11 marks with a 3D transform (vis platform, T02-001). The camera orbits, pans and dollies, perspective
by default with an orthographic toggle, and uses VL-023 face lighting and VL-024 fog. The interim
Canvas 2D frame never draws a 3D form, a bevel, an extrusion, a drop shadow, an isometric projection or
light-direction shading. Data gradients (ramps, VIZ-010) are allowed. Board-spec and `VisSpec`
validation rejects any depth, perspective, bevel, shadow or shading key on a 2D kind.

#### T21-002 — One spec per kind
**MUST** — Each kind is a `VisSpec` variant over T02 marks (§4.6), with no private pipeline. It ships
on Canvas 2D first, and the engine port passes the same fixtures. The coverage meter names each
interim cap in §4.4 (VIZ-005).

#### T21-003 — Encoded twice
**MUST** — **Health values** (`role: 'state'` mappings) draw a `solid` fill in the state colour, with
the state glyph at the start of the segment (T02-003). No data and Unknown use `NO_DATA_PATTERN`.

**Categories** are every non-health value, `role: 'series'` mappings and unmapped values alike. They
are numbered j = 0, 1, … in the frame: mapped values first, in mapping order, then unmapped values in
order of first appearance. Categories j = 0…6 get `CATEGORY_PATTERNS[j]` and their colour (the
mapping's `index`, or `j mod 8` when unmapped). Patterns are never repeated, so two categories that
share a colour still differ. Categories j ≥ 7 are merged into one category, "other (n)". It is drawn
in the `category-other` token (new, T01-010) with `OTHER_PATTERN`. Its legend entry lists the member
texts. Hover, the Inspector and the table show the real value and text, plus "(in other)".

**Rows** are at least 16 CSS px tall, so with `rowHeight` ≥ 0.5 a pattern tile (6 × 6 px) always fits
vertically. Rows that do not fit are paged (`perPage`; page control in the panel footer).

**Reduction marks** (the owner's "other (n)" principle, applied to width). Reduction applies to the
**runs** of T21-004, after equal display parts have merged, never to individual samples. A run
narrower than 6 CSS px is *short*. Consecutive short runs merge into one **reduction mark** "n
states", where n counts its member runs. A run of 6 px or more is never part of a reduction and always
ends one, so every transition between wide runs stays drawn where it happens. It is drawn as a
half-height bar, vertically centred and at least 1 device px wide, in the reserved neutral `reduced`
token (new, T01-010). It is never drawn in a member's colour, so it claims no state or category
identity.

**Alert cues.** Every member run with healthRank ≥ 2 (watch, degraded or failing), called an *alert
run*, keeps a location cue at the x of its own centre. No cue is ever dropped.
- **Isolated alert run.** An alert run whose centre is ≥ 8 px from every other alert run's centre in
  the same reduction draws its state glyph (T02-008) above the row.
- **Cluster.** Alert runs whose centres chain within 8 px form a cluster. Each one draws a **location
  tick**: 1 device px wide and 4 px tall, above the row, in its state colour. A tick is a reserved
  shape that no other mark uses. The cluster's worst state glyph is drawn once more, 4 px above the
  ticks, centred over the cluster (worst by healthRank, earliest on a tie).
- **Same pixel.** Alert runs whose centres fall in the same device px share that px's single tick and
  are counted in the coverage meter's reduction line (T21-005).

Members are listed in the tooltip and the Inspector ("Shown as: n states"). Both show the first 8,
then "+k more", which opens the complete list through `resolveMembers`. The table and CSV list every
part. The legend always lists every category, every state and the reduction mark ("n states: hover or
zoom to identify"). Unmapped text is the value formatted with `unit`.

#### T21-004 — Coverage and runs
**MUST** — `coverage` splits [w.from, w.to) per series into ordered, non-empty parts. Sample i covers
[max(t_i, w.from), min(t_i + stepMs, t_{i+1}, w.to)), and an empty intersection is dropped. Every other
part of the window is uncovered (`sample: null`): before the first sample, inside any gap where
t_{i+1} > t_i + stepMs, after the last sample's cover, and the whole window for an empty series. The
one exception is a trailing uncovered part shorter than stepMs that follows at least one sample's
cover: it is not yet due and is left blank. A series with no samples is exempt and is Unknown over the
whole window, however short the window. An uncovered part or a non-finite sample has `value: null` and
state `unknown`. It is drawn as the Unknown hatch, never as a gap or OK, with the text of the first
`nan` mapping, or "no data" (T21-011).

Each part's `mapping` is the first-match index for its own value, and its `text` and `state` come from
that mapping or from T21-003. Each part has its original `text` (from its mapping or T21-003, kept for
hover, the Inspector, the table and CSV) and a **display** triple (`displayText`, colour, pattern):
what is drawn. For most parts the display triple is (`text`, its colour, its pattern). For a member of
"other (n)" (T21-003) it is ("other (n)", `category-other`, `OTHER_PATTERN`).

Adjacent parts with an equal display triple merge into one run, whatever their raw values, mapping
indices or original texts. The run's `text` is the display text. The run keeps its `parts`. `mixed` is
true when the run has more than one distinct finite raw value, `distinct` lists those values, and
`samples` counts the finite samples. Merging cannot be disabled (VIZ-009).

#### T21-005 — Reduction, hit-test and disclosure
**MUST** — `reduceRow` turns a row's runs into marks. Wide runs (≥ 6 CSS px) stay `run` marks. Every
maximal sequence of consecutive short runs, whatever their states, becomes one `reduction` mark, with
ticks and glyphs placed by the T21-003 alert-cue rule. The reduction's `displayed.state` is its worst
member by healthRank (failing 4, degraded 3, watch 2, unknown or no data 1, ok 0, categories 0),
earliest on a tie.

**Disclosure** (VIZ-005): whenever the view draws k > 0 reduction marks holding n parts in all, the
coverage meter reads "k reduced marks (n parts): hover or zoom to identify". At k = 0 it reads as
usual.

**Hit-test:** `hitTest` maps pointer x to atMs = w.from + (x − plot.x) · (w.to − w.from) / plot.width.
It returns the part covering atMs (`selected`) and its run (`selectedRun`). It also returns
`displayed`: when the covering part lies in a reduction mark, this is the reduction's RunFacts (its
extent, text "n states", the worst member's `state` or null, and `texts` listing the member texts),
with `reason` `reduced`; otherwise it is `selectedRun`, with `reason` `covers`. The keyboard moves mark
by mark over what is drawn, wide runs and reduction marks alike. atMs is the focused mark's start, and
the result is computed by the same `hitTest(atMs)`. On a reduction mark this gives the covering part,
the reduction as `displayed`, and `reason` `reduced`.

#### T21-006 — 3D forms
**MUST** — §4.3 maps 2D kinds to 3D forms. `T` and the 3D control (#94) appear only when the engine is
active and the data has the third dimension. 2D and 3D share data, selection and the time cursor
(VIZ-077).

#### T21-007 — Auto-vis row 9
**MUST** — A range result is state-like when every series' finite values lie in {0, 1}, or when the
panel's mappings cover every distinct finite value. A state-like result picks stateTimeline. The
status-history issue later adds the "regular step" branch to this rule. Instant results never match
row 9. Rules 1–8 keep precedence (T02-028).

#### T21-008 — Freshness and disclosure
**MUST** — The panel adds no freshness of its own. A value at step t is PulsusDB's evaluation at t
under standard PromQL and LogQL semantics: staleness markers end a series at the next step, an
unmarked series persists up to the 5 min lookback, and range selectors persist for their range. This
matches the reference datasources, which send no lookback override. The panel guarantees three things.

**(a)** Wherever the result has no finite sample for longer than one step, it draws Unknown, never OK
(T21-004).

**(b)** It keeps vanished series. A query context is (panel id, expanded query text, variables, window
span). For each context the panel keeps an in-memory, unpersisted map from key to labels. Only a
**complete** refresh, one whose `Completeness` has `truncated: false` and no warnings, can mark keys
vanished. On an incomplete refresh, the key map is left unchanged, nothing is appended, and only the
existing "truncated" or warning disclosure is shown. After a complete refresh, every key in the map but
absent from that refresh is appended as `{ key, labels, timestamps: new Float64Array(0), values: new
Float64Array(0), vanished: true }`. It is drawn Unknown over the whole window with the text "no longer
returned", which takes precedence over any `nan` mapping text, until the key returns or the context
resets. A returned series with all-NaN values is not vanished, and keeps the `nan` text or "no data".
While N > 0 the coverage meter reads "N series no longer returned". Appended series count toward the
500-row cap.

**(c)** The panel info line reads "Values as evaluated at each step; a stopped source can persist up
to the query's lookback or range".

**AUD-008** is entity-level (M-UI2, Epic #6, catalogue T12) and is not claimed. The panel follows its
rule that missing data is never healthy.

#### T21-009 — Selection and Inspector
**MUST** — A click, or Enter or Space on the keyboard-focused segment, emits `select` with the
`hitTest` result. The page host writes the [T25](T25-inspector-and-pivots.md) `Selection` { keys =
[item.key], fromMs and toMs = **selectedRun**'s interval } (T25-006, T02-025). It opens the T25
Inspector with `{type:'stateRun', target}`, where target is `StateInspectorTarget`. `selected` is the covering part, labelled "At <time>". `displayed` is what is
drawn at that point (the run, or the reduction mark "n states" with its members), labelled "Shown as",
and when `reason` is `reduced` it is suffixed "(reduced: <n> parts)". On the next frame `setSelection`
reaches every panel: the key's series gets a 2 px `focus` ring, the other series dim to the `dimmed`
alpha (a new token, T01-010), and every time kind draws the selection interval as a `selection` band.
Esc follows the T25-007 ladder: clearing the selection and closing the Inspector are separate steps. A
click on empty plot clears only the selection. Nothing is persisted. Pivot chips come from `labels`
through T25 (T25-009, T25-010), and the member lists follow T25-011.

#### T21-010 — Summary facts
**MUST** — `current` is the highest-ranked display state (T21-005 rank) at the last covered instant
across rows, with its series. `change` is the latest transition into that state (from text, to text,
atMs). `extent` and `baselineRatio` are null. #160 renders these as text, with "no baseline".

#### T21-011 — Field-config subset
**MUST** — `ValueMapping` is the subset of VIZ-057 that these panels use, and #158 keeps it valid with
the same meaning. Booleans arrive as 1 and 0 and match `value`. A `nan` mapping matches null, NaN and
uncovered time, and may only relabel no data. Its colour must be `{role:'state', state:'unknown'}`, and
any other colour is `board.options.mappings.invalid`. On import, a null or NaN mapping keeps its text, its
colour is replaced by Unknown, and the report notes "no-data colour kept as Unknown". A recolour could
make missing data look OK, while the hatch and the Unknown glyph keep the second channel (T02-003).

#### T21-012 — Values
**MUST**
- Any series with an `le` label → `buckets` (main thread, no worker) "Histogram buckets: choose Heatmap; bucket
  histograms come with #206"; never binned as values. Scalar or string → `{code:'kind'}`.
- Instant: one value per series (`countBasis:'series'`); range: every sample (`'samples'`).
- NaN is a gap, not received. Each received sample takes the **first** exclusion that applies:
  (1) non-finite → `infinite` (counted before the T22-003 merge, which keeps finite samples, max on
  conflict); (2) finite outside the drawable domain (v = 0 or 1e−290 ≤ \|v\| ≤ 1e290) → `outOfRange`,
  including negatives on a log axis (−1e−300 is out of range); (3) on a log axis, ≤ 0 → `nonPositive`.
  Binning on log runs on log10 v. All kept per source group. Within the domain every span, width, unit conversion (×100,
  ns→s→d) and pixel mapping is finite with margin.
- Σ sample count (NaN included) > 2 000 000 → `tooMany` "N samples exceed the 2 000 000-sample limit:
  narrow the query or the window", decided on the main thread; nothing is posted or binned.
- Counts, quartiles and ECDF are exact over all drawable values (a full sorted copy in the worker).

#### T21-013 — Bins
**MUST** — All drawable values; [eᵢ, eᵢ₊₁), last closed; exact min and max; k is an
integer in [1, 200]. **Units:** binning computes on x = v (linear) or log10 v (log); the frame's edges
are always value units (log: eᵢ = 10^xᵢ). The axis is never inverted: `edgePx[i]` = (f(eᵢ)/2 −
f(e₀)/2) / (f(eₖ)/2 − f(e₀)/2) · W, f = identity or log10, with edgePx[0] = 0 and edgePx[k] = W
exactly; hit-test and brush compare pointer px against `edgePx` only (T21-015), and every
`from`/`to`/`xRange` is a raw frame edge.

**Display:** every user-visible number (edges, widened width, tooltip, table, Inspector, meter,
summary) uses `formatValue` (`client/src/i18n/format.ts`), which gains `digits` (default 3: today's
output unchanged except the out-of-range form below; above 3, `toPrecision(digits)` at every magnitude, trailing zeros dropped) and
adopts `formatCompact`'s out-of-range form: a converted base value c ≥ 1e21 or 0 < c < 1e−12 is
`toPrecision(digits)` in exponent form plus the base tail (`1e+281 s`, `1e+292 %`). `binLabels(edges,
unit)` picks the least d in 3…17 at which every adjacent label differs, for all bin ranges of the
panel (the guard makes such a d exist). A collapsed frame (one bin whose two edges convert equal at 17
digits) shows one label "≈ " + `formatValue(e₀, unit)` on the axis, tooltip, table and Inspector.
CSV keeps raw `String(v)`. The `formatValue` change alters output only for converted values ≥ 1e21
or < 1e−12; for example 1e21 (none) "1000000P" → "1e+21", 2.5e22 "25000000P" → "2.5e+22", 1e−4 ns
"0.0001 ns" → "1e-13 s", 1e22 bytes "8881784 PiB" → "1e+22 B", 5e21 rps "5000000P rps" → "5e+21 rps";
every other output is identical (e.g. 1e19 percentunit "1e+21 %", 1e−13 "1e-13").

- **Normalise (width, auto):** S = 10^E (`scaleOf`); every span, quartile, h, nice width and q is
  computed on v/S ∈ [−1.8, 1.8], so no step overflows. nice(x) = the least m·10ᵉ ≥ x, m ∈ {1, 2, 2.5,
  5}; widths below the normal range (0, subnormal) count as too small.
- **Edges:** q₀ = ⌊a⌋, q₁ = ⌈b⌉ for a = min/S/w, b = max/S/w (q₁ = q₀ + 1 if equal), k = q₁ − q₀.
  **Before any allocation**, k must be a finite integer in [1, 200] and \|q₀\|, \|q₁\| ≤ 2⁵²; k > 200
  first tries the width widening below, and anything else invalid goes straight to count mode with
  c = 20 (the only fallback). A rounding-induced extra bin at either end is allowed. Nice widths give
  eᵢ = ((q₀ + i)·m)·10^(e+E); a user width gives eᵢ = (q₀ + i)·w. Then e₀ = min(e₀, min) and
  eₖ = max(eₖ, max).
- **Quantiles:** type-7 as x_j·(1 − g) + x_{j+1}·g (no difference term).

| Mode | Width and k |
|---|---|
| count c | c ≤ 200; eᵢ = min·(1 − i/c) + max·(i/c) (no overflow), e₀ = min, e_c = max |
| width w | w/S; if 0, subnormal, non-finite or k > 200: w = nice(span/200), then the next nice value while k > 200 (≤ 3 steps); `widenedTo` = that width in value units |
| auto | h = 2·IQR·n^(−1/3); k₀ = ⌈span/h⌉, or Sturges ⌈log₂ n⌉ + 1 when IQR = 0, clamped 5…200; w = nice(span/k₀); then as width while k > 200 |
| max = min | u = nice(\|v\|·0.1), or 1 at v = 0; [v − u/2, v + u/2] |

**Guard:** it fails if any edge is non-finite or not strictly increasing, if two adjacent edges give
the same `formatValue(e, unit, 17)`, or (log) an edge is ≤ 0 or its log10 is non-finite or not
strictly increasing. Then k is decremented and edges are recomputed as in count mode in axis space (on
log: between log10 min and log10 max, then 10^x, with e₀ = min and eₖ = max; min > 0 for drawable log
values), down to one bin [min, max] (`collapsed` when its edges still convert equal); `adjusted` = k,
and the meter reads `bins adjusted to k (number limits)`. Every drawable value falls in a bin
(`binIndex` clamps to [0, k − 1] inside [e₀, eₖ]). **Terminal log rule** (after the guard, singles
included): if log10 e₀ < log10 eₖ fails, the result is one bin spanning one decade centred on
L = log10 min, [10^(L − 0.5), 10^(L + 0.5)], widened to cover min and max; `adjusted` = 1. Fixtures
give edges as exact JS strings and compare interior edges with a relative tolerance of 1e−12.

#### T21-014 — Groups, totals, cumulative
**MUST**
- **Source groups:** none → "all values" (`series-1`, `solid`). With L: the raw L value (`labels`
  {[L]: v}); absent → `labels` {} and the name `L absent`; names reading as an aggregate or `L absent`
  are quoted (T22-004 final pass), while `labels` stay raw.
- **Drawn groups:** drawable 0 → not drawn, legend "<name> (no values shown)", no curve. Else the 7
  largest by drawable (ties by name), in natural name order j = 0…6, with `CATEGORY_PATTERNS[j]`,
  `LINE_DASHES[j]` and colour `seriesColourIndex({key: groupKey(L, v), labels: {[L]: v}})`. The rest
  → `other (n)` (key `other`, `grid`, `category-other`, `OTHER_DASH`, last; counts summed).
- **Totals:** `received` = finite values after the merge + `infinite`; `drawable` = values in bins.
  `share` = count / panel drawable; `groupShare` = count / drawn group drawable; CDF and ECDF divide by
  drawable, so every curve ends at 100 %.
- **stack:** segments bottom-up in draw order; one panel curve in `text-secondary` (CDF Σ counts ≤ i
  / panel drawable; ECDF `ecdfAt(f, all, x)`).
- **overlay:** per drawn group a 1.5 px step outline in its colour and dash over a 12 % unpatterned
  fill, and its own curve in its dash (`other`: `ecdfAt` over its member slices, or Σ member counts for
  CDF).
- **Look:** right axis 0–100 %, ticks at 25 %; ≤ 2 curve vertices per device px, exact at column
  edges; tabular edge labels; 1 px gap between bins ≥ 6 px; fill 72 %, top edge 100 %; `hairline`
  baseline; no radius, gradient or shadow.

#### T21-015 — Non-time interactions
**MUST**
- **No time axis:** `tMs` null; the window only scopes the query; time intervals are not drawn;
  tooltip footer "Values pooled over <window>" (instant "Values at <time>").
- **Hit regions (CSS px):** px outside [edgePx[0], edgePx[k]] → none; else the largest i with
  edgePx[i] ≤ px (binary search; gaps and boundaries go right), and px = edgePx[k] → the last bin.
  - stack: segment rectangles, at least 4 px tall (grown upward), the top one plus 3 px; tested
    top-down, first wins.
  - overlay: (1) an outline within 4 px, nearest wins; (2) else the containing bar with the smallest
    count. Ties → lower j.
  - Else (above or between bars) → empty click `select(null)`; Enter announces "empty bin".
- **Click, Enter, Space (count > 0):** `select({keys: binSeries(…), fromMs: null, toMs: null},
  {kind:'mark', panelId})` and `inspect({type:'bin', target})`. The target has one `MemberSection`: a
  grouped or ungrouped bin lists its series; an `other` bin lists its member groups. Each list has one
  resolver id (`binId`, or `${binId}:groups`) registered by `registerMembers`; completeness and
  staleness follow the amended [T25](T25-inspector-and-pivots.md) T25-011. A member group's series are
  reached by its chip or by its own bin target, never by a second list. Chips: a grouped bin offers
  T25-009 pivots and the filter `{L="v"}`; an absent label shows "L: (no value)" with no filter;
  `other` itself offers none, while each member row and each series row offers its own.
- **Universal interactions without a time axis (VIZ-003):** the board time crosshair is received and
  ignored; hover here emits `tMs: null`, so other panels draw no cursor; `ghost` and `anomaly`
  (T22 `Ov`, accepted in `HistogramSpec`) are accepted and draw nothing. Each shows one line in the
  tooltip while active and in the panel menu: "Time crosshair / Baseline ghost / Anomaly overlay: not
  available on a histogram: no time axis".
- **Value brush:** a drag ≥ `chart-brush-min` over [p₀, p₁] selects the bins with p₀ < edgePx[i+1] and
  p₁ > edgePx[i] (pixel-extent overlap; a brush wholly outside the plot, or starting at edgePx[k] and
  going outward, selects nothing); Shift+←/→ extends by whole bins. It emits `xRange` = [e_first,
  e_last+1] from the raw edges; the panel calls `setXRange` (`selection` token), selects `binSeries`
  over all groups, and registers an `escape` pre step clearing it. Wheel and pan commit nothing.
- **Keys:** ←/→ bins (empty included), ↑/↓ drawn groups, Home/End; each move emits a keyboard
  `hover` and a 2 px `focus` outline; Esc per T25-007 (brush → selection → Inspector).
- **Selection read:** `selectedCounts(f, keys)` from `contrib`; non-null → bars at `dimmed` under a
  2 px `focus` step outline per drawn group; null (foreign or none) → nothing dims.
- **Table and CSV (source groups):** per source group, each bin with count > 0: group, shown as
  (drawn name, `other (n)` for members, empty if not drawn), from, to, count, share, group share,
  cumulative (that source group's own: CDF Σ its counts ≤ bin / its drawable; ECDF `ecdfAt(f, [g], to)`);
  then its exclusion rows (`≤ 0 (log)`, `infinite`, `out of range`, count).
- **Facts:** `current` {"median <`quantiles.p50`>; mode <from> – <to> (<count> of <drawable>)", title};
  `change` null; `extent` {min, max} (widened as T22-014); `baselineRatio` null.

#### T21-016 — Work, coverage, empty states
**MUST**
- **Time-bounded main thread:** `runHistogram` copies series into a batch and posts it to the panel's
  `histogram.worker.ts` when the step reaches 8 ms (`performance.now()`), then yields (`MessageChannel`);
  results return as transferred buffers. A new run aborts the old (`terminate()`, new worker); late or
  older-`runId` messages are dropped. `selectedCounts` and `binSeries` scan `contrib` in the same
  8 ms slices; a newer selection aborts a running scan, and the frame keeps its last drawn selection
  until the scan resolves. Drawing is ≤ 200 bins × 8 groups.
- **Meter** (" · ", in order): `truncated`; `limited (N warnings)` (both T22-006); `k ≤ 0 not shown
  (log)`; `k infinite values not shown`; `k values out of range not shown`; `k duplicate series
  combined; c conflicts (max kept)`; `bin width widened to W (200-bin cap)`; `bins adjusted to k
  (number limits)`; none → `100 %`. The `≤ 0`, `infinite` and `out of range` parts are buttons (Enter
  or click) opening the meter popover: one line per source group with a non-zero count, in name order,
  e.g. "B: 1 ≤ 0, 1 infinite, 1 out of range", with members of `other (n)` suffixed "(in other (n))";
  the table's exclusion rows list the same.
- **Notices** (no axes are drawn):

| Result | Plot text | Legend | Meter | Table / CSV |
|---|---|---|---|---|
| `empty` | "No values in this window" | none | query parts, or `100 %` | one notice row |
| `noneShown` | "No values shown: " + the exclusion parts | each source group "<name> (no values shown)" | the parts and their popover | the exclusion rows per group |
| `tooMany`, `buckets` | the T21-012 text | none | query parts | one notice row |

### 4.2 Interactions (VIZ-003, VIZ-066, VIZ-067)

| Hover item | Click / Enter | Brush | Keys (frame focused) | `Shift+T` and CSV |
|---|---|---|---|---|
| segment: the covering `part` and its `run`, plus `displayed` and `reason` (T21-005) | Inspector + selection (T21-009) | time → Context window | ←/→ segment, ↑/↓ row, Esc clears | one row per part: series, run index, from, to, value, text (original, with "(in other)" for members), display text, state |
| histogram: the `bin` under the pointer (T21-015 hit regions), `tMs` null | Inspector `{type:'bin', target}` + selection of the bin's series (T21-015) | value → `xRange` over whole bins, `setXRange` band, selection of their series | ←/→ bin, ↑/↓ drawn group, Home/End, Shift+←/→ extends the brush, Esc per T25-007 | per source group, one row per bin with count > 0: group, shown as, from, to, count, share, group share, cumulative; then its exclusion rows (T21-015) |

The crosshair, coverage meter and event markers ([ADR-0023](../adr/0023-chart-event-markers.md)) all
apply. A `validateFrameData` issue shows the existing notice.

### 4.3 3D forms (engine-only; T21-001)

| 2D kind | 3D form | X | Y (up) | Z (depth) | Camera / LOD | Scale | By |
|---|---|---|---|---|---|---|---|
| line (> 1 series) | Fleet line stack VIZ-085 | time | value | lane per series | VIZ-085 presets; band + outliers when far | 2 000 lanes (PRF-046) | #94 |
| heatmap | Latency surface VIZ-079 | time | count (M11 height field) | bucket (log) | contours; slices dock 2D | 2k × 200 | #94 |
| stateTimeline | none: states are categorical, and depth adds nothing beyond rows × time | | | | | | |
| histogram (instant) | none: no third dimension | | | | | | |
| histogram (range) | Waterfall of distributions VIZ-081 (#203); `T` with the engine only | | | | | | |

Every 3D form meets VIZ-078 and VL-023 to VL-028. Contact shadows (VL-026) exist only in 3D.

### 4.4 Scale target and interim cap

The scale target and the interim cap of each kind are in §7.

### 4.5 Import (VIZ-060 subset; key-level conversion is #158)

| Standard option | T21 target | Note in the import report |
|---|---|---|
| Value or range mapping | `value` / `range` | — |
| Special null or NaN; true or false | `nan` (text kept, colour Unknown); `value` 1 or 0 | "no-data colour kept as Unknown"; empty-string specials |
| Regex mapping (text) | — | dropped (values are numeric) |
| Mapping colour or icon | `state` if the colour equals a state token, else `series` (nearest index) | the icon |
| Merge equal values off | merge on | "merge off" |
| Rows per page | `perPage` | — |
| Connect null values; disconnect threshold | — (the gap threshold is the step) | "missing data shown as no data" |
| Histogram bucket count / bucket size | `binCount` / `binWidth` (keys: #158) | — |
| Histogram stacking | `groupMode` (keys: #158) | — |
| Histogram log X | `scale` (keys: #158) | — |

### 4.6 Marks (VIZ-002)

M3, M8 and M9 (glyphs) draw the state timeline, M3 the selection band, and M1 the focus ring. The
histogram draws its bars, fills and the `xRange` band with M3; its step outlines, CDF and ECDF curves
and focus outline with M1; and its edge labels, axes and notices with M8.

## 5. Interfaces

Seam and transform types. Every field is `readonly`; the I-A ADR adopts them.

```ts
// client/src/engine/api.ts
export type VisKind = 'line' | 'bars' | 'heatmap' | 'stat' | 'stateTimeline';
export type HealthState = 'ok' | 'watch' | 'degraded' | 'failing' | 'unknown';
export type MappedColour = { role: 'state'; state: HealthState } | { role: 'series'; index: number /* 0..7 */ };  // input only (board spec, mappings)
export type DisplayColour = MappedColour | { role: 'other' };   // drawn colour; 'other' = the category-other token, never in a board spec
export type ValueMatch = { kind: 'value'; value: number }
  | { kind: 'range'; from: number; to: number } /* from <= v < to; from < to */
  | { kind: 'nan' };   // its colour MUST be { role: 'state', state: 'unknown' } (T21-011)
export interface ValueMapping { match: ValueMatch; text: string; colour: MappedColour }
// ≤ 32; text 1..64 chars, plain text (T02-019); first match wins.
export interface StateTimelineSpec { kind: 'stateTimeline'; title: string; unit: Unit;
  mappings: readonly ValueMapping[] /* [] */; showValues: 'auto' | 'always' | 'never' /* 'auto' */;
  rowHeight: number /* 0.5..1, 0.9 */; perPage: number /* 1..100, 20; rows ≥ 16 CSS px */ }

export interface PartFacts { fromMs: number; toMs: number; value: number | null /* null = no data */;
  displayText: string; displayColour: DisplayColour; inOther: boolean;   // the drawn triple (with the pattern); true for members of "other (n)"
  mapping: number | null; text: string; state: HealthState | null }   // one part, mapping resolved for its value
export interface RunFacts { fromMs: number; toMs: number; text: string /* the display text */; state: HealthState | null;
  mixed: boolean; distinct: readonly number[] /* finite raw values, ascending, ≤ 8 */;
  texts: readonly string[] /* first 8 distinct original part texts, in order */; textCount: number /* all distinct texts */;
  runId: string /* `${panelId}:${seriesKey}:${fromMs}`, or `${panelId}:${seriesKey}:r${fromMs}` for a reduction. panelId is a transform parameter from the board page, not a spec field, so ids are unique per panel */;
  members: readonly MemberFacts[] /* a reduction's first 8 member runs; [] for a run */; memberCount: number /* 0 for a run */;
  samples: number }
// MemberFacts and MemberList come from client/src/inspector/members.ts (T25 §5).
// The panel registers its resolver with the T25 host (registerMembers); the Inspector calls resolveMembers(panelId, runId)
// for the complete lists when the user opens "+k more", and shows them per T25-011 (k = count − shown).
export type HoverItem =    // #154, #161 and the status-history issue add members
  { kind: 'segment'; key: string; atMs: number; part: PartFacts; run: RunFacts;
    displayed: RunFacts; reason: 'covers' | 'reduced' };
// HoverEvent gains item: HoverItem | null. #154 adds the 'bin' member (below).
export interface SelectEvent { source: 'pointer' | 'keyboard'; item: HoverItem | null }   // T25 §5: item null = empty click
// Selection is T25's { keys: string[]; fromMs: number | null; toMs: number | null } (client/src/inspector/).
// ChartFrame gains setSelection(s: Selection | null): void (every kind). FrameSummary gains facts.
export interface SummaryFacts { subject: string; current: { text: string; series: string } | null;
  change: { series: string; from: string; to: string; atMs: number } | null;
  extent: { min: number; max: number } | null /* null for kinds without one (stateTimeline); T22-014 marks; histogram T21-015 */;
  baselineRatio: number | null /* null until baselines (ADR-0012) */ }

// The Inspector target handed to T25 as the InspectorTarget member {type:'stateRun'; target: StateInspectorTarget}
export interface StateInspectorTarget { kind: 'stateRun'; panelId: string; seriesKey: string;
  labels: Readonly<Record<string, string>>; query: { lang: 'promql' | 'logql'; expanded: string };
  atMs: number;            // pointer: the clicked instant; keyboard: the focused mark's start
  selected: PartFacts;     // labelled "At <time>": the part covering atMs
  displayed: RunFacts;     // labelled "Shown as": the drawn mark at atMs (a run, or a reduction)
  reason: 'covers' | 'reduced' }

// client/src/vis/transforms/ (used by the frame and Shift+T; the engine L2 port runs the same JSON fixtures)
export interface Part extends PartFacts { sample: number | null }   // covered (sample index) or uncovered (null)
export interface Run extends RunFacts { series: number; key: string; parts: readonly Part[];
  colour: DisplayColour; pattern: (typeof CATEGORY_PATTERNS)[number] | 'solid' | 'grid' | 'hatch'; other: boolean; noData: boolean }
// client/src/data/frames.ts: SeriesFrame gains `vanished?: true` (set only by the T21-008 (b) key memory; validateFrameData accepts it)
export function coverage(s: SeriesFrame, m: readonly ValueMapping[], stepMs: number, w: TimeWindow): Part[];
export function stateRuns(panelId: string, s: readonly SeriesFrame[], m: readonly ValueMapping[], stepMs: number, w: TimeWindow): Run[];
export type Mark = { kind: 'run'; run: Run }
  | { kind: 'reduction'; facts: RunFacts; runs: readonly Run[] /* every member run, complete, in order */;
      ticks: readonly { x: number; state: HealthState }[];   // one per watch/degraded/failing member run
      glyphs: readonly { x: number; state: HealthState }[] };                                    // T21-003 cue placement
export function reduceRow(panelId: string, row: readonly Run[], w: TimeWindow, plotPx: number): Mark[];   // T21-003, T21-005: runs < 6 CSS px only
export function hitTest(marks: readonly Mark[], atMs: number):      // marks from reduceRow for the row
  { selected: Part; selectedRun: Run; displayed: RunFacts; reason: 'covers' | 'reduced' } | null;  // null outside coverage
// hitTest finds the mark covering atMs, then the run covering atMs (the run itself, or by binary search over the mark's
// complete `runs`), then the part covering atMs in that run's complete `parts`. displayed = the reduction's `facts`
// in a reduction mark, otherwise the covering run's RunFacts. `facts.members` (first 8) is for display only.
// client/src/engine/patterns.ts: the one shared pattern list (T21-003; #151 T22-004 uses the same list)
export const HEALTH_PATTERN = 'solid';                 // health states (with the state glyph)
export const CATEGORY_PATTERNS = ['backDiagonal', 'horizontal', 'vertical', 'dots', 'crossHatch', 'checker', 'dashes'] as const;  // 7, never repeated
export const OTHER_PATTERN = 'grid';                   // the merged "other (n)" category
export const NO_DATA_PATTERN = 'hatch';                // diagonal; Unknown and no data
// The reduction mark (consecutive runs < 6 CSS px) is a half-height bar in the neutral `reduced` token, not a pattern or a member colour.
export function summaryFacts(title: string, rows: readonly Run[], w: TimeWindow): SummaryFacts;
```

**Histogram (Part 2a, #154).** The same rules apply: every field is `readonly`, and the I-F seam ADR
adopts these types, amending [ADR-0014](../adr/0014-typescript-react-web-client.md) §3.

```ts
// client/src/engine/api.ts
export type VisKind = /* existing */ | 'histogram';
export interface HistogramSpec { kind: 'histogram'; title: string; unit: Unit; ghost?: boolean; anomaly?: boolean; // accepted, n/a
  scale: 'linear' | 'log'; groupMode: 'stack' | 'overlay'; cumulative: 'none' | 'cdf' | 'ecdf' }
// HoverEvent.tMs: number | null (null on histogram); HoverEvent.item: HoverItem | null (T21 I-A).
export type HoverItem = /* T25 'point' | 'bucket'; T21 'segment' */
  | { kind: 'bin'; index: number; group: number /* drawn group */; from: number; to: number;
      count: number; share: number; groupShare: number; cumulative: number | null };
export interface XRangeEvent { source: 'pointer' | 'keyboard'; from: number; to: number }  // bin edges, from < to
// FrameEvents gains xRange; ChartFrame gains setXRange(r: {from; to} | null) (band; no-op on time kinds).
// BrushEvent unchanged. FrameSummary.valueAxis = the count axis.

// client/src/data/frames.ts (Labels = Readonly<Record<string, string>>)
export type FrameData = /* existing */ | { kind: 'histogram'; histogram: HistogramFrame };
export interface SourceGroup { key: string; name: string; labels: Labels /* {[L]: raw v}; {} when absent or no groupBy */; received: number;
  drawable: number /* received − nonPositive − infinite − outOfRange */; nonPositive: number; infinite: number; outOfRange: number; drawnAs: number }
export interface HistogramGroup { key: string /* or 'other' */; name: string; colourIndex: number;
  pattern: (typeof CATEGORY_PATTERNS)[number] | 'solid' | 'grid'; dash: readonly number[]; members: readonly number[]; drawable: number }
export interface HistogramFrame { edges: Float64Array /* VALUE units on every axis; k+1 finite increasing, 1 ≤ k ≤ 200 */;
  sourceGroups: readonly SourceGroup[] /* name order */; groups: readonly HistogramGroup[] /* drawn, draw order */;
  counts: Float64Array /* groups × k */; series: readonly { key: string; name: string; labels: Labels; sourceGroup: number }[] /* by key; labels raw */;
  contrib: { offsets: Uint32Array /* series+1 */; bins: Uint16Array; counts: Float64Array }; // CSR, ≤ 2·10⁶ entries
  sorted: { values: Float64Array; offsets: Uint32Array /* sourceGroups+1 */ }; // every mode: drawable values, source groups contiguous in name order, each ascending
  quantiles: { p25: number; p50: number; p75: number } | null; // type-7 over all drawable values (worker); null when drawable 0
  countBasis: 'series' | 'samples'; collapsed: boolean /* one bin, edges equal on display */; coverage: HistogramCoverage }
export interface HistogramCoverage { query: Completeness; received: number; drawable: number;
  nonPositive: number; infinite: number; outOfRange: number; duplicates: number; conflicts: number; widenedTo: number | null /* the width used when a user or auto width was widened */;
  adjusted: number | null /* k after the T21-013 guard or fallback */ }
// FrameDataIssue adds { code: 'bins' } (edges, counts length, CSR offsets or a negative count invalid).
// client/src/engine/patterns.ts
export const LINE_DASHES = [[], [6, 3], [2, 2], [8, 3, 2, 3], [1, 3], [10, 4], [4, 2, 1, 2, 1, 2]] as const;
export const OTHER_DASH = [12, 3, 2, 3] as const;
```

Transforms and worker live in `client/src/vis/transforms/`. They are pure, and their JSON fixtures are
shared with I-F2.

```ts
// histogram.ts (runs in histogram.worker.ts)
export interface HistogramOptions { binMode: 'auto' | 'count' | 'width'; binCount: number; binWidth: number | null;
  scale: 'linear' | 'log'; groupBy: string | null; groupMode: 'stack' | 'overlay'; cumulative: 'none' | 'cdf' | 'ecdf';
  unit: Unit /* the panel unit, as every kind gets it from `framePlan` (client/src/vis/framePlan.ts: '/s' after a rate rewrite, else none; #158's unit option later); used by the T21-013 display guard */ }
// Worker message (histogramClient.ts → histogram.worker.ts): { runId: number; source: 'instant' | 'range'; o: HistogramOptions /* incl. unit */;
//   q: Completeness; batch: { key: string; labels: Labels; timestamps: Float64Array; values: Float64Array }[]; last: boolean }
export type HistogramResult = { kind: 'frame'; frame: HistogramFrame }
  | { kind: 'empty'; coverage: HistogramCoverage }                                         // received 0
  | { kind: 'noneShown'; coverage: HistogramCoverage; sourceGroups: readonly SourceGroup[] } // drawable 0
  | { kind: 'tooMany'; samples: number; query: Completeness }                              // main thread, no worker
  | { kind: 'buckets'; leSeries: number; query: Completeness };                            // main thread, no worker
export function histogram(input: readonly SeriesFrame[], source: 'instant' | 'range', o: HistogramOptions /* incl. unit */,
  q: Completeness): HistogramResult;
export function binEdges(sortedAxis: Float64Array, o: HistogramOptions /* o.unit for the guard */): { edges: Float64Array; widenedTo: number | null; adjusted: number | null };
export function scaleOf(min: number, max: number): number;  // E with S = 10^E, E = ⌈log10 max(|min|,|max|)⌉ clamped to [−307, 308]; 0 when both are 0
export function binIndex(edges: Float64Array, x: number): number;                  // −1 outside; last bin closed
export function ecdfAt(f: HistogramFrame, sourceGroups: readonly number[], x: number): number; // Σ upperBound / Σ length over the slices (= a merge)
export function groupKey(label: string, value: string | null): string;  // FNV-1a 64 hex; absent → `${label}\u0001`
export function selectedCounts(f: HistogramFrame, keys: ReadonlySet<string>, s: Slicer): Promise<Float64Array | null>; // groups × k; null = no match
export function binSeries(f: HistogramFrame, groups: readonly number[], from: number, to: number, s: Slicer): Promise<string[]>; // sorted
// Slicer (histogramClient.ts) = { now(): number; signal: AbortSignal }: work yields when a step reaches 8 ms; abort rejects
export function hitTestBin(f: HistogramFrame, l: BinLayout, xCss: number, yCss: number): { index: number; group: number } | null; // via l.edgePx
export function binLabels(edges: Float64Array, unit: Unit): string[]; // T21-013 display digits
// also histogramRows(f, unit): PanelRows; histogramCoverageText(c): string; summaryFacts(title, f): SummaryFacts
// BinLayout = plot rect, edgePx (forward scale of each edge), count-axis max, per-group bar tops in CSS px.
// histogramClient.ts (main thread)
export function runHistogram(panelId: string, runId: number, input: readonly SeriesFrame[], source: 'instant' | 'range',
  o: HistogramOptions /* incl. unit */, q: Completeness, signal: AbortSignal): Promise<HistogramResult>;  // rejects AbortError when stale

// client/src/inspector: InspectorTarget gains { type: 'bin'; target: BinInspectorTarget }
export interface BinInspectorTarget { kind: 'bin'; panelId: string; index: number; from: number; to: number; closed: boolean;
  group: { other: false; key: string; name: string; labels: Labels /* raw; {} = absent */ }
    | { other: true; key: 'other'; name: string } | null;                     // null = no groupBy
  count: number; share: number; groupShare: number; cumulative: number | null; countBasis: 'series' | 'samples';
  members: MemberSection;  // ONE list (T25): grouped/no-group bin → its series (texts names, labels maps), resolve binId;
                           // other → its member groups (texts "name: count", labels), resolve `${binId}:groups`; runs null
  binId: string /* `${panelId}:${frameSeq}:${group key or 'all'}:${index}` */; query: { lang: 'promql' | 'logql'; expanded: string } }
```

The XY chart (#201) and the trend panel (#202) reuse `XRangeEvent`, `setXRange`, the nullable `tMs`
and the T21-016 worker pattern.

There is no API change. The state timeline and the histogram use the existing range routes. As in the reference
datasources, the BFF sets step ≥ the scrape interval ([T07](T07-scene-query-planner.md), default
15 s), and the `RangeFrame` `stepMs` is the gap threshold. `validateFrameData` accepts `series`, from
PromQL range or LogQL metric results via `fromRange`.

**Board spec.** OpenAPI `Vis`, Go `server/internal/spec`, TS `client/src/boards/spec.ts` and the
fixtures in `api/fixtures/board-spec/` change together, on
[T22](T22-value-categorical-and-table-panels.md)'s `Vis.options` (§6.1 there):

- `vis.kind` gains `stateTimeline` and `histogram`; options in `vis.options` (`additionalProperties: false`); there is no separate state object.
- `board.json.unknownKey`: a key the kind does not allow (incl. `thresholds` on these kinds, and depth,
  perspective, projection, tilt, bevel, shadow, shading, `3d`; T21-001). `board.options.<key>.invalid`:
  a bad value or combination. Absent = default; +1 `schema_version`, identity upcaster (T11-016),
  `vN-<kind>.json`.

| Key | Values | Default | Kind |
|---|---|---|---|
| mappings, showValues, rowHeight, perPage | as `StateTimelineSpec` | as there | stateTimeline |
| binMode | `auto` \| `count` \| `width` | `auto` | histogram |
| binCount | integer 1…200, only with `count` | 20 | histogram |
| binWidth | finite, 0 < w ≤ 1e15; required with `width`; invalid with another mode or `scale: 'log'` | — | histogram |
| scale · groupBy · groupMode · cumulative | `linear`\|`log` · `''` or `FILTER_LABEL` · `stack`\|`overlay` · `none`\|`cdf`\|`ecdf` | `linear` · `''` · `stack` · `none` | histogram |

## 6. Data & storage

No new storage. The board spec change is in §5; [T11](T11-postgres-schema.md) is unchanged.

## 7. Performance budget

| Kind | Engine: median ≥ 60 fps, p99 ≥ 45 fps on (b), during pan/zoom | Interim cap (disclosed) | LOD |
|---|---|---|---|
| stateTimeline | 5 000 rows × 1 440 steps | 500 rows ("showing 500 of N") | sub-pixel pick (T21-005) |
| histogram | 10⁷ values binned in ≤ 50 ms, 60 fps | ≤ 2·10⁶ values exact in the worker (`tooMany` beyond), ≤ 200 bins × 8 groups (T21-016) | GPU binning |

## 8. Security, tenancy & RBAC

No new data path. [T11](T11-postgres-schema.md) RLS is unchanged; the selection and Inspector target
stay in the page.

## 9. Failure modes & degradation

- Interim caps are disclosed by the coverage meter (T21-002).
- Missing data, stopped sources and vanished series are drawn Unknown and disclosed (T21-008).

## 10. Testing

The gates are in [T05](T05-testing-and-performance.md) §7.1. The implementation issues ship these
rows.

Defaults: w = [0, 6 000) ms, step 1 000 ms. A run is written (text, [from, to)). Every I-A unit row fails
today because `client/src/vis/transforms/` does not exist.

I-F rows (H1 to H26): values come from running the T21-013 operations in Node, not by hand. They are
linear, and in `count` mode when c is given. The file and gate are `histogram.test.ts` ·
`unit:dist-bins` unless named. All fail today: `client/src/vis/transforms/histogram.ts` does not exist.

| Issue | Test name (file · gate) | Setup → expected |
|---|---|---|
| I-A | "F1 merges equal states and marks NaN" (`stateRuns.test.ts` · `unit:state-runs`) | ts 0…5 000, values [0,0,1,1,NaN,1], no mappings → ('0',[0,2000)), ('1',[2000,4000)), ('no data',[4000,5000)), ('1',[5000,6000)) Fails today: `stateRuns` does not exist. |
| I-A | "F2 merges by display state and keeps part values" (same) | w [0,3000), values [1,2,1], mappings #0 1→('down', failing), #1 2→('down', failing) → one run [0,3000), mixed true, distinct [1,2], samples 3. Parts: (value 1, mapping 0, [0,1000)), (2, 1, [1000,2000)), (1, 0, [2000,3000)). With #1 2→('error', failing) → three runs, all mixed false Fails today: `stateRuns` does not exist. |
| I-A | "F3 gaps are no data" (same) | ts [2000,3000], values [0,0] → ('no data',[0,2000)), ('0',[2000,4000)), ('no data',[4000,6000)). ts [0,1000,4000] → ('0',[0,2000)), ('no data',[2000,4000)), ('0',[4000,5000)), ('no data',[5000,6000)). w [0,5500) with ts 0…4 000 → the last run ends at 5 000, and [5000,5500) is blank Fails today: `coverage` does not exist. |
| I-A | "F4 empty series is no data" (same) | no samples → ('no data',[0,6000)). No samples with w [0,500) (shorter than the 1 000 ms step) → ('no data',[0,500)), not blank. Fails today: `coverage` does not exist. |
| I-A | "F5 stopped source" (same) | w [0,900 000), step 15 000, value 1 up to ts 615 000 and nothing after → ('1',[0,630000)), ('no data',[630000,900000)) Fails today: `coverage` does not exist. |
| I-A | "F7 nan mapping relabels only" (same; `unit:board-spec`; fixture `api/fixtures/board-spec/import-null-mapping.json` for #158's import gate) | `nan`→('offline', unknown) on [1,NaN,1], w [0,3000) → ('1',[0,1000)), ('offline' hatch, state unknown,[1000,2000)), ('1',[2000,3000)). A gap shows the same text. A `nan` mapping coloured ok → `board.options.mappings.invalid`. An imported green null→'offline' is stored as unknown, with the report note Fails today: there are no `nan` mappings and the kind is unknown to the spec. |
| I-A | "F8 clips to the window" (same) | w [500,3000), ts [0,1000,2000], values [0,0,1] → ('0',[500,2000)), ('1',[2000,3000)). A sample at −2 000 contributes nothing Fails today: `coverage` does not exist. |
| I-A | "F9 reduction marks claim no identity" (`reduceRow` · `unit:state-runs`) | px [0,100) holds ok [0,30), series-mapped 'v2' [30,80) and unmapped 7 [80,100). It draws one reduction mark "3 states" in `reduced`, with no glyph. With 7 replaced by failing [80,100), the same neutral mark gets the ■ glyph above it. With watch and failing as members in the same px: one shared tick at that px, the cluster glyph ■, and the meter reads "1 reduced marks (3 parts)…". Fails today: `reduceRow` does not exist. |
| I-A | "F9b hit-test inside a reduction" (`hitTest` · `unit:state-runs`; `e2e/chart-select.spec.ts` · `e2e:chart-select`) | F9's pixel holds ok [0,30), 'v2' [30,80) and failing [80,100). At atMs 50, `selected` is 'v2' [30,80) and `selectedRun` is the 'v2' run. `displayed` is {fromMs 0, toMs 100, text '3 states', state failing, texts ['ok','v2','failing']}, with `reason` `reduced`. At atMs 90, `selected` is failing and `displayed` is the same reduction. In e2e (a 10 device-px plot over w [0,1000)), a click at the time of 50 ms opens the Inspector with selected 'v2', "Shown as: 3 states (reduced: 3 parts)" and the members listed, and draws the selection band [30,80). Fails today: there is no `hitTest` and the click emits nothing |
| I-A | "F10 categories never share a non-colour channel" (`stateRuns.test.ts` · `unit:state-runs`; `e2e/golden-gallery.spec.ts` · `golden:greyscale`) | **Unit:** nine `role: 'series'` mappings v1…v9, where v1 and v4 share index 2 and v2 and v5 share index 5. v1…v7 get `CATEGORY_PATTERNS[0…6]`, all distinct. v8 and v9 are "other (2)" with `grid` and `category-other`, Values [v7, v8, v9, v8, v1] at 1 s steps give the runs ('v7',[0,1000)), ('other (2)',[1000,4000)) and ('v1',[4000,5000)). The other run has mixed true, texts ['v8','v9'], colour `{ role: 'other' }` and pattern `grid`, and each of its parts has displayColour `{ role: 'other' }`. A board spec mapping with colour `{ role: 'other' }` is rejected with `board.options.mappings.invalid`, because the board-spec schema has no such role. Its parts keep text 'v8', 'v9', 'v8', with displayText 'other (2)' and inOther true. A click at 2 500 gives Inspector selected.text 'v9 (in other)' and displayed.text 'other (2)'. The CSV rows for the run read text 'v8 (in other)', 'v9 (in other)', 'v8 (in other)' and display text 'other (2)'. **Gallery** `state-timeline-categories`, under the greyscale filter: one row with one 40 px segment per category gives 8 visibly distinct marks (7 patterns plus other), and the legend lists 7 categories, "other (2): v8, v9" (with "+k more" beyond 8 texts), the states and the reduction mark. A second row repeats v1 and v4 (same colour) at 10 px each and they still differ by pattern. A third row has v1 and v4 at 4 px each, side by side: they draw as one neutral reduction "2 states" with no glyph, the meter reads "1 reduced marks (2 parts)…", and hovering lists v1 and v4. Fails today: no pattern channel, no other merge and no gallery entry exist |
| I-A | "F11 reduction is disclosed" (`stateRuns.test.ts` · `unit:state-runs`) | The F9 pixel (3 parts) plus one 4 px part elsewhere → k = 2, n = 4, and the meter reads "2 reduced marks (4 parts): hover or zoom to identify". Zooming until every part is ≥ 6 px → the line disappears. Fails today: no reduction accounting exists |
| I-A | "F12 narrow states and categories in greyscale" (`e2e/golden-gallery.spec.ts` · `golden:greyscale`, gallery entry `state-timeline-narrow`) | One row of wide ok segments (40 px) separated by isolated 3 px parts: failing, watch, ok, v1 and v4 (v1 and v4 share a colour). Under greyscale, all five reductions have identical neutral pixels (sampled at the mark centre, all equal). Only the failing and watch reductions carry glyphs (■ and ◐, distinct shapes). Hover over each lists its single member ("failing", "watch", "ok", "v1", "v4"). Fails today: there is no reduction mark and no entry |
| I-A | "F13 reduction works on runs, not samples" (`stateRuns.test.ts` · `unit:state-runs`) | 1 px per sample, w = 502 samples: 200 × ok, 2 × failing, 200 × ok, 100 × failing → runs ok [0,200), failing [200,202), ok [202,402), failing [402,502). Only failing [200,202) is short. It is one reduction "1 state", px [200,202), with ■ at x = 201. The three wide runs are drawn normally, with transitions at px 200, 202 and 402, and the wide failing run keeps its colour, solid fill and glyph. **Two failures close together:** runs failing 2 px [600,602), ok 3 px [602,605), failing 2 px [605,607), between wide ok runs, become one reduction "3 states" at px [600,607), as all three are short. The failing centres at 601 and 606 are 5 px apart, so they form a cluster. Ticks are drawn at x 601 and 606, and one ■ is drawn over the cluster at x 603.5. Both failure locations stay visible. **Far apart:** the same with an ok run of 20 px between the two failing runs gives two reductions, each with its own ■ at x 601 and 623. Fails today: there is no run-based reduction |
| I-A | "F9c keyboard on a reduction" (`e2e/chart-select.spec.ts` · `e2e:chart-select`) | On the F9 panel, Tab to the frame, then ← and → move focus to the "3 states" mark, and Enter opens the Inspector: `atMs` 0, selected ok [0,30), displayed {0, 100, '3 states', failing, members ok, v2 and failing}, `reason` `reduced`, text "Shown as: 3 states (reduced: 3 parts)". Space gives the same. Fails today: keyboard focus does not resolve through `hitTest` |
| I-A | "F14 complete member lists" (`stateRuns.test.ts` · `unit:state-runs`; `e2e:chart-select`) | A reduction of 12 short runs: `members` has 8 entries and `memberCount` 12. The Inspector shows "+4 more", and opening it calls `resolveMembers` and lists 12. An "other" run over 10 distinct texts v8…v17: `texts` has 8 entries and `textCount` 10. The legend and Inspector show "+2 more", and resolving lists 10. Fails today: there are no member lists |
| I-A | "F15 hit-test reaches every member and part" (`stateRuns.test.ts` · `unit:state-runs`) | A reduction of 12 short member runs, where member 10 [x, x + 3 px) is itself a merged run of three parts with values 1, 2, 1 ('down', mixed). `hitTest` at the instant of its second part gives selectedRun = member 10, selected = the part with value 2, mapping 1 and text 'down', displayed = the reduction facts, and `reason` `reduced`. At an instant in member 12, the beyond-8 member is the selectedRun. Fails today: there is no `hitTest` |
| I-A | "F16 vanished beats nan text" (`stateRuns.test.ts` and `vanished.test.ts` · `unit:state-runs`) | Mapping `nan`→'offline'. Refresh R1 has A and B. R2 returns A with all-NaN values and omits B. A is ('offline',[0,6000)), and B (appended, `vanished: true`) is ('no longer returned',[0,6000)). Fails today: `SeriesFrame` has no `vanished` and there is no key memory |
| I-A | "F18 only complete refreshes mark vanished" (`vanished.test.ts` · `unit:state-runs`) | R1 is complete with {A,B}. R2 has {A} with `truncated: true`: no "no longer returned" row, rows = A only, and the meter shows the existing "truncated" disclosure and no vanished count. R3 is complete with {A}: B is appended, `vanished: true`, ('no longer returned',[0,6000)), and the meter reads "1 series no longer returned". A warning-only refresh behaves like R2. The appended frame's `timestamps` and `values` are empty `Float64Array`s. Fails today: there is no key memory |
| I-A | "F17 run ids are unique per panel" (`stateRuns.test.ts` · `unit:state-runs`; `e2e:chart-select`) | Panels P1 and P2 have identical series (key K), timestamps and a 12-member reduction. Their runIds differ (`P1:K:r…` and `P2:K:r…`). `resolveMembers('P2', runId of P2)` returns P2's 12 members, and resolving P1's id with panel P2 returns nothing. Fails today: runIds do not exist |
| I-A | "F6 vanished keys stay Unknown" (`client/src/boards/vanished.test.ts` · `unit:state-runs`) | All refreshes complete. R1 {A,B} → 2 rows, "100 %". R2 {A} → rows A and B; B is ('no longer returned',[0,6000)) and the meter reads "1 series no longer returned". R3 {A} → the same. R4 {A,B} → B drawn from its data, "100 %". R5 {A} after the query text changes → A only, "100 %". Fails today because there is no key memory |
| I-A | "row 9 picks the state timeline" (`client/src/vis/autovis.test.ts` · `unit:autovis-table`) | `up` gridded → stateTimeline (rule 9). {0,1,2} with no mappings → line (rule 14). A histogram → heatmap (rule 5). Fails today because `autoVis` has no rule 9 |
| I-A | "click opens the Inspector with the part and the run" (`e2e/chart-select.spec.ts` · `e2e:chart-select`) | A board with panel A (stateTimeline, F2 data, key K) and panel B (line on the same series). A click at 1 500 opens the Inspector with `atMs` 1500, selected {1000, 2000, value 2, mapping 1, text 'down', state failing} and displayed {0, 3000, 'down', failing, mixed true, distinct [1,2], samples 3}. On the next frame, B rings K and draws the band [0,3000). Enter on the focused segment → atMs 0, selected value 1, mapping 0. Esc → no Inspector and no band. With the F8 data, a click at 600 → displayed {500, 2000}, and the band starts at 500. Fails today because the click emits nothing |
| I-A | "table and CSV list parts" (`e2e/chart-select.spec.ts` · `e2e:table-csv`) | On the F2 panel, `Shift+T` → 3 rows (run 0; values 1, 2, 1; text 'down'), and "Export CSV" downloads the same 3 rows. Fails today because the kind does not exist |
| I-A | "summary facts name the latest transition" (`summaryFacts.test.ts` · `unit:summary-facts`) | ok→failing at 12:22 → change {'ok', 'failing', 12:22}, current failing; extent and baselineRatio are null Fails today: `summaryFacts` does not exist and `FrameSummary` has no `facts`. |
| I-A | "gallery state-timeline-states" (`e2e/golden-gallery.spec.ts` · `golden:interim-gallery`, `golden:greyscale`) | A new entry `state-timeline-states` in `client/src/dev/gallery.ts`: seed `GALLERY_SEED`, 3 series × 60 steps with ok/watch/failing mappings and one no-data run. `toHaveScreenshot('gallery-state-timeline-states-{dark,light}.png')` equals the committed baselines, and the greyscale variant keeps every state distinct by glyph and pattern. Fails today because the entry does not exist |
| I-A | "state panel spec validation" (`server/internal/spec/validate_test.go`, `client/src/boards/spec.test.ts` · `unit:board-spec`; shared `v{N}-stateTimeline.json` and `invalid.json`) | Each pointer and its error key: `/panels/0/vis/options/mappings` on kind line → `board.json.unknownKey`; `…/options/rowHeight` 0.4 → `board.options.rowHeight.invalid`; `…/options/shadow` → `board.json.unknownKey`; `/panels/0/vis/thresholds` on stateTimeline → `board.json.unknownKey`; `…/options/mappings/0/colour` (nan → ok) → `board.options.mappings.invalid`. The valid fixture round-trips byte-equal through canonical JSON. Fails today with `board.vis.kind` |
| I-A | "interim redraw at the cap" (`e2e/perf-chart-redraw.spec.ts` · `bench:frame-interim-time-kinds`) | Entry `state-timeline-cap`: 500 series × 1 440 steps, 3 states, change probability 0.05 per step, `GALLERY_SEED`. Script: 30 wheel-zoom steps at the centre, then 20 drags of 100 px. Reports redraw p50 and p95 (report-only). Fails today because the entry does not exist |
| I-F | H1 "count bins" | [1,2,2,3,4,10], c 3 → edges [1, 4, 6.999999999999999, 10], counts [4,1,1], share 0.6667/0.1667/0.1667, CDF [0.6667,0.8333,1] |
| I-F | H1b "edge labels" (`unit:dist-bins`; `e2e:hist-inspect`, `e2e:table-csv`) | H1, unit none: `binLabels` → ["1", "4", "7", "10"]; tooltip header "4 – 7"; table from/to "4", "7"; Inspector "Bin 4 – 7"; summary "mode 1 – 4"; CSV keeps 6.999999999999999. H3 meter "bin width widened to 5 (200-bin cap)". Close edges [1, 1.0000000000000002] → labels "1", "1.0000000000000002" (d 17) |
| I-F | H1c "unit labels at the domain bounds" (`unit:dist-bins`; `e2e:hist-inspect`, `e2e:table-csv`) | auto [−1e290, 1e290], `o.unit` time ns → tooltip, table and Inspector ranges from ["-1.5e+281 s", "-1e+281 s", "-5e+280 s", "0 s", "5e+280 s", "1e+281 s", "1.5e+281 s"]; [1e−290, 1e−289] ns → ["0 s", "2e-299 s", …, "1e-298 s"]; [nextDown(1e290), 1e290] ns → ["9.999999999999999e+280 s", "1e+281 s"] (d 16); percentunit [−1e290, 1e290] → ["-1.5e+292 %", …, "1.5e+292 %"], the adjacent pair → ["9.999999999999998e+291 %", "1e+292 %"]; `format.test.ts` gains the changed outputs above and keeps every existing case |
| I-F | H1d "display-collapsed bin" (`unit:dist-bins`; `e2e:hist-inspect`, `e2e:table-csv`) | `o.unit` percentunit, [1.4770205796360079, 1.477020579636008] → one bin, `adjusted` 1, `collapsed` true; axis, tooltip, table and Inspector read "≈ 148 %"; CSV keeps both raw edges. `o.unit` time ns, [247.05306063578868, 247.0530606357887] → "≈ 247 ns" in the same four places. With 300 ns added → [240, 260, 280, 300], "240 ns" … "300 ns", not collapsed |
| I-F | H2 "width bins close the last" | [0.5,1.2,1.9,2.0,7.3], w 1 → edges 0…8, counts [1,2,1,0,0,0,0,1]; [0,10], w 5 → [0,5,10], [1,1] |
| I-F | H3 "width cap widens" | [0,1000], w 1 → k 1000 → w 5, 200 bins, meter "bin width widened to 5 (200-bin cap)"; [0,1], w MIN_VALUE → w 0.005, 200 bins, edges 0…1 |
| I-F | H4 "auto bins" | 1…100 → [0,20,…,100], [19,20,20,20,21]; [−7,−1,3] → w 2, [−8,−6,…,4], [1,0,0,1,0,1]; [5,5,5,5,9] → [5,6,7,8,9], [4,0,0,1]; [3,3,3] → [2.75,3.25]; [0] → [−0.5,0.5]; width 1 over [0.5, 200.5] → k 201 → w 2, edges [0,2,…,202] (101 bins), `widenedTo` 2 |
| I-F | H5 "log excludes per group and CDF ends at 100 %" | log, c 2, overlay, cdf: A [0,1,10], B [1,100] → edges [1,10,100]; A counts [1,1], received 3, drawable 2, CDF [0.5,1]; B [1,1], CDF [0.5,1]; stack-wide CDF [0.5,1]; meter "1 ≤ 0 not shown (log)"; hover at the px of 5 → `bin` {from 1, to 10}; a brush over both bins → `xRange` {1, 100} and keys of A and B; table ranges "1 – 10", "10 – 100" |
| I-F | H6 "zero-drawable group and panel" | log; groups A [1,10], C [0] → C not drawn, legend "C (no values shown)", no C curve. Log; A [0,0], B [0,+Inf] → `noneShown` with A {nonPositive 2}, B {nonPositive 1, infinite 1}: plot "No values shown: 3 ≤ 0 not shown (log) · 1 infinite values not shown"; legend A, B "(no values shown)"; popover "A: 2 ≤ 0", "B: 1 ≤ 0, 1 infinite"; table rows A ≤ 0 2, B ≤ 0 1, B infinite 1 |
| I-F | H6c "exclusion precedence" (`unit:dist-bins`; `e2e:hist-inspect`, `e2e:table-csv`) | log; A [−1e−300, −1, 0, 1, 10, +Inf, 1e300] → infinite 1, outOfRange 2 (−1e−300, 1e300), nonPositive 2, drawable 2; meter "2 ≤ 0 not shown (log) · 1 infinite values not shown · 2 values out of range not shown"; popover "A: 2 ≤ 0, 1 infinite, 2 out of range"; table rows A ≤ 0 (log) 2, infinite 1, out of range 2 |
| I-F | H7 "non-finite and duplicates" | range A ts 0…3 [1,NaN,+Inf,2], A′ (same labels) ts [0] [5], B [−Inf,3] → values {5,2,3}, received 5, drawable 3; meter "2 infinite values not shown · 1 duplicate series combined; 1 conflicts (max kept)" |
| I-F | H8 "empty, too many, buckets" | no series → `empty`, meter `100 %`; truncated → meter "truncated"; 2 000 001 samples → `tooMany`, no worker started, no legend, table = 1 notice row; instant series with `le` and differing timestamps → `buckets`, the same consumers; one `le` series among others → `buckets` |
| I-F | H9 "groups and other" (+ gallery `histogram-groups-other` · `golden:interim-gallery`, `golden:greyscale`) | version v1…v9 (drawable 10…2) plus one series without it (1) → v1…v7 with patterns and dashes [0…6]; `other (3)` = v8, v9, "version absent", `grid`, last; value `other` → `"other"`; greyscale: 8 marks distinct |
| I-F | H10 "other payload and rows" | in H9 (c 1), click `other` → target `group` {key 'other', name 'other (3)', other true}, `members` [{v8,3},{v9,2},{version absent,1}], count 6; table: v8, v9, "version absent" rows, shown as `other (3)` |
| I-F | H11 "ECDF is exact" | overlay A [1,2,2,3], B [2,4]: A at 0.9/1.5/2/3 → 0/0.25/0.75/1; B at 2/3.9/4 → 0.5/0.5/1; stack-wide at 2 → 4/6; tooltip at 2 "A ≤ 2: 75 %", "B ≤ 2: 50 %" |
| I-F | H12 "ECDF exact at 10⁶" | 10⁶ seeded values in 3 groups: `ecdfAt` per group and pooled at 50 points = brute-force counts; `sorted.offsets` = cumulative group drawables |
| I-F | H13 "hit regions" | CSS y from the plot top, baseline y 100. H1 on 300 × 100 px (bar tops y 0, 75, 75): (150,80) → bin 1; (150,73) → bin 1 (3 px); (150,70) → null; (100,90) → bin 1; (−1,90) → null; a 1 px bar (top y 99): y 97 → hit (4 px minimum). Overlay tops A y 40, B y 70: y 38 → A; 68 → B; 55 → A; 80 → B (smaller); 30 → null; equal tops → lower j |
| I-F | H14 "click, keys, Inspector" (`e2e/hist-inspect.spec.ts` · `e2e:hist-inspect`) | P: range A [1,2,2], B [3,4,10], c 3; line panel L on A, B. Click bin 0 → "Bin 1 – 4", 4, 66.7 %, series [A,B]; L rings both. Bin 2 → [B]. Tab →→ Enter → bin 2, keyboard. Click above bin 1 → selection null. c 9, bin 5 (count 0): Enter → "empty bin". Esc → selection cleared; Esc → Inspector closed |
| I-F | H15 "value brush" (same) | drag bin 1 → bin 2: `xRange` {4,10}, band, keys [B]; Shift+← from bin 2 gives the same; Esc clears the band, then the selection |
| I-F | H16 "selection from another panel" (`unit:selection-draw`) | P; selection {[A]} from L → `selectedCounts` [3,0,0], bars dimmed; {[B]} → [1,1,1]; {[foreign]} → null, nothing dims |
| I-F | H17 "rows describe source groups" (`e2e:table-csv`) | H5 → A rows ("1 – 10": 1; "10 – 100": 1), A "≤ 0 (log)" 1, B rows; CSV = table |
| I-F | H17b "ECDF rows of other members" (`unit:dist-bins`, `e2e:table-csv`) | H9's v1…v7 (every value 3) plus v8 [1,5] and v9 [2,2,9] (both in `other`), c 2 over [1,9] → edges [1,5,9]; rows v8 [1,5) 1, 100 %; v8 [5,9] 1, 100 %; v9 [1,5) 2, 66.7 %; v9 [5,9] 1, 100 %; the `other` curve at 5 = 80 % (4 of 5) |
| I-F | H18 "summary facts use exact quantiles" (`unit:summary-facts`) | H1 → "median 2.5; mode 1 – 4 (4 of 6)", extent {1,10}, change null, `cumulative: 'none'`; [1,3.9,3.9,3.9,4,10], c 3 → the same counts [4,1,1] but "median 3.9" |
| I-F | H18b "per-group exclusions" (`unit:dist-bins`; `e2e:hist-inspect`) | log; A [0,0,1], B [0,+Inf,2], plus H9's v1…v7 and v9 [0,3] in `other` → meter "4 ≤ 0 not shown (log) · 1 infinite values not shown"; Enter on the ≤ 0 part → popover "A (in other (3)): 2 ≤ 0", "B (in other (3)): 1 ≤ 0, 1 infinite", "v9 (in other (3)): 1 ≤ 0" (A, B, v9 have drawable 1, below v1…v7); without v1…v7 → "A: 2 ≤ 0", "B: 1 ≤ 0, 1 infinite", "v9: 1 ≤ 0"; table exclusion rows equal |
| I-F | H19 "board spec" (`spec.test.ts`, `validate_test.go` · `unit:board-spec`) | `…/vis/options/binCount` 201 or with `auto` → `board.options.binCount.invalid`; `width` without binWidth, or binWidth + log → `board.options.binWidth.invalid`; `groupBy` "1x" → `board.options.groupBy.invalid`; `options/perspective`, `options/mappings`, `vis/thresholds` → `board.json.unknownKey`; `vN-histogram.json` round-trips; Go = TS |
| I-F | H20 "Inspector model and identity" (`model.test.ts` · `unit:inspector-model`; `e2e:hist-inspect`) | H14 and H10 targets in T25-003 order, pivots on the origin window, fields equal `origin`. A grouped bin with 10 series {pod: p0…p9} → 8 shown, "+2 more" resolves `binId` to 10 texts with each series' labels; value `other` → name `"other"`, `labels` {version: 'other'}, chip `version="other"`; absent group → `labels` {}, "version: (no value)", no filter; an `other` bin with 12 members → 8 shown, "+4 more" resolves `${binId}:groups` to 12 with labels, `other` has no chip; a refresh before "+k more" → resolver null → T25 stale text |
| I-F | H23 "no time axis interactions" (`histogram.test.ts`; `e2e:hist-inspect`) | `ghost` and `anomaly` true → no throw, frame pixels equal to off, tooltip and menu show both lines; a hover on a line panel → histogram unchanged with no error; a hover on the histogram → the line panel draws no crosshair, and the menu shows the crosshair line |
| I-F | H24 "edges at the domain bounds" (`unit:dist-bins`) | Each case terminates with finite, strictly increasing edges and Σ counts = drawable. [−1e290, 1e290]: auto → [-1.5e+290, -1e+290, -5e+289, 0, 5e+289, 1e+290, 1.5e+290], [0,1,0,0,0,1]; c 3 → [-1e+290, -3.333333333333335e+289, 3.3333333333333324e+289, 1e+290]; on 400 px `edgePx` = 400·i/6, px 200 → bin 3, px 400 → bin 5, px 401 → null, brush px 150–250 → bins 2–3, {-5e+289, 5e+289}, brush px 333.4–400 → bin 5, {1e+290, 1.5e+290}; px 390–450 → bin 5; px −50–10 → bin 0; px 410–450, −50–(−10), 400–450 and −50–0 → nothing. [nextDown(1e290), 1e290]: c 50 and auto → [9.999999999999999e+289, 1e+290], `adjusted` 1. [1, 1.0000000000000002], w 1e−16 (\|q\| > 2⁵²) → one bin, `adjusted` 1. [1e−290, 1e−289] auto → [0, 2e-290, 4e-290, 6.000000000000001e-290, 8e-290, 1e-289], [1,0,0,0,1]. Singles: 0 → [-0.5, 0.5]; ±1e290 → [9.5e+289, 1.0500000000000001e+290] and its mirror; ±1e−290 → [9.000000000000001e-291, 1.1e-290] and its mirror. Out of range: [1e300, 5e−324, 1, 2], c 2 → [1, 1.5, 2], [1,1], `outOfRange` 2, meter "2 values out of range not shown", popover and table per group |
| I-F | H25 "log edges at the lower bound" (`unit:dist-bins`; gallery `histogram-log-tiny` · `golden:interim-gallery`) | log, auto, [1e−290, 1e−289] → [1e-290, 1.7782794100389227e-290, 3.162277660168379e-290, 5.62341325190349e-290, 1e-289], [1,0,0,1]. On 400 px `edgePx` ≈ 0, 100, 200, 300, 400 (1e−6 px); px 100 → bin 1; px 400 → bin 3; brush px 99.9–100.1 → bins 0–1, {1e-290, 3.162277660168379e-290} |
| I-F | H26 "terminal log rule" (`unit:dist-bins`) | log, 400 px. [nextDown(1e290), 1e290] (equal log10) → [3.1622776601683795e+289, 3.1622776601683794e+290], counts [2], `adjusted` 1; px 0 and px 400 → bin 0; brush px 0–400 → the whole bin. Singles 1e290 → [9.5e+289, 1.0500000000000001e+290] and 1e−290 → [9.000000000000001e-291, 1.1e-290], `adjusted` null |
| I-F | H21 "stale runs are dropped" (`histogramClient.test.ts` · `unit:hist-worker`) | runs R1 then R2 before R1 returns → R1 worker terminated, R1 rejects AbortError, only R2 applied; a late R1 message → ignored. Fake clock +1 ms per 25 000 values copied → batches cut at 200 000 values; `selectedCounts` over 2·10⁶ CSR entries at +1 ms per 10⁵ yields ≥ 2 times and equals the synchronous reference; a newer selection aborts the older scan |
| I-F | H22 "no long tasks" (`e2e/perf-rooms-long-tasks.spec.ts` · `bench:rooms-long-tasks`), gallery | scenario "histogram 2·10⁶ values" (run, hover, brush, click a bin, select all keys from a line panel): CI no task > 50 ms wall with > 16 ms thread; lab none > 16 ms (PRF-005). Gallery `histogram-latency-ecdf` dark/light = baselines |
| I-E | "engine state timeline at 5 000 rows" (`bench:frame-gallery`, (b)) | Page `state-timeline-5000`: 5 000 series × 1 440 steps, same generator and script. Median ≥ 60 fps and p99 ≥ 45 fps (VIZ-004, PRF-001, PRF-002). Fails today because the engine has no state timeline |
| #94 | "3D forms occlude and link" (`golden:3d-occlusion`, `replay:3d-linked-2d`, `bench:frame-gallery`) | The VIZ-086 acceptance holds. At the §4.3 scales, median ≥ 60 fps and p99 ≥ 45 fps on (b). Fails today because there are no 3D forms |

## 11. Rollout

Implementation breakdown (filed after merge, in this order):

| # | Title | Mode | Depends | Requirement IDs | Acceptance (tests in §10) |
|---|---|---|---|---|---|
| I-A | State timeline panel with value mappings, Unknown coverage and Inspector target | 2D-now, M-UI3 | **#164** (Inspector contract and wiring) | VIZ-009, VIZ-065, VIZ-066, VIZ-067, VIZ-069, VIZ-003 | T21-002 to T21-005 and T21-007 to T21-011; the seam ADR; board spec v+1 with the stateTimeline `vis.options` keys; interim cap of 500 rows; gallery page; docs |
| I-E | Engine port of the state timeline | Engine, M-UI3 | #68, #69, I-A | VIZ-001, VIZ-004, VIZ-009 | Same transform fixtures (T21-002); the §7 target passes `bench:frame-gallery` |
| — | Comment on #94 linking T21 §4.3 | 3D engine, M-UI3 | #68, #69 | VIZ-085, VIZ-079, VIZ-086 | Adds `golden:3d-occlusion` and `replay:3d-linked-2d` |

Part 2a (#154), filed after merge:

| # | Title | Mode | Depends | Requirement IDs | Acceptance (tests in §10) |
|---|---|---|---|---|---|
| I-F | Histogram panel: bins, groups, CDF/ECDF, value brush, bin Inspector target | 2D-now, M-UI3 | #192, #173 (`Vis.options`) | VIZ-090, VIZ-028, VIZ-003, VIZ-005, VIZ-066, VIZ-067, PRF-005 | T21-012 to T21-016; H1 to H26 (with H1b, H1c); a seam ADR amending ADR-0014 §3 (§5); board spec next version; gallery; docs |
| I-F2 | Engine port of the histogram | Engine | #68, #69, I-F | VIZ-001, VIZ-004 | Same fixtures; the §7 row on `bench:frame-gallery` |
| #206 | Design: histogram of histogram buckets (T21 part 2a-ii) | design | #154 | VIZ-028 | Per-partition detection and alignment, one terminal +Inf, zero-crossing buckets on log, bucket-family selection; rules T21-060 to T21-069 |

A new design issue, to be filed: **"Design: status history panel (worst-wins grid)"**. It covers VIZ-009,
VIZ-065 (row 9 regular step), VIZ-066 and VIZ-067, depends on #150 and #164, and starts from a draft
(not tracked). That draft carries the open items:

- a status cell clicked outside its worst part;
- a rank for series-mapped values;
- the "regular step" note.

How this design relates to the other issues:

| Issue | Relation |
|---|---|
| #158 | A superset of T21-011 |
| #159 | Uses the T21-001 lint |
| #160 | Consumes T21-010 |
| #161 | Depends on I-A |
| #164 | MUST accept `StateInspectorTarget`: [T25](T25-inspector-and-pivots.md) `{type:'stateRun', target}` |
| #170, #173 | Board-spec options per §5 (1.2-rc): the stateTimeline keys live in `vis.options` |
| #201, #202 | Reuse `XRangeEvent`, `setXRange`, the nullable `tMs` and the T21-016 worker |
| #206 | Bucket histograms; the `buckets` notice (T21-012) points there |

**IDs.** Part 1 uses VIZ-086 and T21-001 to T21-011. Part 2a (#154) uses VIZ-090 and T21-012 to
T21-016 of its range T21-012 to T21-029, #161 owns T21-030 to T21-039, and #206 owns T21-060 to
T21-069.

## 12. Alternatives considered

Rejected:

- one seam ADR now;
- pseudo-3D, which the owner banned;
- 3D for every type (VIZ-031);
- for the histogram: bucket-histogram sources here (split to #206); sampling, which would make the ECDF
  approximate; binning in the frame; a `BrushEvent` variant for the value brush; pseudo-3D (T21-001);
- per-panel staleness machinery. The reference datasources send no lookback override, and a query
  panel cannot know its expected entities; that is entity health (AUD-008, Epic #6).

## 13. Open questions

None.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-24 | #150 |
| 1.1-rc | 2026-11-25 | #164 ([T25](T25-inspector-and-pivots.md)): T21-009 writes the T25 `Selection` and opens the Inspector with `{type:'stateRun', target}`; Esc per T25-007, and an empty click clears only the selection; members per T25-011. §5: T25 `Selection`; nullable `SelectEvent.item`; `MemberFacts` from `inspector/members.ts` |
| 1.2-rc | 2026-11-25 | #154 (Part 2a): the histogram over raw values ([VIZ-090](../product/05-visualisation-catalogue.md#viz-090--histogram-and-cumulative-overlay)): T21-012 to T21-016 (values and exclusions, bins with the display guard and the terminal log rule, groups and "other (n)", CDF and exact ECDF, non-time interactions with the value brush and the `bin` Inspector target, the per-panel worker, the coverage meter and the notices); §3, §4.2, §4.3, §4.5, §4.6 and §7 rows; §5 histogram seam and transforms; the board spec moves the stateTimeline keys into T22's `Vis.options` and adds the histogram keys (T21-011, F7, F10 and the state-spec row follow); §10 H1 to H26; §11 I-F, I-F2 and #206; mockup 42-histogram. Code review r1: `SummaryFacts.extent` is `{ min; max } | null`, as T22-014 and T21-015 fill it |
