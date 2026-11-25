# T22 — Value, categorical and table panels

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.1-rc · 2026-11-25 |
| **Milestone** | M-UI1 (stat delta), M-UI2 (bar chart), M-UI5 (pie, stat grid) |
| **Related ADRs** | [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0022](../adr/0022-chart-thresholds-and-stat-sparkline.md), [ADR-0023](../adr/0023-chart-event-markers.md) (no new ADR in this document) |
| **Source draft** | plans/151/plan.md (not tracked) |

## 1. Context & problem

[05](../product/05-visualisation-catalogue.md) §5 lists the bar chart, the pie and donut, and the
stat, but no technical design exists for these kinds. This document covers bar chart, pie and stat
(#151). Grouped and stacked bars follow in #167, gauge and bullet in #165, table and bar gauge in
#155 (§4.7), and the category matrix, 3D columns and Segments in #157 (§4.6).

## 2. Goals / non-goals

**Goals.** The TS panel component reduces, sorts, caps and evaluates thresholds. The engine
draws the resulting `categories` or `stats` frames in data order. Every mark carries its labels, series
key, baseline and anomaly score, and the table view, CSV and summary facts use all marks before the cap.
None of the three kinds gets a 3D form (§4.2); 3D columns move to #157.

**Coordination:**
- New IDs come from VIZ-095–099. This design follows #150, which adds VIZ-086.
- No ADR number is reserved. Each issue that changes the seam writes its own ADR amending ADR-0014 §3/§4 (as 0022 and 0023 did).
- Rows are additive; on a rebase conflict, keep both sides and re-run `check.py --write`.
- §4.6 belongs to #157 and §4.7 to #155; their rules follow T22-014, as do #165's (gauge and bullet).
- **Depends on #164** (Inspector and pivot chips). I1–I3 ship after it.
- `SummaryFacts` is the T21 type from #150; #160 renders its text.

**Non-goals:**
- #167: grouped and stacked bar charts (`plans/167/draft-from-151.md`).
- #165: gauge and bullet (`plans/165/draft-from-151.md`).
- #155: table and bar gauge.
- #157: matrix, 3D columns and Segments (`plans/157/draft-from-151.md`).
- Not covered here: field config, import pipeline (#17), radar, value-mapped text, derived baselines (T13), anomaly scores (Epic #9), and engine `select` for line.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [VIZ-003](../product/05-visualisation-catalogue.md#viz-003--universal-interactions-on-every-vis) | T22-007, T22-010, T22-011, §4.3; Inspector and pivots via #164 | `e2e:categorical-interactions`, `e2e:bars-inspect` |
| [VIZ-004](../product/05-visualisation-catalogue.md#viz-004--scale-targets-per-vis) | §7 | `bench:frame-interim-categories` (report only until #68) |
| [VIZ-005](../product/05-visualisation-catalogue.md#viz-005--lod-never-hides-signal-silently), [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) | T22-006 (cap, clipping, query completeness, `100 %`) | `unit:category-cap`, `unit:coverage-text`, `e2e:categorical-coverage` |
| [VIZ-031](../product/05-visualisation-catalogue.md#viz-031--3d-only-when-it-encodes-a-dimension), [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only), [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity) | T22-001, T22-002, §6 | `unit:board-spec` |
| [VIZ-037](../product/05-visualisation-catalogue.md#viz-037--bars-are-filters) | T22-007 | `e2e:bars-filter` |
| [VIZ-038](../product/05-visualisation-catalogue.md#viz-038--pie-guard) | T22-009 | `unit:pie-guard`, `e2e:pie-guard` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | §4.5 | `unit:autovis-table` |
| [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) | §4.5 | `unit:import-options` (in the import issue) |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis) | T22-013 | `e2e:categorical-table-view` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel), [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) | T22-004, §10 | `unit:category-colour`; `golden:interim-gallery` with greyscale variants |
| [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) | T22-014 (facts; text in #160) | `unit:category-summary-facts` |
| [VIZ-095](../product/05-visualisation-catalogue.md#viz-095--stat-baseline-delta) | T22-012 | `e2e:board-stat-delta` |

New gates are defined in §10. Each issue adds its gates to [T05](T05-testing-and-performance.md) §7.1.

## 4. Design

§4.6 (category matrix, 3D columns and Segments) is reserved for #157 and §4.7 (table and bar gauge)
for #155.

### 4.1 Pipeline (panel React component, main thread)
1. Reduce, sort, apply `stateOf` and match baselines → `all`. If the kind is pie, run the T22-009 guard on `all`; on fallback, the kind becomes barchart.
2. `capMarks` on the resulting kind's cap → the drawn marks.
3. `framePlan(kind)` → `{ spec, data (drawn), rows: panelRows(all), facts: summaryFacts(all) }`.
4. The baseline request uses the same key plus the offset, under the same AbortSignal.
5. A `pick` runs T22-007.
6. A new run cancels both requests; a late baseline for an old key is dropped.

### 4.2 Per-type sheet
All three accept PromQL instant/range and LogQL metric results; stat also takes a scalar. Canvas 2D now, the engine at I4.

| Kind | Marks (T02 §4.2) | 3D (VIZ-031, VIZ-086) |
|---|---|---|
| barchart | M3, M8, M1 thresholds | No: one category axis (two dimensions = #157's matrix) |
| pie / donut | M5 wedges, M8 | No: forbidden (VIZ-031, VIZ-038) |
| stat tiles | M8, M1 sparkline, M3 fill | No: text |

- **Value mark:** state colour with thresholds, else the series colour (T22-004).
- **Stat `background`:** state colour at 20 % alpha; the glyph always shows.

### 4.3 Universal interactions (VIZ-003), table view (VIZ-066) and summary (VIZ-068)
Quoted n/a lines are tooltip text.

| Kind | Time crosshair | Brush | Baseline ghost | `Shift+T` / CSV columns |
|---|---|---|---|---|
| barchart | n/a "Values are reduced over <window>" | bars spanned | hollow dashed bar at b | name, value, baseline, state, drawn, shown as |
| pie | n/a (as above) | n/a "A pie has no axis to brush" | n/a "Compare parts in the table view" | name, value, percent, state, drawn, shown as |
| stat | sparkline value at the crosshair instant | grid: tiles in the rectangle; single: n/a "One value: nothing to brush" | delta (T22-012) | name, value, baseline, delta, state, drawn, shown as |

- **Inspector and pivot chips ([T25](T25-inspector-and-pivots.md), #164):** Click or Enter sends `{type:'mark', target}` (target = `InspectTarget`) to the T25 host's `inspect`. T25 owns the host, the chips and the shared payload, and `InspectTarget` travels unchanged under `type:'mark'` (T25-002). Aggregate members are listed per T25-011. Acceptance once T25 I1 lands (`e2e:bars-inspect`; tiles in I2, wedges in I3):
  - the Inspector shows the labels, the value with its unit, the state and the baseline;
  - each label pair is a chip that opens Explore with `{k="v"}` added. This label chip is T25's Label filter chip, so this part of `e2e:bars-inspect` needs T25 I3 (label filters in Explore).
- **Anomaly toggle:** a VL-004 glow on marks with `anomaly` > 0. Without scores, the tooltip reads `No anomaly scores for this query`.

### 4.4 Design rules

#### T22-001 — True 3D or honest 2D
**MUST** — (VIZ-086.) A 3D form MUST be a real scene: depth geometry, a perspective camera with orbit, pan and dolly, depth-tested occlusion, and VL-023 light. A 2D kind MUST NOT fake depth: no bevels, extruded textures, drop shadows, isometric skins, tilts or luminance shading. Gradients are allowed only as value-axis colour ramps

#### T22-002 — No depth options on 2D kinds
**MUST** — A 3D form MUST be its own kind. barchart, pie and stat options MUST NOT include `perspective`, `projection`, `depth`, `tilt`, `shadow` or `3d`; each is `board.json.unknownKey`

#### T22-003 — One reduction path
**MUST** — `reduceSeries` MUST reduce over finite samples: `last`/`first` is the last/first finite sample, `mean`, `min`, `max` and `sum` are computed as named, and `count` is the number of finite samples. With no finite samples the result is NaN (`count` gives 0). An instant sample is returned as is. **Duplicate label sets:** series with the same label set have the same key (T04-004), so they are one series. Before reducing, they MUST be combined into one: their finite samples are merged into one strictly increasing series, so no timestamp ever has two samples. Where several duplicates have a finite sample at the same timestamp, the merged value is the largest (deterministic, and the worst for an above-threshold reading), and each such timestamp counts as a conflict. The reducer, `summaryFacts` and the baseline all read this merged series. The combined series keeps the shared key. Coverage discloses the number of series combined (`duplicates`) and the number of conflicting timestamps (`conflicts`). The baseline run's duplicates are combined the same way, so baselines still match by key

#### T22-004 — Colour and identity
**MUST** — State MUST come from `stateOf` (`vis/thresholds.ts`, T02-018). With thresholds, colour and glyph come from `StateEncoding` (T02-003, VIZ-067). Without thresholds, **every** mark MUST use its own series colour, `series-{1 + seriesColourIndex(mark)}`, from the existing `engine/canvas2d/palette.ts` (T02-005: `key_hash mod 8`, honouring level labels). Every series on screen MUST also be told apart by a visible non-colour channel (T02-003). For **bars**, every drawn bar shows its name on the category axis, and labels are never thinned. Each category band is at least 14 px, and the axis holds at most ⌊plot extent / 14 px⌋ bars. **Duplicate names:** if two drawn bars, wedges or tiles would show the same name, each gets the shortest set of label keys whose values tell it apart from the others, appended as `2.31 · region="eu"`. Sets are tried by size, then by key order. The keys come from the union of the colliding marks' label keys. A **present** value is always quoted and escaped the same way as `seriesName` (`region="eu"`, `region="∅"`). An **absent** key is written unquoted as `region absent`. No present value can therefore look like an absent one, and a series whose label set is a subset of another's is always told apart. **Final uniqueness pass:** after that, every displayed name in the panel is checked, including names that were never disambiguated and aggregate names such as `other (n)`. (1) A raw category value that equals `other` or ends with ` (<digits>)` is shown quoted (`"other"`, `"2.31 (1)"`). (2) Names that are still equal get a display-only suffix ` (1)`, ` (2)`, … in key order. Keys, selection, filters and the table are unchanged, and the aggregate is never suffixed. One pass is enough: suffixed names differ from each other by their number. They cannot equal a name without a suffix, because the only unquoted names that end in ` (n)` are `other (n)`, and a suffixed name never has the bare base `other`. Patterns come from #150's shared `client/src/engine/patterns.ts` (T21-003). `HEALTH_PATTERN` (`solid`) is used for health states only, always with their glyph. `CATEGORY_PATTERNS` = backDiagonal, horizontal, vertical, dots, crossHatch, checker, dashes, and is never repeated. `OTHER_PATTERN` (`grid`, token `category-other`) is the "other" mark. `NO_DATA_PATTERN` (`hatch`) is for no data. Bars and stat tiles carry no pattern; their identity is the visible name. **Wedges** (owner decision, 2026-11-25): pie wedges 0–6, in sort order, use `CATEGORY_PATTERNS[i]`. Any wedge whose arc would be under 6 CSS px MUST be merged into a single `other (n)` wedge. That mark is a `CategoryRow` with `members` (§5.1). Its key is `other:pie`, its name is `other (n)` and its value is the sum of its members (pie parts are non-negative and additive). It uses `OTHER_PATTERN` and is drawn last. If `other` is itself under 6 px, it gets a leader-line text label `other (n)`. Its members are listed in the legend (`other: a, b, c`), in its tooltip (name and value each) and in the table view (see `panelRows`, §5.2). Selection, filtering and the Inspector for aggregates follow T22-007 and T22-008. Patterns tile at 6 × 6 CSS px. For **stat**, the name shows on every tile of a grid: `textMode: 'value'` is invalid with `layout: 'grid'` (`board.options.textMode.invalid`), and an import maps it to `valueAndName`, with a note

#### T22-005 — Category label
**MUST** — The *effective label* is `categoryBy`. If that is unset, it is the one label key whose value varies across rows (absent counts as a value). With zero or several varying keys there is none. Rows are named by the effective label's value, or by `seriesName(labels)` when that value is empty or absent. Duplicate names get the T22-004 disambiguator. Rows MUST NOT be merged, except into the T22-004 `other (n)` display mark, which still keeps every member's row and key; the row key is the series key

#### T22-006 — Caps keep the signal
**MUST** — Caps are 200 barchart rows (and at most the T22-004 label fit) and 64 stat tiles. Over a cap, `capMarks` MUST keep, in this order: (b) the min and max finite rows; (a) rows in the worst non-OK state, up to max(1, ⌊cap/10⌋), while slots remain; (c) further rows in sort order, up to the cap. Kept rows draw in sort order. **Tiny plots (bars):** with a cap c of exactly 2, only min and max are drawn. With c below 2 (a category extent under 28 px), `framePlan` mounts no frame and returns the notice `tooSmall` instead. The notice shows, in place of the plot, `too small: N bars (min <name> <v>, max <name> <v>[, K <state>])`, and the table view and CSV still list all N rows. The single-bar case (N = 1, c = 1) draws normally. The component MUST put the result into the frame's `coverage` (§5.1), and every renderer copies it into `FrameSummary` (`seriesTotal` = `coverage.total`, `seriesShown` = `coverage.drawn`, `coverage` as is) without computing it. `coverage.query` and `coverage.baseline` hold the run's and the baseline run's existing `Completeness` (T04-012), unchanged. `coverageText(coverage)` is the VIZ-027 meter text: the applicable parts below, joined by ` · `. (1) `truncated` when `query.truncated`; the meter offers the one-click Narrow of the existing `CompletenessNotice`. (2) `limited (N warnings)` when `query.warnings` is non-empty; the popover lists each warning verbatim. (3) For the baseline run: if it is truncated, `baseline truncated`, and the stat delta reads `▲ 20 % (baseline truncated)` and the ghost tooltip says `baseline truncated`; if it is not truncated but has warnings, `baseline limited (N warnings)`, and the delta reads `▲ 20 % (baseline limited)` and the ghost tooltip says `baseline limited (N warnings)`. Either way the baseline is incomplete and `baselineRatio` is null (T22-014). (4) The cap text, built only from what was really kept: `showing X of N; kept <list>`, where the list names `min`, `max` and `K <state>` only when kept, then `; J <state> not shown` for worst-state rows left out. (5) `K values outside the fixed range`. (6) `k duplicate series combined`, with `; c conflicts (max kept)` added when c > 0. With none of these, the meter shows `100 %`; any warning or truncation in either run suppresses it. `PanelRows` keeps every row, with `drawn` set

#### T22-007 — Click selects, inspects, filters
**MUST** — A click or Enter on a mark MUST set the Context selection to the mark's key (T22-008) and send `InspectTarget` to the #164 Inspector. On a bar or wedge it MUST also apply the mark's effective-label pair: if it is already a board filter it is removed; otherwise it is set, replacing any filter with the same key. The board re-runs once. With no pair the click does not filter, and the tooltip says `Can't filter: no category label` or `Can't filter: <label> missing on this series`. On Explore the tooltip says `Filters apply on boards`. **Aggregates:** clicking `other (n)` sets the Context selection to all member keys and sends `InspectTarget` with `members`. It applies **no** filter, and the tooltip says `Can't filter: other (n) — pick a member from the legend or table`. Each member entry in the legend and each table row is clickable and acts as that member's own click

#### T22-008 — Selection
**MUST** — Panels MUST use the shared Context selection (T02 §4.6, T02-025), which is a set of keys; #150's T21-009 board store holds it. Key mapping: a mark's key is its source series key (`key_hash`). That same key is the `PanelRows` row key, `InspectTarget.mark.key` and #164's payload series key. A click writes {key}, a brush writes the covered keys, and a selection written by any other source (a line panel, a table row, the Inspector) is read the same way. A brush and a legend or table member selection write through the T25 host's `select` (T25-006). A mark matches only when its key is in the set; labels are never compared. **An empty selection (the initial state, and after Esc) MUST leave every mark undimmed.** **Relevance (T25-006):** a frame with no selected key in its own data does not dim. Otherwise, marks that do not match are drawn at the `dimmed` alpha (0.35, T25-006). An aggregate matches when **any** of its member keys is in the set

#### T22-009 — Pie guard
**MUST** — The guard MUST run on **all** reduced parts, before any cap. A pie MUST be planned as a barchart, with a notice, in three cases: more than 6 parts (`N parts: shown as bars`, where N is the pre-cap count); a negative or non-finite part (`Negative or missing parts: shown as bars`); or a total of 0 (`All parts are 0: shown as bars`). On fallback the barchart cap and `capMarks` (T22-006) apply. `validateFrameData` returns `parts`

#### T22-010 — Keyboard
**MUST** — Arrows and Home/End MUST move mark focus in draw order. Enter = click; Shift+arrow brushes; Esc clears. Each move emits `mark` (`source:'keyboard'`)

#### T22-011 — Universal interactions
**MUST** — Each kind MUST implement the §4.3 matrix. An n/a gesture or toggle is accepted without error and shows its quoted tooltip

#### T22-012 — Baseline
**MUST** — When `baselineOffset` is set, or the ghost is on (offset `baselineOffset ?? '1d'`), the panel MUST run the same query over the window shifted by the offset, in the same run and under the same AbortSignal. Baselines match marks by series key; an unmatched mark gets null. Delta = (v − b)/\|b\| × 100, drawn as `▲`/`▼`/`=` with a signed 3-significant-digit percent in `text-secondary`, never in a state colour (VL-003). If b is missing, 0 or non-finite, no delta is shown and the tooltip says why. If the baseline request fails, all baselines are hidden and `panel.baselineFailed` is shown

#### T22-013 — Table view and CSV
**MUST** — `Shift+T` MUST show `PanelRows`: all N rows before the cap, with the §4.3 columns and `drawn` (`yes`/`no`). The view is virtualised (`@tanstack/react-virtual`, 28 px rows, overscan 10), so every row is reachable by scroll and keyboard. `Export CSV` writes the same rows in the same order as RFC 4180 with a header row: numbers as `String(v)`, NaN or absent as an empty field, states by name. The file is named after the panel title with `[^A-Za-z0-9-_]` replaced by `_`

#### T22-014 — Summary facts
**MUST** — `summaryFacts` MUST fill `SummaryFacts` (VIZ-068). `subject` = title. *Focus mark* = the single tile, else the worst state (ties: higher value, then lower key). `current` = the focus mark's reduced value (formatted) and name. `change` is **one event** in the focus series: the largest \|Δ\| between consecutive finite samples in the window (first on ties); `from` = the value before it, `to` = the value after it, `atMs` (onset) = the time of the after sample. It is null for instant results and for fewer than 2 finite samples. `extent` = min and max of the **reduced mark values** (every pre-cap mark), not raw samples; null if none is finite. `baselineRatio` = current / the focus mark's baseline, when both are finite, the baseline ≠ 0 and the baseline run is complete (not truncated and no warnings, T22-006); otherwise null. #160 writes the text

### 4.5 Auto-vis (Table 5-13) and import (VIZ-060)
| Row | Condition | Result |
|---|---|---|
| 11 | *reduced categories*: 2 ≤ N ≤ 50 series (any number of varying label keys; names follow T22-005), and either an instant vector or a range result on a panel with an explicit `options.reducer` | `pie` if (`options.parts` or `planned.partition`), N ≤ 6, every value ≥ 0 and total > 0; else `barchart` (always `barchart` until I3 ships) |

Rows 5, 6 and 7 still come first: a histogram gives a heatmap, a rate rewrite a line, and a single value a stat. A range result without a `reducer` falls through to row 14 (line). Row 7 picks `stat` only while the Bullet kind is not implemented (VIZ-065: auto-vis is limited to the kinds available). Once #165's Bullet ships, a single value with a threshold or a `target` MUST select `bullet` (VIZ-039, T02 §4.7), and a single value with neither still selects `stat`.

**Parts of a whole.** When it is uncertain whether the values are parts of a whole, the panel shows bars. A whole is recognised in two ways:
- the panel option `parts: true`;
- the new OpenAPI field `PlannedQuery.partition`, which the Go planner sets from its `MetricTypes`.

`partition` is true only for a top-level `count by (L)`, or a top-level `sum by (L) (rate|increase(m[…]))` where `KindOf(m, types) == MetricCounter`. A `_total` suffix alone is not enough. In both cases L is exactly one label. It is false for gauges, for missing metadata, for other aggregations and for LogQL.

**Import mapping:**
- Reduce: lastNotNull/last → `last`, firstNotNull/first → `first`; mean, min, max, sum and count keep their names; anything else → `last` with a note.
- Stat colour, text and graph modes and orientation keep their keys (graph `area` → `sparkline`).
- Pie: type → `donut`, the first label → `labels`, and `parts: true`.
- `min`/`max` → `options.min`/`options.max` on barchart and stat (pie: dropped, with a note).
- Bar orientation and show-values → `orientation`, `valueLabels`; a stacked or grouped bar panel imports per #167.
- Thresholds → board thresholds.
- A multi-value stat → `layout: 'grid'`.

## 5. Interfaces

### 5.1 Seam types (every field `readonly` in the files)
```ts
// client/src/data/frames.ts — additions
export type Reducer = 'last' | 'first' | 'mean' | 'min' | 'max' | 'sum' | 'count';
export interface Mark { key: string; labels: Record<string, string>; name: string; value: number;
  state: State | null; baseline: number | null; anomaly: number | null }  // anomaly: null until Epic #9
export interface CategoryRow extends Mark {
  members: { key: string; labels: Record<string, string>; name: string; value: number }[] | null }  // non-null only on other (n)
export interface StatTile extends Mark { spark: { timestamps: Float64Array; values: Float64Array } | null }
export type FrameData = /* existing */
  | { kind: 'categories'; categories: CategoryRow[]; coverage: Coverage }
  | { kind: 'stats'; tiles: StatTile[]; coverage: Coverage };
export interface Coverage { total: number; drawn: number;            // pre-cap N, drawn X
  keptMin: boolean; keptMax: boolean; keptWorst: number; omittedWorst: number; worstState: State | null;
  outside: number; duplicates: number; conflicts: number;                                                   // values outside a fixed range
  query: Completeness; baseline: Completeness | null }               // decode.ts Completeness, as received
// FrameDataIssue adds { code: 'parts'; parts: number } | { code: 'cap'; count: number; max: number }

// client/src/engine/api.ts — additions
export type VisKind = 'line' | 'bars' | 'heatmap' | 'stat' | 'barchart' | 'pie';   // #165 adds gauge, bullet
type Ov = { ghost: boolean; anomaly: boolean };                              // §4.3 toggles
export type VisSpec = /* existing line | bars | heatmap */
  | ({ kind: 'stat'; title: string; unit: Unit;                              // absent keys = today
      colourMode?: 'value' | 'background' | 'none'; textMode?: 'auto' | 'value' | 'valueAndName' | 'name';
      graphMode?: 'sparkline' | 'none'; orientation?: 'auto' | 'horizontal' | 'vertical';
      valueRange?: ValueRange } & Partial<Ov>)                                // sparkline value axis; absent = auto
  | ({ kind: 'barchart'; title: string; unit: Unit; orientation: 'horizontal' | 'vertical';
      valueLabels: boolean;
      valueRange?: ValueRange; thresholds?: ThresholdLine[] } & Ov)
  | ({ kind: 'pie'; title: string; unit: Unit; donut: boolean; labels: 'percent' | 'value' | 'name' | 'none' } & Ov);
export interface MarkEvent { source: 'pointer' | 'keyboard'; key: string; index: number;
  xCss: number; yCss: number; rows: HoverRow[] }
export interface PickEvent { keys: string[]; gesture: 'click' | 'brush' }
// FrameEvents adds  mark: MarkEvent | null;  pick: PickEvent
// FrameSummary.valueAxis: a stat with a sparkline reports its sparkline axis (was null for stat)
// FrameSummary gains coverage: Coverage | null (copied from categories/stats data; null for other kinds)

// Payload for the T25 Inspector host: the InspectorTarget member {type:'mark'; target: InspectTarget}; members per T25-011
export interface InspectTarget { panelId: string; kind: VisKind; title: string; mark: Mark;
  members: CategoryRow['members'];   // aggregate: the Inspector shows members[0] as `<name> (in other)` plus the list
  unit: Unit; window: TimeWindow; query: { lang: 'promql' | 'logql'; text: string } }
```

| Kind | Accepts |
|---|---|
| barchart | `categories`, at most 200 |
| pie | `categories`, at most 6, each ≥ 0 |
| stat | `scalar` or `series` (as today), or `stats` with 1–64 tiles |

Tiles are laid out in ⌈√n⌉ columns. `horizontal` puts them all in one row and `vertical` all in one column.

### 5.2 TS transforms (`client/src/vis/reduce.ts`)
```ts
export type Sort = 'valueDesc' | 'valueAsc' | 'label' | 'none';
export function reduceSeries(s: SeriesFrame, r: Reducer): number;
export function effectiveLabel(series: readonly SeriesFrame[], categoryBy: string): string | null;
export function categoryRows(r: ExploreResult, base: ExploreResult | null, o: { reducer: Reducer;
  categoryBy: string; sort: Sort; thresholds: Thresholds | null }): CategoryRow[];
export function statTiles(r: ExploreResult, base: ExploreResult | null, o: { reducer: Reducer;
  layout: 'single' | 'grid'; sort: Sort; thresholds: Thresholds | null }): StatTile[];
export function resolveBounds(min: number | undefined, max: number | undefined, auto: ValueRange): ValueRange;
export function capMarks<M extends Mark>(sorted: M[], cap: number): { drawn: M[]; kept: { min: boolean; max: boolean; worst: number } };
export interface PanelRows { columns: string[]; rows: { mark: Mark; drawn: boolean; shownAs: string; cells: string[] }[] }
export function panelRows(kind: VisKind, all: Mark[], drawn: readonly (CategoryRow | StatTile)[], unit: Unit): PanelRows;
// member→aggregate map = every drawn row's members; drawn = yes if the key is drawn itself or is a member of a drawn aggregate;
// `shown as` = its own display name, the aggregate's name (e.g. `other (4)`) for members, or empty when not drawn
export function summaryFacts(kind: VisKind, title: string, r: ExploreResult, all: Mark[], unit: Unit): SummaryFacts;
```

## 6. Data & storage

### 6.1 Board spec v3 (OpenAPI `Vis.options`, Go `internal/spec`, TS `boards/spec.ts`)
`Vis` gains `options` (`additionalProperties: false`). The kind enum adds barchart and pie.

| Error | When |
|---|---|
| `board.json.unknownKey` | the key is not allowed for the kind |
| `board.options.<key>.invalid` | a bad enum value; a `min`/`max` that is not finite or has \|v\| > 1e15; a non-empty label key that fails `FILTER_LABEL` |
| `board.options.max.invalid` | both set and `min` ≥ `max` |

**Bounds mapping:** `resolveBounds(min, max, auto)` gives the `valueRange` that a barchart and a stat sparkline (VisSpec `valueRange`) use. The auto bounds are the ADR-0022 auto domain: drawn values and thresholds, or the stat's spark values.
- An absent bound takes its auto value.
- Only `min` set and `min` ≥ auto max: max = min + (auto max − auto min, or 1 when that is 0).
- Only `max` set and `max` ≤ auto min: min = max − (the same span).
- Both set: they are already valid (`min` < `max`).
- Values outside the range draw clipped at the edge, and the coverage note says `K values outside the fixed range`.
- A user camera pin (#93) wins for the session.
- A pie drops the bounds, with an import note.

A later key addition bumps `schema_version`, with an identity upcaster (T11-016) and a `vN-full.json` fixture.

| Key | Values | Default | Kinds |
|---|---|---|---|
| reducer | Reducer | `last` | barchart, pie, stat, auto (§4.5 row 11) |
| baselineOffset | `1h`\|`1d`\|`7d`\|`28d` | absent | barchart, stat |
| categoryBy | absent or `''` (= unset, use the effective label), else a `FILTER_LABEL` key | absent | barchart, pie |
| sort | Sort | `valueDesc` | barchart, pie, stat |
| orientation | `horizontal`\|`vertical`; stat also `auto` | barchart `horizontal`, stat `auto` | barchart, stat |
| valueLabels | bool | true | barchart |
| min, max | number, \|v\| ≤ 1e15, each optional | absent (auto) | barchart, stat |
| donut, labels | bool; `percent`\|`value`\|`name`\|`none` | true; `percent` | pie |
| parts | bool (values are parts of a whole) | false; true on an imported pie | auto, pie |
| layout | `single`\|`grid` (`single` with more than one series after reduction is planned as `grid`, with notice `N series: shown as a grid`; if `textMode` is `value`, it is promoted to `valueAndName` and the notice reads `N series: shown as a grid with names`) | `single` | stat |
| colourMode | `value`\|`background`\|`none` | `value` | stat |
| textMode | `auto`\|`value`\|`valueAndName`\|`name` (`auto`: `value` for one tile, `valueAndName` in a grid; `value` with `layout: 'grid'` is invalid) | `auto` | stat |
| graphMode | `sparkline`\|`none` | `sparkline` | stat |

## 7. Performance budget

Targets: 200 bars, 6 wedges, 64 tiles. `bench:frame-interim-categories` takes 50 timed draws per T22 gallery page and reports p50/p95 (report only until #68). Engine gates come with I4 (§11).

## 8. Security, tenancy & RBAC

Validated options, plain-text labels (T02-019), `f=` filters, no storage.

## 9. Failure modes & degradation

| Risk | Handling |
|---|---|
| A query lacks the filter label | Board `f=` semantics are unchanged |
| The baseline doubles query load | Runs only with an offset or the ghost on; visible-only gating and cancellation apply |
| A pie with no whole | The §4.5 rule; bars otherwise |
| The interim engine outgrows the real one | I4 gates the swap |
| #164 slips | I1–I3 wait for it |
| Tenancy | No new storage or route |

## 10. Testing

### 10.1 Test files

| Gate | File |
|---|---|
| `unit:category-*`, `unit:stat-*` | `client/src/vis/reduce.test.ts` |
| `unit:autovis-table` | `client/src/vis/autovis.test.ts` |
| `unit:board-spec` | `client/src/boards/spec.test.ts` and Go `internal/spec` |
| `itest:planned-partition` | `server/internal/pulsusdb/prom/plan_test.go` |
| `e2e:*` | `client/e2e/panels-categorical.spec.ts`, stub BFF |

### 10.2 Fixtures
- `byVersion`: `{version=2.29…2.33}` = 40, 7, 120, 3, 15.
- `many`: 250 series with values 250…1; only the value-10 series is failing.
- `threeKeys`: 4 instant series `{a, b, c}` = {1,x,p}, {2,y,p}, {3,x,q}, {4,y,q}, values 4, 3, 2, 1 (three keys vary).
- `stat3`: thresholds above, watch 5 and failing 8; series `s1` = 9, `s2` = 5, `s3` = 1.

### 10.3 I1: Bar chart, frames, filters, selection, table view

| Test | Expected |
|---|---|
| `unit:category-reduce` | [1, NaN, 3] → last 3, first 1, mean 2, min 1, max 3, sum 4, count 2; all NaN → NaN, count 0 |
| `unit:category-cap` | `capMarks(many, 200)` (the label fit is not applied in this unit test) draws 200 rows, including the failing value-10 row and the min 1. `coverage` = {total 250, drawn 200, keptMin true, keptMax true, keptWorst 1, omittedWorst 0, worstState failing, outside 0}. The note reads `showing 200 of 250; kept min, max, 1 failing` |
| `unit:category-tiny` | `capMarks(many, 3)` keeps max 250, min 1 and the failing 10, with text `showing 3 of 250; kept min, max, 1 failing`. `capMarks(many, 2)` keeps 250 and 1, with `coverage` {drawn 2, keptMin true, keptMax true, keptWorst 0, omittedWorst 1} and text `showing 2 of 250; kept min, max; 1 failing not shown`. A plot 20 px tall (c = 1) and one 10 px tall (c = 0) both give notice `tooSmall` with the text `too small: 250 bars (min 1 1, max 250 250, 1 failing)` and no frame mounted, while `Shift+T` still lists 250 rows. `byVersion` filtered to one series at 20 px draws its one bar |
| `unit:frame-coverage` (`Canvas2DEngine.test.ts`) | Draw `many` planned as a barchart on a plot 2 800 px tall, so the label fit is 200. The `a11y` FrameSummary has `seriesTotal` 250, `seriesShown` 200, and a `coverage` equal to the data's. I4 runs the same check on the WASM engine (`unit:frame-summary-parity`) |
| `unit:coverage-text` | complete, uncapped, in range, no baseline → `100 %`; warnings [`series limit reached`], not truncated → `limited (1 warning)`, not `100 %`; current truncated → `truncated`; baseline truncated → `baseline truncated`; baseline with 2 warnings and not truncated → `baseline limited (2 warnings)` (not `baseline truncated`); `many` → `showing 200 of 250; kept min, max, 1 failing`; truncated and capped → `truncated · showing 200 of 250; …` |
| `e2e:categorical-coverage` | Four `byVersion` stubs. Complete: the meter shows `100 %`. Warning only: `limited (1 warning)`, and the popover lists `series limit reached`. Truncated: `truncated`, and Narrow opens Explore with the query. A stat whose baseline stub is truncated: meter `baseline truncated`, delta `▲ 20 % (baseline truncated)` |
| `unit:category-colour` | `byVersion` without thresholds: every bar's colour index equals `seriesColourIndex` of its own key, and bars carry no pattern. A 300 px horizontal plot holds 21 bars, all labelled. With thresholds: state colours, `solid` and glyphs |
| `golden:interim-gallery` `barchart-series`, `barchart-dupes` (each also in greyscale) | In greyscale: `barchart-dupes` (`categoryBy: version`, series {2.31, eu} 50, {2.31, us} 70, {2.30, eu} 20) reads `2.31 · region="us"`, `2.31 · region="eu"` and `2.30` on the axis, so the bars can be told apart without colour |
| `unit:category-label` | `byVersion` → `version`; two varying keys → null, and a click shows `Can't filter: no category label`; the `barchart-dupes` series → names `2.31 · region="us"`, `2.31 · region="eu"`, `2.30` |
| `unit:category-duplicates` | Instant: two {version=2.31} series (key K) at the same `atMs`, 50 and 70, plus {version=2.30} = 20 → 2 rows, 2.31 = 70 with key K, `duplicates` 1, `conflicts` 1, text `1 duplicate series combined; 1 conflicts (max kept)`. Range without overlap: [1, 3] at t0, t2 and [2] at t1 → [1, 2, 3], strictly increasing, `conflicts` 0. Range with overlap: [1, 5] at t0, t1 and [4, 2] at t1, t2 → [1, 5, 2], one sample per timestamp; `summaryFacts` change is 1 → 5 at t1, with no 5 → 4 step. Selection: clicking 2.31 writes {K}, and a second panel holding K highlights it. Baseline: a duplicate pair 30 and 35 at one instant → 35 (conflict counted), matched to K, delta `▲ 100 %` |
| `unit:category-subset-names` | `categoryBy: version`. Case A: {version="2.31"} = 40 and {version="2.31", region="eu"} = 60 → `2.31 · region="eu"` and `2.31 · region absent`. Case B (a value that looks like a marker): {version="2.31"} = 40 and {version="2.31", region="∅"} = 60 → `2.31 · region="∅"` and `2.31 · region absent`, which differ. Both cases give the same names as bars (axis), as pie wedges (legend) and as a stat grid (tile names). Greyscale golden `barchart-subset` runs case B |
| `unit:category-unique-names` | `categoryBy: version`, rows A {version="2.31", region="eu"}, B {version="2.31", region="us"} and C {version='2.31 · region="eu"'}, keys ordered A < C. After disambiguation, A and C both read `2.31 · region="eu"`. The final pass gives A `2.31 · region="eu" (1)`, C `2.31 · region="eu" (2)` and B `2.31 · region="us"`. A value `other` beside an `other (4)` aggregate reads `"other"`. A value `2.31 (1)` reads `"2.31 (1)"`. All displayed names are pairwise distinct. The same holds for bars (axis), pie (legend) and a stat grid (tiles). Clicking A still selects key A only |
| `unit:board-spec` (TS and Go, same fixtures) | v3 round-trips; `options.perspective` on barchart → `board.json.unknownKey` at `/panels/0/vis/options/perspective`; `categoryBy` absent, `''` and `version` are valid, `bad key` → `board.options.categoryBy.invalid`; `min` 0 with `max` 500 is valid, `min` 5 with `max` 5 → `board.options.max.invalid`, `max` 1e16 → `board.options.max.invalid` |
| `unit:category-bounds` | auto [0, 120]: (absent, absent) → [0, 120]; (0, 500) → [0, 500]; (500, absent) → [500, 620]; (absent, −10) → [−130, −10]; auto [5, 5], (10, absent) → [10, 11] |
| `e2e:bars-bounds` | A board fixture shaped like import output: a barchart, `options` {min: 0, max: 500}, data `byVersion`. Save and reload → `FrameSummary.valueAxis` = {0, 500, manual true}. Only `max` 500 → {0, 500}. Only `min` 500 → {500, 620}, with the note `5 values outside the fixed range` |
| `unit:autovis-table` | instant `byVersion` → barchart (rule 11; pie not yet available); instant `threeKeys` → barchart, named by `seriesName`; range `byVersion` with `reducer: 'last'` → barchart; the same range without `reducer` → line (rule 14); a range histogram with `reducer` → heatmap (rule 5); a rate-rewritten bare counter with `reducer` → line (rule 6) |
| `e2e:bars-filter` | `byVersion`: bars ordered 120, 40, 15, 7, 3; click `2.31` → `f=version=2.31` with one re-run; click again → removed. With `f=version=2.30` set, clicking `2.31` → `f=version=2.31` (replaced) |
| `e2e:bars-inspect` | clicking `2.31` opens the Inspector with `version=2.31` and `120`; its chip opens Explore with `{version="2.31"}` (the label chip needs T25 I3) |
| `e2e:categorical-interactions` | `byVersion` focused with Tab → focus index 0 (`2.31`); ArrowRight ×2 → `mark` index 2 (`2.33`) and the mirror's `aria-activedescendant` follows; Home → 0; End → 4 (`2.32`); Shift+ArrowRight ×2 from 0 → `pick` {[2.31, 2.29, 2.33], brush} and a second `byVersion` barchart dims the other two; Esc clears; Enter on `2.31` → `f=version=2.31`; a line panel's crosshair → `Values are reduced over`; ghost on with the baseline stub at half of `byVersion` → a canvas probe at bar `2.31`, value 60, finds the dashed `text-secondary` outline, and the tooltip shows `baseline 60` |
| `e2e:selection-empty` | Two `byVersion` barcharts. On load, a canvas probe at each bar's centre equals the bar colour at full alpha in both panels. A brush over [2.31, 2.29] dims the other three bars in the second panel. After Esc, all five bars are back at full alpha |
| `e2e:selection-keys` | Two series share labels: A {version=2.31, region=eu} = 50 and B {version=2.31, region=us} = 70. Panel 1 is a barchart with `categoryBy: version`, whose bars read `2.31 · region="eu"` and `2.31 · region="us"`; panel 2 is a line panel of the same query. Clicking A in panel 1 dims B in panel 1 (label inclusion would have matched both). Selecting B in the line panel (T21-009 `select`) dims A and highlights B in panel 1. The Inspector opened from A shows series key `A.key`, and the `Shift+T` row for A has `A.key` |
| `e2e:categorical-table-view` | `many` on a horizontal barchart whose plot is 600 px tall, so the label fit is 42 bars: `Shift+T` scrolls to row 250, and `drawn` = `no` on 208 rows; the CSV has header `name,value,baseline,state,drawn,shown as` and 250 rows; NaN is an empty field |
| `unit:category-summary-facts` | range series `2.31` = [100, 100, 400, 120] at t0…t3 (failing, baseline 60), `2.30` = [5, 7], `2.29` = [40, 40]; reducer `last` → marks 120, 7, 40. Facts: current `120` `2.31`; change from 100 to 400 at t2; extent 7…120; baselineRatio 2. The same as an instant result → change null, extent unchanged; the same data with a warning-only baseline run → baselineRatio null |
| Gallery | `barchart`, `barchart-dupes`, `barchart-cap` |

### 10.4 I2: Stat tiles, modes, baseline delta

| Test | Expected |
|---|---|
| `unit:stat-defaults` | a stat panel without `options` → spec `colourMode: 'value'`, `textMode: 'auto'`, `graphMode: 'sparkline'`, `orientation: 'auto'`; its frame equals today's `stat-sparkline` golden; in a grid the text is value and name |
| `unit:stat-grid-text` | `unit:board-spec`: `layout: 'grid'` with `textMode: 'value'` → `board.options.textMode.invalid`; `layout: 'single'` with `textMode: 'value'` is valid. Import of a multi-value stat with value-only text → `valueAndName`, plus an import note |
| `unit:stat-tiles` | `stat3`, grid → keys s1, s2, s3; values 9, 5, 1; states failing, watch, ok; labels kept. 70 series with values 70…1 where only value 3 is failing → 64 tiles, including the value-3, value-1 (min) and value-70 (max) keys |
| `unit:stat-single-multi` | `layout: 'single'` on `stat3` (3 series), with a baseline run of the same 3 series at 6, 5, 2 → planned as a grid of 3 tiles in sort order s1, s2, s3, with notice `3 series: shown as a grid`. Each tile's baseline is matched by key (s1 9 vs 6 → `▲ 50 %`; s2 5 vs 5 → `= 0 %`; s3 1 vs 2 → `▼ 50 %`). `summaryFacts` focuses on s1 (failing). A single series stays `single`, with no notice |
| `unit:stat-single-value-multi` | `layout: 'single'` with `textMode: 'value'` (valid) on `stat3` → a 3-tile grid in which every tile shows name and value, with notice `3 series: shown as a grid with names`. The saved options are unchanged: after reload, `textMode` is still `value`. One series → one tile, value only |
| `unit:autovis-table` (row 7, before #165) | with the available-kinds set lacking `bullet`, a single value with thresholds → `stat` and a single value without → `stat`. The same fixture with `bullet` in the set → `bullet` (this case runs once #165 lands, see `plans/165/draft-from-151.md`) |
| `e2e:stat-bounds` | An imported stat: `options` {min: 0, max: 200} over series [100, 120, 150]. Save and reload validate. `FrameSummary.valueAxis` = {0, 200, manual true}. The sparkline point for 100 is at half the sparkline height (canvas probe, ±1 px). `min` 300 alone → axis {300, 350} and the outside note |
| `unit:stat-delta` | 120 vs 100 → `▲ 20 %`; vs 0 → no delta, with the reason; equal → `= 0 %`; unmatched key → null; complete baseline 100 → `▲ 20 %`, ratio 1.2; baseline with 1 warning, not truncated → `▲ 20 % (baseline limited)`, ghost tooltip `baseline limited (1 warning)`, ratio null; truncated baseline → `▲ 20 % (baseline truncated)`, ratio null |
| `e2e:board-stat-delta` | shifted window stubbed at 100/s → `▲ 20 %`, tooltip `100/s 1 d ago`; baseline HTTP 500 → value kept, delta hidden, `panel.baselineFailed`; a tile click opens the Inspector |
| `golden:interim-gallery` `stat-grid` (also in greyscale) | Every tile shows its name |
| Gallery | `stat-grid`, `stat-delta` |

### 10.5 I3: Pie and donut with the guard

| Test | Expected |
|---|---|
| `unit:pie-guard` | 9 parts → bars with `9 parts: shown as bars`; a part of −1 → bars; [0, 0, 0] → bars with `All parts are 0: shown as bars`; an explicit pie over `many` (250 parts) → barchart with notice `250 parts: shown as bars`, coverage note `showing 200 of 250; kept min, max, 1 failing`, and `seriesTotal` 250 |
| `unit:pie-auto-zero` | auto, `parts: true`, instant [0, 0, 0] → barchart |
| `itest:planned-partition` | true: `sum by (route) (rate(http_requests_total[5m]))` with counter metadata; `count by (a) (up)`. False: `sum by (region) (rate(temperature[5m]))` with gauge metadata; the counter query without metadata; `avg by (a) (x)`; `sum by (a, b) (rate(c[5m]))` |
| `unit:autovis-table` | the true cases, instant or range with `reducer`, → pie for N ≤ 6; a 7-part partition → bars; temperature → bars, but → pie with `parts: true` |
| `e2e:pie-guard` | A board pie on a 9-series instant stub (values 9…1) → a barchart in order 9…1, notice `9 parts: shown as bars`. A 3-series stub with a −1 part → bars, notice `Negative or missing parts: shown as bars` |
| `unit:category-other` | `pie-small` aggregate: `members` = 4 entries, each with a distinct key and `version` label. Clicking it selects those 4 keys; a second panel holding one of them highlights it; the aggregate matches when one member key is selected; no `f=` is added and the tooltip shows `Can't filter: other (4) — pick a member from the legend or table`. Clicking member `2.40` in the legend adds `f=version=2.40`. `InspectTarget.members` has length 4. `panelRows` for `pie-small`: 6 rows; 2.36 and 2.37 have drawn `yes` and their own name as `shown as`; 2.38–2.41 have drawn `yes` and `shown as` = `other (4)`. The CSV has the same 6 rows and values |
| `e2e:pie-table-view` | A board pie on `pie-small`. `Shift+T` shows the visible column `shown as`: rows 2.36 and 2.37 read their own names, and 2.38–2.41 read `other (4)`. `Export CSV` has the header `name,value,percent,state,drawn,shown as`, 6 rows, and `other (4)` in the last column of those 4 rows |
| `golden:interim-gallery` `pie-six`, `pie-small` (each also in greyscale) | In greyscale:<br>`pie-six` (6 large parts): wedges use `CATEGORY_PATTERNS[0..5]`, each matching a named legend swatch, and none uses `solid` or `hatch`.<br>`pie-small` (6 parts `version=2.36…2.41` = 90, 6, 1.5, 1, 1, 0.5 in a pie of 60 px radius, so 1.5 % is a 5.7 px arc): the 4 wedges under 6 px merge into one `grid` wedge, `other (4)`, of 15 px; the legend reads `other: …` with 4 names, and the tooltip lists 4 values.<br>Clicking `other` in `pie-small` opens the Inspector on the first member, shown as `(in other)` |
| Gallery | `pie`, `pie-guard` |

### 10.6 I4: Engine marks for the T22 kinds

| Test | Expected |
|---|---|
| `golden:gallery` | each T22 page matches on T1 and T2 (T02-029) |
| `unit:frame-summary-parity` | extended to the new kinds |
| `bench:frame-gallery` | each page at its target, p99 ≥ 45 fps on (b) |

## 11. Rollout

Four implementation issues, filed in this order:

- **I1 — Bar chart, frames, filters, selection, table view.** 2D now; depends on #164. Covers VIZ-037, -065 r11, -003, -005, -027, -066, -068 (facts); rules T22-002, -003, -005…-008, -010, -011, -013, -014. Writes the seam ADR (`categories`, `barchart`, `mark`, `pick`, interim coverage, "every engine implements T22 kinds before replacing `engine/index.ts`") and board spec v3.
- **I2 — Stat tiles, modes, baseline delta.** 2D now; depends on I1. Covers VIZ-095, -057; rules T22-004, -012, -014. Writes the seam ADR (`stats`).
- **I3 — Pie and donut with the guard.** 2D now; depends on I1. Covers VIZ-038, -065 r11 (pie); rule T22-009. Writes the seam ADR (pie) and adds the OpenAPI `partition` field.
- **I4 — Engine marks for the T22 kinds.** Engine; depends on #68, #69 and I1–I3. Covers VIZ-001, -002, -004.

**Every issue also ships:**
- gallery pages (VIZ-069; `golden:interim-gallery` in dark, light and greyscale; `GALLERY_SEED`; baselines from CI);
- a `docs/client/panels.md` section (I1 creates the page), a `docs/server/boards-api.md` note and its T05 rows.

## 12. Alternatives considered

- pie in DOM SVG (breaks VIZ-001);
- waiting for the engine (the owner's priority is query dashboards);
- a 3D flag on bar or pie (forbidden by VIZ-031);
- reducing in the engine (breaks T02-018).

## 13. Open questions

None.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-24 | #151: bar chart, pie and stat; rules T22-001 to T22-014; VIZ-095. Code review r1: §4.5 row 7 picks Stat only until Bullet ships (VIZ-039); I2 `unit:autovis-table` row 7 case |
| 1.1-rc | 2026-11-25 | #164 ([T25](T25-inspector-and-pivots.md)): §4.3 and §5.1 send `{type:'mark', target}`; T22-008 gains the T25-006 relevance rule (a frame with no selected key does not dim) and writes brush and legend selection through `select`; aggregate members per T25-011; the `e2e:bars-inspect` label chip needs T25 I3. Code review r1: T22-008 uses the T25-006 `dimmed` token |
