# T23 — Graph, trace, profile and hierarchy panels

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.1-rc · 2026-11-25 |
| **Milestone** | M-UI2 (2D flame, suspects) → M-UI3 (3D flame) |
| **Related ADRs** | [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0019](../adr/0019-chart-frame-drawn-event-and-frame-id.md), [ADR-0020](../adr/0020-chart-camera-commit-and-value-range.md) (I1 adds a seam ADR at the next free number) |
| **Source draft** | plans/152 (not tracked) |

This version covers the **flame graph** (rules T23-001 to T23-039, [VIZ-105](../product/05-visualisation-catalogue.md#viz-105--3d-flame),
[VIZ-106](../product/05-visualisation-catalogue.md#viz-106--flame-top-suspects) and mockup
[40-flame-3d](../mockups/40-flame-3d.svg)). The node graph, trace and hierarchy panels are added by #156
(T23-040 onward).

## 1. Context & problem

The flame graph of [05](../product/05-visualisation-catalogue.md) §4 (VIZ-036) and the profiles
workbench of [04](../product/04-surfaces.md) (SRF-046) must render 10⁵ frames (PRF-021), lead the user
to the hottest frame in at most two actions, show regressions against a baseline, and offer a true 3D
form ([VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only)).

The approach is a **true 3D scene whose top orthographic view is the icicle**: X = share of total,
Z = stack depth, Y = self (VIZ-031). Rail row ① is always the hottest frame, so its detail is one
action from opening. Regressions glow (VL-004). Zoom-out is one gesture. 2D is drawn on the interim
`ChartFrame` (also the fallback #68 keeps); 3D needs the engine.

## 2. Goals / non-goals

Goals: the 2D icicle with zoom, search, top table, suspects rail, minimap, crumbs and type switcher
(M-UI2); diff, baseline fetch and sandwich in 2D (M-UI2); the 3D flame with camera, fly-to, LOD,
labels, VIZ-078 features, linked dock and morph (M-UI3); diff, ghost and sandwich in 3D (M-UI3).

Non-goals:
- the node graph, trace and hierarchy panels (#156; T23-040 onward);
- the profile routes, schemas, errors and types of the data plane (#162);
- the flame landscape over time (#163, VIZ-107–114);
- span to profile ([SRF-048](../product/04-surfaces.md#srf-048--span-to-profile)).

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [VIZ-036](../product/05-visualisation-catalogue.md#viz-036--flame-graph) | §4 (T23-003, T23-010, T23-013, T23-014, T23-017) | `unit:flame-search-dense`; `e2e:flame-2d` |
| [VIZ-106](../product/05-visualisation-catalogue.md#viz-106--flame-top-suspects) | §4 (T23-006, T23-007) | `unit:flame-suspects`; `unit:flame-suspects-diff`; `e2e:flame-two-actions` |
| [VIZ-105](../product/05-visualisation-catalogue.md#viz-105--3d-flame) | §4 (T23-001, T23-008 to T23-012, T23-016) | `e2e:flame3d-nav`; `golden:flame3d`; `e2e:flame3d-modes` |
| [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only) | §4 (T23-001) | `golden:flame3d` |
| [VIZ-005](../product/05-visualisation-catalogue.md#viz-005--lod-never-hides-signal-silently) | §4 (T23-004) | `unit:flame-merge` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | §7 (auto-vis) | `unit:autovis-profile` |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis) | §4 (T23-018) | `e2e:flame-a11y` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel) | §4 (T23-018, T23-025) | `e2e:flame-a11y`; `golden:flame-greyscale` |
| [VIZ-076](../product/05-visualisation-catalogue.md#viz-076--3d-labels-are-billboards-with-leader-lines) | §4 (T23-005) | `unit:flame-labels` |
| [VIZ-077](../product/05-visualisation-catalogue.md#viz-077--space-is-3d-signals-are-2d-and-both-are-linked) | §4 (T23-020) | `e2e:flame3d-controls` |
| [VIZ-078](../product/05-visualisation-catalogue.md#viz-078--shared-3d-chart-features) | §4 (T23-019) | `e2e:flame3d-controls` |
| [SRF-046](../product/04-surfaces.md#srf-046--flame-graph-diff-and-top-table) | §4 (T23-006, T23-013, T23-023), §5 (type switcher) | `e2e:flame-types`; `e2e:flame-baseline-range`; `unit:flame-diff`; `unit:flame-diff-cost` |
| [INT-016](../product/03-interaction-model.md#int-016--esc-and-enter-ladder) | §4 (T23-011) | `e2e:flame-escape` |
| [VL-004](../product/08-visual-language.md#vl-004--deviation-glow-is-the-only-effect) | §4 (T23-006, T23-015) | `golden:flame3d` |

## 4. Design

### 4.1 Behaviour

Open → fetch per T23-023 (I1: merge; from I2: diff when the baseline is available) → framed whole, ①
focused → one click on ① or `Tab` → selection, flight and Inspector (#164). Out: `Shift+F`, `Alt+←` or
the `Esc` ladder (T23-011). Load and failure handling per T23-022.

State: suspects, search, brush, options and crumbs are React state; the camera, LOD, labels and
picking belong to the render worker (ADR-0020 commits). A new answer keeps root and selection by name
path.

### 4.2 Flame graph rules

#### T23-001 — True 3D only
**MUST** — Applies [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only). The 3D
flame is a real scene (boxes, an orbit/pan/dolly perspective camera, depth test,
[08](../product/08-visual-language.md) §10 light). The 2D views stay flat: no bevels, extruded fills,
drop shadows, isometric skins or gradient shading.

#### T23-002 — Flame frame
**MUST** — `data/decode.ts` rejects, at a JSON pointer, a broken invariant.
- **Common:** arrays of length N ≥ 1; an explicit `parent` array (int, −1 = root) is required, and
  node 0 is the only root; parent[i] < i and level[i] = level[parent[i]] + 1; levels non-decreasing;
  name < names.length; integers in [0, 2^53 − 1].
- **Counts:** every count is a JSON **decimal string** (`^(0|[1-9][0-9]{0,15})$`), which #162 must
  emit; it is parsed with `BigInt` and checked against `Number.MAX_SAFE_INTEGER` before conversion, so
  no literal loses precision. A JSON number or a string out of range → DecodeError.
- **Interim format:** this JSON is the **interim route format** (#162) until the Arrow frames of
  [T04 §4.3](T04-wire-format-and-data-plane.md#43-result-type-schemas-authoritative) land (#68 Part B,
  deferred by the owner); its mapping to `profile_flame/1` and `profile_flame_diff/1` is in §5.2.
- **Per side:** self ≤ total, Σ child totals ≤ parent total, ticks = total[0].
- **Both kinds:** names unique among the children of one parent (a duplicate → DecodeError at
  `/name/i`), so **identity = name path via `parent`** for single and union frames alike; selection,
  focus, root and crumbs are held as name paths.
- **Single:** every child lies inside its parent (x_p ≤ x_c and x_c + total_c ≤ x_p + total_p), and
  siblings appear in ascending x with disjoint spans (x_i + total_i ≤ x_{i+1}).
- **Union:** spans are disjoint by construction (T23-013). A node with cur.total = 0 **and**
  base.total = 0 is rejected, **except** the root when cur.ticks = base.ticks = 0, which requires
  N = 1 and decodes to the T23-021 empty state; x and width are computed (T23-013).

#### T23-003 — Icicle
**MUST** — x = offset/view-root span; 18 px rows, 1 px gap; root on top (`'flame'`: bottom).
`colourBy:'self'`: `sequentialRamp[min(8,⌊9·cur.self/M⌋)]`, M = max cur.self over the active layout;
M = 0 → index 0 for every node. `'package'`: `series-{1+(xxh3(pkg) mod 8)}`, where pkg is the name up
to its last `::`, `.` or `/`.

#### T23-004 — Honest merge
**MUST** — Adjacent nodes in a row narrower than 2 px (2D) or 3 px at the near edge (3D) — in mode
`diff`, narrower than 4 px (2D) or 6 px (3D), the smallest widths that carry a T23-025 cue — merge
into one `text-muted` 35 % mark, labelled "N merged" if ≥ 48 px; the tooltip gives N, the total, the
max self, the top 3, "k matches" and, in diff, the counts per class ("a grew, b shrank, c new, d
removed"), also appended to the label when it fits. This is the flame's disclosed "other (n)" mark.

**Picking a merged mark** works like any click (T23-007): the hit is found first (2D: the row under
the pointer y; 3D: the run hit by the ray, with its world X as the pointer x). It selects the member
whose true span covers the pointer x, or else the nearest member (ties: lowest x), and flies to that
member's [x, x+width] (T23-010). One gesture; no search needed. Search picking (T23-017) uses the same
rule restricted to matches.

No mark is ever widened beyond its true span: a suspect or the selection inside a merge gets a 2 px
accent tick above the row at its true x. 3D height = the max member self. Coverage: "k frames
merged"; "profile truncated at N nodes" + "raise limit" (×2, ≤ 131 072).

#### T23-005 — Label policy
**MUST** — Mono 12 px, ≥ 11 px; names keep their end. Guaranteed: the selected, focused and
**origin** labels, where the origin is suspect ① (the hottest frame, the flame's probable origin);
they are drawn last, without depth test. The rest are greedy by priority (suspects, matches, self),
with overlaps culled; 2D labels go inside rects ≥ 24 px. Badges ①–⑤ are always drawn, without depth
test, stacked by rank. In 3D **every** label is a billboard anchored by a leader line from its box's
top-face centre (VIZ-076): solid when the anchor is visible, dashed when it is occluded. Culled
matches stay in the table, and `n`/`N` focuses them. Coverage: "k of N matches labelled".

#### T23-006 — Suspects
**MUST** — Read the **current side** `cur` (single = the merge; union = the current window).
- ① = max cur.self (ties: lowest level, then x), badged HOTTEST plus its function's badges. If every
  cur.self is 0, ① = the non-root node with the largest cur.total (the root if N = 1; same ties),
  badged LARGEST, with the rail note "no self time recorded". ① exists whenever cur.ticks > 0.
- ②–⑤ = other functions by s_f + max(0, g_f) ≥ 0.01, ties by name, with s_f = Σcur.self/cur.ticks
  (only when cur.ticks > 0). g_f = s_f − Σbase.self/base.ticks only when base ≠ null and
  base.ticks > 0; otherwise g_f = null, score = s_f, no NEW or REGRESSED badge and glow 0. None → "no
  other suspects ≥ 1 %".
- Badges: HOT (s_f ≥ 0.05); NEW (base 0), REGRESSED (g_f ≥ 0.02) and glow only with a non-empty
  baseline.
- Target = the function's max cur.self node. `vis/flameSuspects.ts`.

#### T23-007 — Two-action reach
**MUST** — Opens framed whole, ① focused, not selected. One action (a row, `Tab`/`Shift+Tab`, a frame
click) selects, flies (T23-010) and opens the Inspector frame card: name, self/total (abs, %), Δ,
occurrences, top 5 callers/callees, "Sandwich", "Find in table", "Copy name".

#### T23-008 — 3D geometry
**MUST** — X ∈ [0,1000] maps the view root; Z = level·14 (box depth 10); Y = 2 + 238·h(v)/h(vmax),
v = self/total (`heightBy`), h = identity, √ or log10(1+v) (`heightScale`); h(vmax) = 0 → Y = 2 for
every node and the Y axis reads "no self time". M11 boxes, VL-023 light, VL-026 shadows, a grid every
100 X.

#### T23-009 — 3D camera
**MUST** — Orbit (INT-001; `` ` `` Fly); FOV 50°, roll 0, pitch 10–89°; default heading 0, pitch 35°,
contained + 8 %. Wheel/pinch dolly ×1.15 per 100 delta toward the picked (else ground) point, drift
< 1 px, distance [20, 4× contain]. `Shift`/`Alt`+wheel: height ×[0.25, 8] / level pitch [7, 56].
Left drag orbits, right/middle pans, `Q`/`E` rotate, double-click on empty resets.

#### T23-010 — Fly-to
**MUST** — Selection, a crumb, the minimap, `n`/`N` and `F` fly the subtree box to 80 % of the smaller
viewport side (focus = its centre, heading kept, pitch ≥ 25°), ease-out ≤ 250 ms. Input stops the
flight on that frame; reduced motion cuts. 2D animates the view to [x, x+width] of the active layout
(T23-013), never `total`. Landings commit to history (INT-006).

#### T23-011 — Zoom out
**MUST** — `Esc`, first applicable: exit Fly → clear brush, then search → clear selection → close
Inspector → re-root to the parent (if re-rooted) → fly to the overview. The flame registers with the
[T25](T25-inspector-and-pivots.md) host's ladder (T25-007): pre steps [exit Fly, clear brush, clear
search] and post steps [re-root, overview]; clear selection and close Inspector are the host's. One-gesture outs: `Shift+F`,
the "all" crumb, a minimap click, wheel, `Alt+←` / mouse back (prior pose). Crumbs = ancestors of the
selection (else of the focus); a crumb selects and flies. `Enter` re-roots.

#### T23-012 — Morph
**MUST** — The icicle is the 3D flame from the top preset, orthographic, Y = 0. `T`/3D button morphs
≤ 250 ms (reduced motion: cut), keeping root, selection, search, mode and x span. The view is panel
state (URL, board).

#### T23-013 — Layouts and diff
**MUST** — `flameLayout(frame, mode) → {x, width, shown}` is the only geometry; fly, zoom, LOD and
picking use it.
- **Current-only** (modes `single` and `sandwich`): nodes with cur.total = 0 are not shown;
  width = cur.total. For a single frame, x = the decoded `x` (PulsusDB's validated offsets; gaps
  inside a parent, which are the parent's self, are kept). For a union frame, x = parent x + the
  widths of earlier shown siblings.
- **Union** (mode `diff`): identity = name path, absent side = 0, children in name order,
  width = ½(base.total/base.ticks + cur.total/cur.ticks) (a zero-tick side gives 0), x = parent x +
  earlier sibling widths.
- Switching single ↔ diff morphs 250 ms, keeping the selection by name path; a selection not shown in
  the new layout moves to its nearest shown ancestor.

**Measures** (per side, with D = durationMs/1000):
- rate(v) = v/D, in ticks per second, so windows of different lengths compare fairly;
- share(v) = v/ticks, where every share of a zero-tick side is 0 (its values are all 0, so its rates
  are 0 too); no NaN can occur.

**The diff class follows the change in absolute cost** Δ = rate(cur.total) − rate(base.total).
SRF-046's "frames that grew" means cost that grew, and a frame's cost is its total.
- **Exact arithmetic.** Per frame, E = cur.total·base.durationMs − base.total·cur.durationMs,
  computed in `BigInt`. The counts are exact float64 integers below 2^53 and the durations are whole
  ms, so BigInt(value) is exact. Since Δ = 1000·E/(base.durationMs·cur.durationMs) and that
  denominator is common to every frame, the following decisions are all made in BigInt:
  - **Sign:** sign(E) gives the class; unchanged ⇔ E = 0 (index 4, no cue).
  - **Scale:** M = max |E| over the diff. M = 0 → index 4 everywhere and "no change".
  - **Step:** only the ratio is converted, m = Number(|E|·10^6 / M)/10^6 ∈ [0, 1] (BigInt division).
    Grew: index 4 + max(1, round(4m)), capped at 8. Shrank: index 4 − max(1, round(4m)), floored at 0.
  - **Cost %:** with h = E·10 000 / (base.total·cur.durationMs), BigInt division truncated toward 0,
    the text is "cost ±(Number(h)/100) %". When E ≠ 0 but h = 0 it is "cost +<0.01 %" or
    "cost −<0.01 %". When base.total = 0 it is "cost new"; when removed, "cost −100 %".
  - **Self:** the self sign, ratio and "self ±q %" use the same method on self.
- Separately labelled metrics in the tooltip and Inspector: "cost ±p %" (above); "share ±b pts"
  (b = 100·(share(cur.total) − share(base.total))); "self ±q %" (the same formula on self):
  "self +0 %" when the self value is 0 on both sides, "self new" when it goes from 0 to positive,
  "self −100 %" when it goes from positive to 0.
- The self rate change Δs drives the secondary cue (T23-025).

Labels: grew red "+", shrank blue "−", cur.total = 0 "− removed", base.total = 0 "+ new" (SRF-046,
VIZ-067). Opposite directions: cost grew and self cost fell → grew (red, "+", top bar) plus the dashed
self bar; cost fell and self cost grew → shrank (blue, "−", bottom bar) plus the solid self bar. Share
is never used for the class. 3D: height from cur.self; removed = 2-unit slab + baseline wireframe;
`ghost` wireframes all.

#### T23-014 — Sandwich
**MUST** — f's callers merged by path upward, callees merged below. 2D: callers above (inverted), f
outlined, callees below. 3D: callers Z < 0, f at 0, callees Z > 0.

#### T23-015 — Look within 08
**MUST** — Only VL-023 light, VL-024 fog (sparing selected, focused, suspects, labels), grid, contact
shadows, T02-007 motion, and glow clamp(g_f/0.10, 0, 1) on regressed functions
([VL-004](../product/08-visual-language.md#vl-004--deviation-glow-is-the-only-effect)); none without
a baseline.

#### T23-016 — Renderer path
**MUST** — 2D: `Canvas2DEngine` now, the engine (M3, M8) from #69. 3D: engine only (M11, M8, M1;
Orbit3D, #94); LOD and label passes in the render worker (PRF-005). No engine → 3D button disabled,
`T` says "3D needs WebGPU or WebGL2".

#### T23-017 — Search
**MUST** — `/` focuses find; a substring match (case-sensitive if the text has a capital) is drawn in
accent at its **true span**. Matches narrower than 1 px are drawn as runs: a pixel column is
highlighted when any match overlaps it, so the highlight is exactly the union of the matches' pixel
columns. A 4 px **density strip** above the plot shades each column by its match count (sequential
ramp), and the minimap marks the same columns. Non-matches dim to 40 %; the table filters.

Picking is by pointer position. First the candidates are restricted to the geometry under the
pointer: in 2D the row whose band contains the pointer y; in 3D the box, or merged run, hit by the
picking ray (ID buffer). The pointer x is then that hit's world X. Among the candidate matches
overlapping the pointer's pixel column, the focused match is the one whose true span covers the
pointer x; if none does, the one nearest the pointer x; ties go to the lowest x. `n`/`N` step through
**every** match in (x, level) order, flying to each (T23-010) and showing "match i of N".

#### T23-018 — Accessibility
**MUST** — `Shift+T`: top table (function, self, self %, total, total %, Δ) + CSV. Summary: "<type>,
<selector>, N frames; hottest <f> s % self[, up g pts]; k suspects". Rail, crumbs and dock are in tab
order.

#### T23-019 — VIZ-078 features
**MUST** — Axis cube: X "share of total" (linear: a partition axis, exempt from log under amended
[VIZ-078](../product/05-visualisation-catalogue.md#viz-078--shared-3d-chart-features)), Z "stack
depth", Y self/total (linear, √, log). Six planes (floor, top, front, back, left, right), each
`auto`|`show`|`hide`; default `auto` hides a plane while the camera is outside it. Set in the HUD
"Axes" popover (keyboard reachable) and persisted in `planes` (board and URL). `projection` toggle.
Gizmo presets via INT-043: front (0°, pitch 10°), top (89°, ortho = icicle), side (90°, 10°). Per-box
tooltip.

#### T23-020 — Linked 2D (VIZ-077)
**MUST** — In 3D the minimap is the collapsed docked icicle; "Dock 2D" expands it to 40 % width on the
right. Hover in either view highlights in both; selection is one shared node; `Alt`+drag in the dock
brushes an x-range of a row, outlining those frames in 3D and dimming the rest.

#### T23-021 — Side states
**MUST** — Both sides (or single) at 0 ticks → "no samples in this window", with no rail. Current 0 →
"no samples in the current window", all "− removed", empty rail. Baseline 0 → "baseline window is
empty", all "+ new", suspects as with no baseline.

#### T23-022 — Fetch and failure (I1)
**MUST** — Uses the board panel run (`PanelView`). First load: an empty plot, with the VL-015 shimmer
after 300 ms. A refetch keeps the previous frame shown as stale and crossfades on arrival. A newer
request aborts the older one (`AbortSignal`), and late answers are ignored. A request error or
`DecodeError` ("The profile answer could not be read", pointer in the detail): with no frame, the
`error` view and "Retry"; with a frame, it is kept, with the banner "Showing <time> results; refresh
failed" and "Retry". 429/`too_broad` adds "Narrow: <suggestion>". Retry reruns once; never
automatically.

#### T23-023 — Mode and fetch
**MUST** — Current window C = the Context [F, T]. Baseline window B: `previous` → [F − (T − F), F];
`offset` → [F − offsetMs, T − offsetMs]; `range` → [fromMs, toMs] (absolute, any distance from C);
`none` → no B. B is available when B.from ≥ now − 7 d and B is ≤ 24 h long.
- I1: one merge of C, mode `single`, no baseline.
- From I2, with B available: one diff request {query, leftQuery?, left: B, right: C}, feeding
  `single` (current-only layout, T23-013; growth badges, glow) and `diff` (union layout). With B
  unavailable or `none`: one merge of C and "baseline unavailable" (or nothing, for `none`). With
  `leftQuery` and no B: the left selector over C.
- **Diff with no baseline** (saved `mode:'diff'`, B unavailable or `none`, no `leftQuery`): one merge;
  `mode:'diff'` is kept (the board JSON is not rewritten); the current-only layout is drawn with
  sequential colours and no +/−; the mode control shows Diff as "unavailable" with the reason, and the
  banner reads "baseline unavailable — showing the current profile". The next fetch with B available
  returns to diff automatically.
- **Controls:** a "Compare to" menu in the panel header (Previous window · Offset: −1 h, −1 d, −7 d or
  a custom duration · Custom range with two date-time fields · None), plus a "Baseline selector" field
  for `leftQuery`. Both persist in the board JSON and the URL view state.

#### T23-024 — Inspector payload (#164)
**MUST** — A click sends `{type:'flame', target}` to the [T25](T25-inspector-and-pivots.md) host, where
target is `{kind:'flame', key: xxh3(path), title, detail:{path, self, total, selfShare, totalShare,
delta, occurrences, callers[5], callees[5]}, actions:['sandwich','findInTable','copyName']}`, unchanged
(T25-002). The actions follow T25-015. Pivots per T25-009 and T25-010; logs and traces are shown as
unavailable (SRF-048).

#### T23-025 — Diff cues without colour (VIZ-067)
**MUST** — Every individually drawn diff frame carries a non-colour cue by class. The class follows
T23-013: new = base.total 0; removed = cur.total 0; otherwise grew = Δ > 0, shrank = Δ < 0,
unchanged = Δ = 0 (signs of the unrounded cost-rate change, T23-013), with no cue.

The cues are fragment-shader patterns that survive at 4 px, independent of labels:
- **grew**, a solid 2 px bar along the top edge (3D: the top face's back edge);
- **shrank**, a 2 px bar along the bottom edge (3D: the front edge);
- **new**, the top bar plus 45° hatching;
- **removed**, a 1 px dashed outline plus 135° hatching (3D: the slab with its baseline wireframe).

**Self cost change** is the secondary cue: a 2 px bar on the right edge, solid when Δs > 0 and dashed
(2 on, 2 off) when Δs < 0, absent when Δs = 0 (3D: on the top face's right edge). The tooltip and
Inspector read "cost ±p % · share ±b pts · self ±q %", always finite. The merged-run counts add "k
self grew, m self shrank". Labels add "+", "−", "+ new" or "− removed" when placed. Frames too small
for a cue merge per T23-004 with counts disclosed.

## 5. Interfaces

### 5.1 Types and board options

```ts
// Decoded from #162's routes (merge → 'single', diff → 'union'); invariants T23-002.
export interface FlameSide { total: Float64Array; self: Float64Array; ticks: number; durationMs: number } // durationMs: the side's request window, set by the client (> 0)
export interface FlameFrame { profileType: string; unit: Unit; names: readonly string[]; kind: 'single'|'union';
  level: Uint16Array; name: Uint32Array; parent: Int32Array /* −1 root */;
  x: Float64Array | null;                 // single: validated PulsusDB offsets (ticks); union: null
  cur: FlameSide; base: FlameSide | null; // single: base = null
  truncatedAt: number | null }            // all readonly; geometry via flameLayout (T23-013)
export function flameLayout(f: FlameFrame, mode: 'single'|'diff'|'sandwich'): { x: Float64Array; width: Float64Array; shown: Uint8Array };
export interface Suspect { rank: 1|2|3|4|5; name: string; node: number; selfShare: number;
  growth: number | null; badges: readonly ('HOTTEST'|'LARGEST'|'NEW'|'REGRESSED'|'HOT')[] }
// Board JSON: vis.kind += 'flame'; optional vis.flame (absent = defaults), mirrored in validate.go. Defaults after '='.
export interface FlamePanelOptions {
  view: '2d'|'3d' /*='2d'*/; mode: 'single'|'diff'|'sandwich' /*='single'*/; orientation: 'icicle'|'flame' /*='icicle'*/;
  colourBy: 'self'|'package' /*='self'*/; heightBy: 'self'|'total' /*='self'*/;
  heightScale: 'linear'|'sqrt'|'log' /*='linear'*/; projection: 'perspective'|'orthographic' /*='perspective'*/;
  baseline: {kind:'previous'} | {kind:'none'} | {kind:'offset', offsetMs: number} | {kind:'range', fromMs: number, toMs: number} /*={kind:'previous'}*/; leftQuery?: string /*1..4096*/; sandwichFunction?: string /*1..512, iff sandwich*/;
  dock2d: boolean /*=false*/; planes: Partial<Record<'floor'|'top'|'front'|'back'|'left'|'right','auto'|'show'|'hide'>> /*={} = all auto*/; ghost: boolean /*=false*/; topTable: boolean /*=true*/; maxNodes: number /*1024..131072, =32768*/ }
// Errors (/…/vis/flame/<field>): board.vis.flame.invalid, .sandwichFunction.required, .baseline.invalid (offsetMs not an integer in [60 000, 604 800 000]; range not integers,
// fromMs ≥ toMs or longer than 24 h). Import (VIZ-060): standard flame graph → {kind:'flame'}, defaults. Seam (I1's ADR):
// VisKind += 'flame'; VisSpec = options + search, root, selected, focused, brush; FrameData {kind:'flame', flame,
// suspects, sandwich, banner}; events flameHover, flameSelect, flameRoot, flameBrush; commit 'orbit' + pose.
```

**Type switcher** (SRF-046, I1): lists #162's types in order with the current one selected. Choosing
a type replaces the selector's type prefix and reruns. An empty list disables it, with "no profile
types reported".

**Diverging tokens** (new, `xtask palette-check`), shrink → grow:
- dark `#8DBBEB #6DA3DB #4075A9 #2C4967 #2A2F38 #6B3A3A #9A4A45 #C65F52 #E8806A`;
- light `#2C4967 #4075A9 #6DA3DB #B1D3F7 #ECEEF1 #F5C2B8 #E8806A #C65F52 #8A3A33`.

### 5.2 Interim JSON ↔ T04 columnar frames

Interim format (#152, #162; owner 2026-11-24): until the Arrow frames land (#68 Part B, deferred), the
profile routes return JSON with decimal-string counts and explicit parent indices. The
`kind:'single'` JSON maps to `profile_flame/1` and `kind:'union'` to `profile_flame_diff/1`
([T04 §4.3](T04-wire-format-and-data-plane.md#43-result-type-schemas-authoritative)):

| JSON field | Column | Notes |
|---|---|---|
| `names` + `name[i]` | `name` Dictionary(UInt32, Utf8) | the dictionary is `names` |
| `level[i]` | `level` UInt16 | |
| `parent[i]` | `parent` Int32 (**new column**, −1 for the root) | |
| `x[i]` (single) | `x` UInt64 | |
| `cur.total/self` | single: `total`/`self`; union: `r_total`/`r_self` UInt64 | right = current |
| `base.total/self` (union) | `total`/`self` UInt64 | left = baseline |
| — | `r_x`, `x` (union) | ignored by the client, which computes the union layout |
| `profileType` | metadata `dash.profile.type` | |
| `sampleUnit` | metadata `dash.unit` | → `Unit` per §5.1 |
| single `cur.total[0]` | metadata `total` | = cur.ticks |
| union `base.total[0]` / `cur.total[0]` | metadata `left_ticks` / `right_ticks` | = base.ticks / cur.ticks |
| — | metadata `max_self` | ignored; the client computes M |
| `truncated`, `maxNodes` (decimal string) | coverage block `truncation_reason = max_nodes` with the limit ([T04 §5.3](T04-wire-format-and-data-plane.md#53-coverage-block-coverage1-r10)) | → `FlameFrame.truncatedAt` = maxNodes when truncated, else null |

Both formats decode into the same `FlameFrame`, with the same invariants and the same 2^53 − 1 bound.

## 6. Data & storage

No new tables. The panel options of §5.1 are stored in the board JSON (`vis.flame`, validated by the
client and by `validate.go`) and mirrored in the URL view state; the 2D/3D choice on the Profiles page
is remembered in the user's prefs (§13). Suspects, search, brush and crumbs are React state; the
camera, LOD, labels and picking are render-worker state (§4.1).

## 7. Performance budget

| Item | Volume | Target on (a) / (b) | Gate (stage) |
|---|---|---|---|
| Icicle pan, zoom, fly (interim, then engine) | 10⁵ | median ≥ 60 fps / p99 ≤ 22.2 ms; no task > 16 ms | `bench:frame-flame-1e5`: CI report-only; lab-enforced (`FLAME_BENCH_GATE=enforce`); the (a)+(b) lab verdict is I1's PRF-021 acceptance |
| 3D orbit, dolly and fly, 30 s | 10⁵ | same; worker CPU ≤ 8 ms p99 (LOD 2, labels 2, pick 0.5, upload 1) | `bench:frame-flame3d-1e5` (lab, enforced) |
| Fly, morph, re-root | — | ≤ 250 ms | `bench:flame-fly` (merge) |

The §10 `unit:`, `e2e:` and `golden:` gates are in [T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue)
at PR stage, blocking.

**Auto-vis:** [05](../product/05-visualisation-catalogue.md) Table 5-13 rule 2 maps to `flame`, view
'2d'. The 3D views are opt-in only and persisted.

## 8. Security, tenancy & RBAC

Frame names are scoped by the BFF (tenancy) and drawn as plain text.

## 9. Failure modes & degradation

| Risk | Handling |
|---|---|
| #150 unmerged | merge after it (VIZ-086 anchor) |
| Baseline beyond the 7-day floor or 24 h window | baseline none, "baseline unavailable", no glow; ① unchanged |
| Interim Canvas 2D at 10⁵ | merging bounds the rects; lab-enforced gate |
| Truncation; 429 | "raise limit"; #162's `too_broad` |
| Occlusion | root at the front; pitch ≥ 25°; leaders; badges with no depth test |
| Tenancy | BFF-scoped names, drawn as plain text |

## 10. Testing

Paths are under `client/src/`, and e2e specs are in `client/e2e/`. "Fails today" = `new` (no feature
yet). Each row names the implementation issue that adds it (§11).

**Fixtures:**
- `flame-1e5` (`dev/flameSynth.ts`, shared with the gallery and the engine fixtures):
  - xoshiro128** with seed 152; breadth-first from the root until 100 000 nodes exist.
  - The root has 4 children. Below it, at depth < 24, a node gets 0 children if r < 0.35, else
    1 + ⌊r·4⌋; depth 24 has none. The generator throws if the frontier empties first.
  - Name i = `pkg{i mod 40}::fn{i mod 2000}`.
  - self = 1 + ⌊r·1000⌋ for a leaf, else ⌊r·50⌋; total = self + Σ children; x = parent x + earlier
    siblings' totals.
  - Two runs must produce identical arrays.
- `flame-agg`: A as 30 nodes × 1 % self, B as 1 node × 8 %.
- Decoder payloads (the interim JSON that #162 must emit). Every payload also carries
  `"profileType":"process_cpu:cpu:nanoseconds:cpu:nanoseconds"`, `"sampleUnit":"nanoseconds"`,
  `"truncated":false` and `"maxNodes":"32768"`.
  - **S**: `{"kind":"single","names":["all","main","a","b"],"level":[0,1,2,2],"parent":[-1,0,1,1],"name":[0,1,2,3],"x":["0","0","0","60"],"cur":{"total":["100","100","60","40"],"self":["0","0","60","40"]}}`
  - **V**: `{"kind":"union","names":["all","main","p","q","r"],"level":[0,1,2,2,2],"parent":[-1,0,1,1,1],"name":[0,1,2,3,4],"base":{"total":["100","100","10","60","30"],"self":["0","0","10","60","30"]},"cur":{"total":["200","200","180","20","0"],"self":["0","0","180","20","0"]}}`
  - **A**: `{"kind":"union","names":["all","main","a","n"],"level":[0,1,2,2],"parent":[-1,0,1,1],"name":[0,1,2,3],"base":{"total":["100","100","100","0"],"self":["0","0","100","0"]},"cur":{"total":["50","50","0","50"],"self":["0","0","0","50"]}}`
  - **M** (multi-parent): `{"kind":"union","names":["all","a","b","x","y"],"level":[0,1,1,2,2,2],"parent":[-1,0,0,1,1,2],"name":[0,1,2,3,4,3],"base":{"total":["100","60","40","30","30","40"],"self":["0","0","0","30","30","40"]},"cur":{"total":["100","20","80","20","0","80"],"self":["0","0","0","20","0","80"]}}`
  - **Z**: `{"kind":"union","names":["all"],"level":[0],"parent":[-1],"name":[0],"base":{"total":["0"],"self":["0"]},"cur":{"total":["0"],"self":["0"]}}`
- `flame-agg` (single, 1 000 ticks):
  - root `all`;
  - level 1: `caller{i}` (i = 0…29) at x = 10i, total 10, self 0, each with a child `agg::a` (total
    10, self 10); `hot::b` at x 300 (total 80, self 80); `rest` at x 380 (total 620, self 0), with
    children `rest::f{j}` (j = 0…61) at x = 380 + 10j (total 10, self 10);
  - expected: ① = `hot::b`, ② = `agg::a` (30 %).
- `flame-flat` (single, 400 ticks): root `all` with leaves `leaf{i}` (i = 0…399) at x = i, total 1,
  self 1; expected ① = `leaf0`.

| Test (issue) | File | Setup | Expected | Fails today | Covers |
|---|---|---|---|---|---|
| unit:flame-decode (I1, I2) | data/decode.test.ts | **S** single: names [all,main,a,b], level [0,1,2,2], x [0,0,0,60], total [100,100,60,40], self [0,0,60,40]. **A** union, added-only: base total [100,100,100,0], cur total [50,50,0,50] for [all,main,a,n]. **Z** union both-zero, root only. Bad: level [0,2]; x [0,600,500]; child x 900 + total 200 in 1 000; overlapping siblings S′ (x [0,0,0,50]: a [0,60) and b [50,90)); self 5 > total 4; name 9 of 3; duplicate sibling in a union; duplicate sibling in a single; a non-root 0/0 node; a count as a JSON number; `"9007199254740992"`; `"01"`; `"-1"` | S: parent [−1,0,1,1], x [0,0,0,60], width [100,100,60,40]. A (diff layout): width [1,1,0.5,0.5], x [0,0,0,0.5], n "+ new". Z decodes to "no samples in this window". `"9007199254740991"` accepted. Each bad case → DecodeError at the offending element's pointer | new | T23-002, T23-021 |
| unit:flame-suspects (I1) | vis/flameSuspects.test.ts | `flame-agg`; `flame-flat`; 9→18 %; equal-self tie | ① = `hot::b`, ② = `agg::a`; flat → lowest level then x, "no other suspects"; g = 0.09 ± 1e-9 REGRESSED | new | VIZ-106 |
| unit:flame-suspects-nobase (I1, I2) | vis/flameSuspects.test.ts | single (base null) and union with base.ticks 0; functions C 12 %, D 8 %, E 6 %, F 0.5 % besides ① | ②–④ = C, D, E by s_f; F absent; growth null; badges HOT for C, D, E only; no NEW or REGRESSED; glow 0; no NaN | new | T23-006 |
| unit:flame-suspects-diff (I2) | vis/flameSuspects.test.ts | union: baseline hottest A (20 %→2 %), current hottest B (3 %→15 %) | ① = B's node; A not ①; B REGRESSED, g = 0.12; cur.ticks 0 → no rows | new | VIZ-106, T23-006 |
| e2e:flame-two-actions (I1–I3) | flame.spec.ts | `flame-agg`, `flame-flat` (2D, 3D); the A/B union via the diff route | 1 click on ① (or `Tab`) → Inspector names the max cur.self node (B) ≤ 250 ms + 1 frame | new | VIZ-106 |
| e2e:flame-escape (I1, I3) | flame.spec.ts | selection, Inspector, search, re-root, fly-in | each `Esc` = the next T23-011 step; `Shift+F` → overview ≤ 250 ms; `Alt+←` → prior pose | new | INT-016 |
| unit:flame-merge (I1) | engine/canvas2d/flameLayout.test.ts | `flame-1e5` at 1 000 px; a suspect 0.3 px wide at x 400.1 px inside a merged run | every drawn rect equals its node's or its run's true span (± pixel snapping), none widened; merged counts = hidden nodes; the suspect is drawn as a 2 px accent tick above the row at x 400.1 px, and its run keeps its true span | new | VIZ-005, T23-004 |
| e2e:flame-merge-pick (I1, I3) | flame.spec.ts; flame3d.spec.ts | one row of 400 adjacent leaves of 1 tick in a 4 000-tick profile at 1 000 px (0.25 px each, one merged run from x = 0); clicks at x = 20.1 px and x = 70.3 px | 2D: the clicks select leaves #80 and #281 (0-based; spans [20.0, 20.25), [70.25, 70.5)) and fly to [80, 81] and [281, 282] ticks; 3D (front preset): ray hits at the same world X select the same leaves and frame each leaf's subtree box | new | T23-004, T23-007, T23-010 |
| unit:flame-search-dense (I1) | engine/canvas2d/flameSearch.test.ts; vis/flameSearch.test.ts | one row of 5 000 adjacent matches, each 0.2 px wide at 1 000 px (x = 0.2k px), selection among them | the highlight covers exactly columns 0–999 (the union of true spans); no mark wider than its span plus pixel snapping; density strip = 5 per column; clicks at x = 10.05 px and x = 512.3 px in the same run focus #50 and #2561 (0-based; spans [10.0, 10.2) and [512.2, 512.4)); `n` from #0 visits #1…#4999 in order, then wraps to #0, each exactly once; selected and focused labels placed; "k of 5000 matches labelled" | new | VIZ-036, T23-004, T23-017 |
| e2e:flame-search-levels (I1, I3) | flame.spec.ts; flame3d.spec.ts | mockup tree; search `json`: parent `json::encode` (level 4, [0, 210]‰) overlaps child `json::write_str` (level 5, [0, 26]‰) | 2D: a click on row 4 at 10‰ selects `json::encode`, on row 5 at 10‰ selects `json::write_str`; 3D (front preset, then orbit 45°): clicking each box selects that box's node | new | T23-017 |
| e2e:flame-2d (I1) | flame.spec.ts | `/` `json::`; click `checkout::handle` | matches drawn at true spans, table = matches, `n` → next with "match 2 of N"; x = [0,560]‰ in ≤ 250 ms (reduced motion: next frame) | new | VIZ-036 |
| e2e:flame-types (I1) | flame.spec.ts | fake: cpu, alloc_space, mutex; then [] | 3 in order; alloc_space reruns with that prefix; [] → disabled + notice | new | SRF-046 |
| e2e:flame-states (I1) | flame.spec.ts | delay 1 s; 500; 429 + suggestion; malformed; overlapping requests; Retry | shimmer at 300 ms; error view + Retry, or the frame kept + stale banner; "Narrow"; "could not be read"; the first request aborted, its late answer ignored; one request per Retry | new | T23-022 |
| e2e:flame-baseline (I2) | flame.spec.ts | window within limits; window 8 d back; leftQuery | one diff request; one merge + "baseline unavailable"; diff of the left selector | new | T23-023 |
| e2e:flame-baseline-range (I2) | flame.spec.ts | C = D 10:00–10:30; Compare to → Custom range D−2 02:00–02:30; reload; then offset −1 d | one diff request with left = D−2 02:00–02:30 and right = C (non-adjacent); diff colours; the range survives reload and URL copy; offset → left D−1 10:00–10:30 | new | SRF-046, T23-023 |
| e2e:flame-identity (I1, I2) | flame.spec.ts | S: select `all›main›a`; refresh with a = x 40 (b first); switch to diff (V-like union with `a`); then a refresh answer with duplicate sibling `a` | selection stays `all›main›a` after the refresh and the mode switch; the duplicate answer → DecodeError per T23-022, with the frame kept stale and the selection unchanged | new | T23-002 |
| unit:flame-options (I1, I2) | boards/spec.test.ts; validate_test.go | sandwich without f; maxNodes 512; view '4d'; offsetMs 59 999 and 604 800 001; range with from = to; a range of 24 h + 1 ms | each case's key at `/…/vis/flame/<field>` (`.baseline.invalid` for the four baseline cases); `mode:'diff'` with `baseline:{kind:'none'}` and no leftQuery is **valid**; absent = defaults; offset 86 400 000 and a 30 min range accepted | new | §5.1 |
| unit:autovis-profile (I1) | vis/autovis.test.ts | lang `profile` | flame, rule 2 | new | VIZ-065 |
| e2e:flame-a11y (I1) | flame.spec.ts | `Shift+T`, CSV, axe, greyscale | table = CSV = data; T23-018 summary | new | VIZ-066, 067 |
| unit:flame-diff (I2) | vis/flameDiff.test.ts | added, removed, reordered, unchanged; zero-delta; zero-tick | removed blue "− removed" width > 0; "+ new"; reorder = same layout; zero-delta all idx 4 "no change"; banner | new | SRF-046 |
| unit:flame-diff-sign (I2) | vis/flameDiff.test.ts | equal 30 min windows; cost-rate Δ = +0.4, +0.001, −0.001 and exactly 0 ticks/s, with max \|Δ\| = 0.4 | indices 8, 5, 3 and 4; the +0.001 frame is grew (top bar, "+"); the −0.001 frame is shrank (bottom bar, "−"); the zero frame has no class cue | new | T23-013, T23-025 |
| unit:flame-diff-exact (I2) | vis/flameDiff.test.ts | equal 30 min windows, one frame (root totals equal to it) base.total 9007199254740990 → cur.total 9007199254740991; the reverse; base 60 min with 9007199254740990 vs cur 30 min with 4503599627370495 | first: E = 1 800 000 = M, m = 1, index 8, grew, "+", tooltip "cost +<0.01 % · share +0 pts"; reverse: index 0, shrank, "−", "cost −<0.01 % · share +0 pts"; unequal windows: E = 0, index 4, "cost +0 %"; no intermediate float is used for any sign or step | new | T23-013 |
| unit:flame-diff-self (I2) | vis/flameDiff.test.ts; flame.spec.ts | equal windows; frames with self 0 → 0, 0 → 50 and 50 → 0 ticks (totals unchanged) | the tooltip and Inspector read "self +0 %", "self new" and "self −100 %"; self bars: none, solid, dashed | new | T23-013, T23-025 |
| unit:flame-diff-cost (I2) | vis/flameDiff.test.ts | (a) equal 30 min windows, base ticks 1 000, frame 500 → cur ticks 3 000, frame 750; (b) equal windows, 1 000/500 → 2 000/1 000; (c) equal windows, 1 000/400 → 500/300; (d) base 60 min, frame 600 → cur 30 min, frame 300; (e) a parent whose self stays 0 while its cost rises 50 % | (a) grew, red, "+", "cost +50 % · share −25 pts"; (b) grew, "cost +100 % · share +0 pts"; (c) shrank, blue, "−", "cost −25 % · share +20 pts"; (d) unchanged (index 4, no class cue), "cost +0 %" though its raw total halved; (e) grew, no self bar, "self +0 %" | new | SRF-046, T23-013, T23-025 |
| unit:flame-diff-empty (I2) | vis/flameDiff.test.ts; flame.spec.ts | union A-shaped with base.ticks 0 and cur.ticks 50; then cur.ticks 0 and base.ticks 100 | first: every non-root frame "+ new" (top bar + hatch), tooltip and Inspector "cost new · share +x pts", with x the current share; second: every non-root frame "− removed", "cost −100 % · share −x pts", with x the baseline share; no NaN or Infinity anywhere; the banners per T23-021 | new | T23-013, T23-021 |
| unit:flame-gap (I1) | vis/flameLayout.test.ts; flame.spec.ts | single [all,a,b], level [0,1,1], x [0,0,70], total [100,50,30], self [20,50,30] | layout x [0,0,70], width [100,50,30] (gap 50–70 kept); a click on b zooms to [70,100] | new | T23-013 |
| unit:flame-layout (I2) | vis/flameLayout.test.ts | **V** union [all,main,p,q,r]: base total [100,100,10,60,30], cur total [200,200,180,20,0] | single: shown [1,1,1,1,0], x [0,0,0,180,–], width [200,200,180,20,0], p = 90 %; diff: width [1,1,0.5,0.35,0.15], x [0,0,0,0.5,0.85] | new | T23-013 |
| unit:flame-multiparent (I2) | data/decode.test.ts; vis/flameLayout.test.ts | M | paths [all], [all,a], [all,b], [all,a,x], [all,a,y], [all,b,x]; the two `x` nodes are distinct; diff width [1,0.4,0.6,0.25,0.15,0.6], x [0,0,0.4,0,0.25,0.4]; single shown [1,1,1,1,0,1], x [0,0,20,0,–,20], width [100,20,80,20,0,80] | new | T23-002, T23-013 |
| e2e:flame-diff-nobaseline (I2) | flame.spec.ts | saved panel `mode:'diff'`, window 8 d back; then refresh with the window at now − 1 h | one merge; banner; sequential colours, no +/−; Diff shown "unavailable"; board JSON unchanged; after the refresh, one diff request and diverging colours | new | T23-023 |
| e2e:flame-diff-none (I2) | flame.spec.ts | in diff, Compare to → None; save the board; reopen | save succeeds (no validation error); reopened panel: one merge request, `mode:'diff'` kept, banner "baseline unavailable — showing the current profile", Diff "unavailable", sequential colours | new | T23-023 |
| e2e:flame-mode-switch (I2) | flame.spec.ts | V; select r in diff, switch to single, then back | r selected in diff; in single the selection moves to `main`, p fills 90 % of the row; back in diff, p = 50 % | new | T23-013 |
| unit:flame-zero-self (I1, I3) | engine/canvas2d/flameDraw.test.ts; engine crate; flame.spec.ts | `{"kind":"single","names":["all","main","a"],"level":[0,1,2],"parent":[-1,0,1],"name":[0,1,2],"x":["0","0","0"],"cur":{"total":["100","100","100"],"self":["0","0","0"]}}` | 2D fills all `sequentialRamp[0]`, no NaN; 3D Y = 2 everywhere, axis "no self time"; ① = `main` (largest non-root total, lowest level), `badges` = ['LARGEST']; and for root 100 with children b 60 and c 40 (all self 0), ① = `b`, not the root; "no self time recorded"; one click on ① opens its Inspector | new | T23-003, T23-006, T23-008 |
| e2e:flame-diff-fly (I2) | flame.spec.ts | V in diff: click p (cur.total 180, width 0.5), r (removed, width 0.15); fixture A: click n (added, width 0.5); then p in single | ranges [0, 0.5], [0.85, 1.0], [0.5, 1.0] ± 1e-9; in single, p → [0, 180] ticks | new | T23-010, T23-013 |
| unit:flame-sandwich (I2) | vis/flameSandwich.test.ts | main(100) → a(40) → f(40, self 10) → g(30) → f(30, self 5); main → b(20) → f(20, self 20) | f total 60 (outermost occurrences only), self 35; callers a 40, b 20; callee g 30 | new | T23-014 |
| e2e:flame3d-nav (I3) | flame3d.spec.ts | `flame3d-1e5` | morph ≤ 250 ms; subtree 80 ± 2 %; input stops flight; pitch 10–89°; drift < 1 px | new | VIZ-105 |
| e2e:flame3d-controls (I3) | flame3d.spec.ts | each plane show/hide; orbit; reload; presets by keyboard; ortho; log Y; Dock 2D | the X axis offers no log, and log Y gives Y = 2 + 238·log10(1+v)/log10(1+vmax) (vmax 999, v 99 → Y = 160.7 ± 0.5); auto flips per plane while orbiting, forced ignores the pose, `planes` survives reload and URL; F/T/S via `F6`; equal ortho heights; hover, selection and brush mirrored | new | VIZ-077, 078 |
| unit:flame-labels (I3) | engine crate | `flame3d-1e5`, ① ≠ selected ≠ focused; 360° orbit in 10° steps; ① occluded at some headings | in every frame: no overlaps; selected, focused and ① labels present; every placed label has a leader from its anchor (solid when visible, dashed when occluded); badges drawn; ≥ 11 px | new | VIZ-076, T23-005 |
| golden:flame3d (I3) | engine fixtures | `flame3d-1e5`, `flame3d-diff`; glow r 0.4 vs 0.8 | pass, T1 = T2; glow 1 : 2 ± 10 %, none without a baseline | new | VIZ-105, 086, VL-004 |
| golden:flame-greyscale (I2, I4) | engine/canvas2d fixtures; engine fixtures | union with grew, shrank, new and removed frames at 6, 20 and 200 px (labels culled below 24 px); a frame with total grew and self unchanged; a frame with total unchanged and self grew; a run of 300 class-bearing frames at 0.5–3 px; greyscale filter, 2D and 3D | each class is identified by its class cue alone (top bar, bottom bar, top bar + hatch, dashed + hatch) at every width; the total-only frame shows the top bar and no right bar; the self-only frame shows only the solid right bar; unchanged frames have none; the dense run is one merged mark with per-class counts; no class-bearing frame narrower than 4 px (2D) or 6 px (3D) is drawn alone | new | VIZ-067, T23-025, T23-004 |
| e2e:flame3d-modes (I4) | flame3d.spec.ts | diff with removed path; sandwich | blue slab + wireframe; callers Z < 0 | new | VIZ-105 |

## 11. Rollout

M-UI2: the 2D flame and suspects (I1, I2). M-UI3: the 3D flame (I3, I4). The issues below are filed
after this design merges.

Gallery entries (VIZ-069), each with `golden:gallery` and a frame-time run at its volume:
- I1: `flame-1e5` (10⁵, `bench:frame-flame-1e5`), `flame-agg` and `flame-flat`.
- I2: `flame-diff` (10⁵ union) and `flame-sandwich`.
- I3: `flame3d-1e5` (`bench:frame-flame3d-1e5`).
- I4: `flame3d-diff`.

Every issue waits for #164.

Already filed: #162 (profiles data plane: routes, schemas, errors, types; it must match T23-002) and
#163 (flame landscape over time, VIZ-107–114).

| # | Title | Acceptance | IDs | Kind / blocked on |
|---|---|---|---|---|
| I1 | Flame graph 2D: icicle, zoom, search, table, suspects, minimap, crumbs, type switcher | §10 rows tagged I1; seam ADR; lab verdict for PRF-021 | VIZ-036, VIZ-106, VIZ-005, VIZ-065–067, PRF-021, SRF-046, INT-016 | 2D-now; blocked on #162's implementation and #164 (Inspector host, payload T23-024) |
| I2 | Flame graph 2D: diff (union tree), baseline fetch (T23-023), sandwich, diverging tokens | rows tagged I2 | VIZ-036, SRF-046 | 2D-now; after I1 |
| I3 | 3D flame: camera, fly-to, LOD, labels, VIZ-078 controls, linked dock, morph | rows tagged I3 | VIZ-105, VIZ-086, VIZ-076–078 | 3D, engine: #68 (deferred), #69, #94; after I1 |
| I4 | 3D flame: diff, ghost, sandwich | rows tagged I4 | VIZ-105 | 3D; after I2, I3 |

## 12. Alternatives considered

| Alternative | Why rejected |
|---|---|
| Z = time | hides the stack |
| Towers by depth | occlusion |
| A styled icicle | not true 3D (VIZ-086) |
| Suspect ① by function | misses the hottest frame |
| Writing the seam ADR now | I1 adds the seam ADR at the next free number |

## 13. Open questions

None. Owner decisions of 2026-11-24:
- Profiles opens in 2D, with 3D one key (`T`) away. The choice is remembered in the panel's `view`,
  and on the Profiles page in the user's prefs.
- VIZ-078 exempts partition X axes from log (05 change log 1.5-rc).
- New panels wait for #164.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-24 | #152: created for the flame graph: rules T23-001 to T23-025, interfaces and the interim JSON mapping to T04 §4.3, budget and gates, tests, the implementation issues I1–I4; VIZ-105, VIZ-106; mockup 40-flame-3d |
| 1.1-rc | 2026-11-25 | #164 ([T25](T25-inspector-and-pivots.md)): T23-024 sends `{type:'flame', target}`, with actions per T25-015 and pivots per T25-009 and T25-010; T23-011 registers its pre steps (exit Fly, clear brush, clear search) and post steps (re-root, overview) with T25-007 |
