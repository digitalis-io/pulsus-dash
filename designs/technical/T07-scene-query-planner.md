# T07 — Scene query planner

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.7-rc · 2026-11-21 |
| **Milestone** | M-UI1 (metrics, step/level, dedupe, cancel, passes P0–P4, human budgets, expressions) → M-UI2 (all signals, R2/R9 fallbacks, fusion, approach prefetch) → M-UI3 (local placement, R5/R6 fallbacks, Postgres fallback pyramids, level-split) → M-UI4 (virtual sources, BFF joins, agent budgets) → M-UI5 (Board variables, 200 viewports) |
| **Related ADRs** | [ADR-0015](../adr/0015-go-bff.md), [ADR-0014](../adr/0014-typescript-react-web-client.md) (supersede ADR-0001), [ADR-0005](../adr/0005-arrow-wire-format.md), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md), [ADR-0013](../adr/0013-metrics-data-scopes.md), [ADR-0021](../adr/0021-query-planning-is-server-side.md) |
| **Source draft** | plans/tech/T07-scene-query-planner.md (not tracked) |

## 0. Applicability under ADR-0015 and ADR-0014 (2026-11-19)

The planner runs in the Go BFF ([ADR-0015](../adr/0015-go-bff.md)); the browser is a TS application
with the chart engine later ([ADR-0014](../adr/0014-typescript-react-web-client.md)). The pipeline,
the rules T07-001 to T07-030 and the budgets stand, except that every rule or structure that needs a
parsed query applies only from the later parser design (table below). Rust specifics map as follows:

| Was | Now |
|---|---|
| `dash-planner` crate | Go package `internal/planner` |
| `pulsus-plan` IR shared with the browser (WASM) | **Not shared.** §5.2 is authoritative as a data shape (the **v1 IR** of §5.2 now; the parsed IR of §5.2 from the parser design), implemented as Go types in `internal/planner/ir` and used in-process by T15 and T16. T13 (draft), the browser's local engine, receives `LogicalQuery` in the JSON form published in `api/openapi.yaml` and is held to the same semantics by fixtures in `wire/fixtures/plan/`; T13 is revised before M-UI3 |
| Parser crates in §4.2 | PromQL is parsed in `internal/pulsusdb/prom` with the upstream Go PromQL parser, **for the planning shape only** ([ADR-0021](../adr/0021-query-planning-is-server-side.md)). LogQL and TraceQL stay opaque |
| `dash-vsrc`, `pulsus-colexec` (virtual sources, M-UI4) | Go packages `internal/vsrc` and `internal/colexec`; T07-021 stands |
| Rust code blocks (§5) | Normative as data shapes; the wire form is the OpenAPI schema |
| Frames to the browser | JSON frames until the engine (#68), then Arrow ([T04](T04-wire-format-and-data-plane.md) §0) |
| Hidden tab via the shim | `document.visibilityState` in the TS application |

**v1: queries are opaque except for the planning rewrites.** No part of the planner normalises,
fuses or re-prints query text. The only rewrites are the closed list of
[ADR-0021](../adr/0021-query-planning-is-server-side.md): variable and macro substitution, and the
PromQL counter and histogram rate wraps of the exact source bytes. `LogicalKey` hashes the planned
text. A query is the **v1 IR** of §5.2: an `OpaqueQuery{lang, kind, text}` whose `text` is sent to
PulsusDB byte-for-byte as planned (after substitution by the language module, M-UI1, ADR-0021).

| Planner feature | v1 behaviour (no parse) | From the parser design |
|---|---|---|
| Identity (§4.2) | `LogicalKey = xxh3_128(signal, lang, kind, text bytes, shape)` on the **exact** text: no trimming, no whitespace or comment normalisation | Canonical printing (§4.2) |
| Planning rewrites | `prom.Plan` / `logs.Plan` (ADR-0021) | unchanged |
| Step, level, alignment (§4.3, T07-003, T07-004) | Unchanged: they depend on the viewport range and width, not on the text | — |
| Exactness prediction (§4.3, T07-005) | `Predicted{level}` from the range→level rule alone (`predict_exactness(level)`); `RawExact` only when the level is `None` | Per-function rollup eligibility |
| Dedupe (§4.4, T07-007) | Identity, range union and display derivation on the exact-text key | — |
| Classification (§4.11.2) | Always `SourceClass::PulsusDb` | `Virtual`, `Mixed` |
| Reserved names (T07-020) | Text containing `ALERTS`, `ALERTS_FOR_STATE` or `pulsus_anomaly_score` as a whole word, or the bytes `source="pulsus-dash"`, is refused with `virtual_unsupported` by the `VirtualGuardLayer` byte match before dispatch. This may refuse a query that only mentions the name inside a string; the refusal says so. The v1 guard also screens the editor-completion inputs (`match[]`, `metric`) with the same byte match (#62) | Virtual resolution |
| Fusion (§4.4, T07-006), virtual sources and joins (§4.11, T07-021 to T07-023), selector-based estimates (§4.8), metrics-family scopes (T07-015) | Not available | All of these |
| Expressions (§4.14, T07-030) | v1 form in §4.14: the client sends the expanded expression as one query text | Operand reuse (T07-030) |
| Log volume (#65) | The BFF wraps the text byte for byte as the single operand of a fixed template, `sum by (level, detected_level) (count_over_time(` + text + newline + `\| drop __error__ [<step>s]))`, with a newline before the suffix as in §4.14. Nothing is parsed or rewritten inside the text; error positions in the composed text map back into it | — |
| Scope rewrite (§4.7, T07-014) | The v1 `ScopeRewriter` returns the text unchanged with a full-tenant `ScopeProof` for an unrestricted principal and refuses every restricted principal with `scope_denied` (T07-002) | T10 (draft), M-UI6 |
| Native operations (§4.12: R2, R4, R5, R6, R9; from M-UI2) | Built by text composition from structured inputs Dash holds (catalogue, Context, templates), never from parsing user text. An operation that would need a selector *extracted from* a user query is unavailable | Selector extraction |
| Validation | PulsusDB's parse error, at the position PulsusDB returns or on the whole query, mapped to the error envelope ([T09](T09-query-editors.md) §0) | — |

Test: `unit:planner-opaque-key`: the planned texts ``up # note`` + newline + ``+ up`` and
``up # note + up`` get different `LogicalKey`s; byte-identical planned texts share one physical
query; the `query` parameter sent to `pulsus-fake` equals the planned text (`planned.query`)
byte-for-byte; a restricted principal gets
`scope_denied` and no request.

The **later parser design** is decided before the first milestone that needs one of the features
above (fusion, M-UI2). The candidates are the browser's WASM build of PulsusDB's parser crates
([ADR-0014](../adr/0014-typescript-react-web-client.md) §2) supplying a parsed form with the query,
or a server-side parser; a server-side parser needs a new ADR that amends ADR-0015.

## 1. Context & problem

A panel in a classic dashboard tool issues its own query. A Pulsus **scene** ([02 §2](../product/02-information-architecture.md)),
whether Atlas, Lens, Board or workbench, contains up to 200 viewports (PRF-022). Their data needs
overlap heavily: a Lens shows the same RED series as a sparkline, a main chart and a pod strip, and a
Board's variables fan the same template across entities. The camera moves continuously, so the set of
needed data changes 60 times a second.

The planner turns "what is visible, at what pixel resolution, and what is the camera approaching"
into the smallest set of requests that fills it, in passes (cached → local → coarse → fine →
prefetch). It cancels whatever the camera has left behind. It is the main reason Dash can hold the
[09](../product/09-performance-contract.md) latency targets without overloading PulsusDB.

Since decision D2 ([ADR-0012](../adr/0012-derived-state-in-postgres.md)), the planner has a second
backend. Dash-derived state (alert history, alert state, anomaly scores, Dash change events) lives in
Postgres and is queried through the **same interface** as telemetry: the reserved selectors
`ALERTS`, `ALERTS_FOR_STATE`, `pulsus_anomaly_score` and `{source="pulsus-dash"}` resolve to
Postgres-backed **virtual sources**, evaluated in the BFF and joinable with PulsusDB series within
documented limits (§4.11). Fallback pyramids for a PulsusDB without R4 are Postgres Arrow tiles
(§4.12).

The planner runs in the Go BFF ([T06](T06-bff-architecture.md) §4.1, `internal/planner`). Its IR
(§5.2) is Go types; the browser's local engine (T13 (draft)) receives the same logical plan in its
JSON form and is held to the same semantics by shared fixtures (§0).

## 2. Goals / non-goals

**Goals**
- Step from pixel width, aligned to PulsusDB's rollup levels and grids, so answers are exact where
  possible and cache-friendly everywhere.
- Deduplicate and merge across all viewports of a scene, and across sessions through singleflight
  ([T06](T06-bff-architecture.md) §4.4).
- Progressive passes with explicit exactness labels (⚡ local · ☁ server · ✓ exact,
  [09 §6](../product/09-performance-contract.md)).
- Cancel on supersede within one frame of the browser's intent changing.
- Per-user and per-agent budgets, enforced before execution using R14-fallback estimates.
- One authoritative insertion point for RBAC rewriting (T10 (draft)).
- Postgres-backed virtual sources and BFF joins, behind the same query interface.
- A concrete fallback plan for each PulsusDB gap: R2, R4, R5, R6, R9, R13 and R14.
- An explain view that shows the whole plan.

**Non-goals**
- PulsusDB query-language semantics. PulsusDB evaluates PromQL, LogQL and TraceQL; the planner only
  sets parameters and, from the parser design (§0), rewrites selectors (scope, grouping fusion). The exception is the documented PromQL
  and LogQL subset the BFF evaluates over virtual sources and joins (§4.11).
- Wire framing ([T04](T04-wire-format-and-data-plane.md)), the local executor (T13 (draft)), query
  editors ([T09](T09-query-editors.md)).
- Alert evaluation semantics ([T16](T16-alert-evaluator.md)); the evaluator submits
  `Purpose::Alert` queries through this planner.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [PRF-006](../product/09-performance-contract.md#prf-006--no-interaction-waits-on-the-network) | §4.5, §4.6 (P0/P1 placements; refinement never blocks) | `e2e:network-zero-after-paint`: with the network throttled to 0 B/s after first paint, scripted pan/zoom/scrub issue no blocking request; restoring the network refines without interrupting input |
| [PRF-026](../product/09-performance-contract.md#prf-026--show-cached-marked-stale) | §4.5 (held-tile bloom), §4.6 (P0 cached) | `e2e:reopen-cached-hatched`: re-opening a scene with a 2 s network delay paints IndexedDB tiles hatched in the first frame; `itest:planner-held-tiles` (only missing tiles are physicalised) |
| [PRF-027](../product/09-performance-contract.md#prf-027--coarse-first) | §4.3 (`resolve`, coarse = width/4), T07-003 | `prop:planner-resolve`: for every (range, px, level table), the P2 step ≈ range / (px / 4) within one rollup level, is a multiple of the level width, and is ≤ the interval cap; fixture 1 200 px × 1 h gives 12–15 s |
| [PRF-028](../product/09-performance-contract.md#prf-028--refine-and-pre-fetch-neighbours) | §4.6 (P3 fine, P4 flank ±1 window) | `itest:planner-flank`: after full refinement, panning one window left/right issues no new physical query and paints full resolution in the first frame |
| [PRF-030](../product/09-performance-contract.md#prf-030--cancel-superseded-requests) | §4.6 (generations, supersede, linger), T07-009, T07-010 | `itest:planner-cancel`: 10 window changes in 1 s against seeded PulsusDB give 9 cancelled physical queries and only the last window's frames painted; `replay:no-stale-paint` (generation invariant) |
| [PRF-031](../product/09-performance-contract.md#prf-031--truncation-honesty) | §4.13, T07-027 | `itest:422-narrow-hint`: a seeded `422` surfaces a "too broad" error with a narrowing hint that re-issues a narrower query; seeded `truncated=true` sets the partial-data badge |
| [PRF-024](../product/09-performance-contract.md#prf-024--graceful-degradation-under-memory-pressure) | §4.13 (memory-pressure replan), T07-029 | `e2e:memory-pressure-rollup`: induced pressure sends `Pressure{level}`; affected viewports are re-planned to rollup data within 1 s and their source badge changes (T01/T04 co-own) |
| [AUD-041](../product/01a-audiences-and-perspectives.md#aud-041--show-data-trust) | §4.6 (Completeness per viewport, `data_age_ms`) | `itest:completeness-trailer` (T06 co-owns) |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) | §4.6, §4.11, §4.12, T07-024 | `itest:coverage-labels`: each fallback (R2, R5, R6, R9, Postgres pyramids, virtual sources, withheld families) produces a non-empty coverage label; a complete result reports 100 % |
| [SRF-028](../product/04-surfaces.md#srf-028--query-explain) | §4.10 (plan explain, on-demand PulsusDB explain) | `itest:explain-matches-headers`: for a seeded 7-day query, the explain view's rollup, rows read and server time equal the PulsusDB explain response |
| [SRF-030](../product/04-surfaces.md#srf-030--metrics-auto-vis-and-multiple-queries) | §4.14 (multi-query expressions), T07-030 | `itest:planner-expressions`: queries A and B plus `A / B` return three result sets; in v1 (§0) from three physical queries with the expression sent as expanded text (§4.14), including `unit:expr-expand-line-comment`, and from two once T07-030 applies; the expression equals PulsusDB's own `A / B` within float tolerance |
| [INT-028](../product/03-interaction-model.md#int-028--live-mode) | §4.13 (LIVE head refresh), T07-028 | `itest:planner-live-refresh`: in LIVE, only the head tile is re-fetched each step, by delta; a hidden tab suspends refresh |
| [INT-030](../product/03-interaction-model.md#int-030--comparison-baseline-ghost) | §4.1 (Context baseline), §4.4 | `itest:planner-baseline`: toggling the baseline ghost plans one extra physical query per series query (shifted range), served from cache when already held |
| [IA-002](../product/02-information-architecture.md#ia-002--context-is-the-one-state-every-view-reads) | §5.1 (`Context` in every plan) | `itest:planner-context`: changing any Context member re-plans every viewport that reads it and no other |
| [PRF-010](../product/09-performance-contract.md#prf-010--warm-navigation-to-first-coarse-lens-data) | §4.6, §4.9, §7 | `load:synthetic-lens` p75 first coarse < 300 ms on seeded PulsusDB |
| [PRF-011](../product/09-performance-contract.md#prf-011--lens-fully-refined) | §4.6, §7 | `load:synthetic-lens` p75 fully refined < 1.5 s |
| [PRF-034](../product/09-performance-contract.md#prf-034--synthetic-lens-load) | §10 | `load:synthetic-lens` runs in CI and fails on PRF-010/PRF-011 regressions (T05 owns the harness) |
| [SRF-009](../product/04-surfaces.md#srf-009--lens-first-paint-and-refinement) | §4.6, §4.9, §7 | `load:synthetic-lens` (p95 targets as written in SRF-009; see §13 Q6) |
| [PRF-029](../product/09-performance-contract.md#prf-029--approach-pre-fetch) | §4.9, T07-019 | `replay:approach-prefetch`: a 300 ms dwell issues the coarse Lens plan; the dive paints coarse data in the first frame; prefetch hit rate ≥ 70 % |
| [INT-022](../product/03-interaction-model.md#int-022--pre-fetch-on-approach) | §4.9 | `replay:approach-prefetch` |
| [PRF-022](../product/09-performance-contract.md#prf-022--200-viewports-per-board) | §4.6 (visibility), T07-012 | `itest:planner-offscreen`: a 200-viewport board plan issues 0 physical queries for viewports beyond 1 viewport-height off-screen |
| [SRF-016](../product/04-surfaces.md#srf-016--lazy-collapsed-sections) | §4.6, T07-012 | `itest:planner-collapsed`: a collapsed section of 10 viewports issues no physical query |
| [SRF-017](../product/04-surfaces.md#srf-017--variables) | §4.1 (variable dependency index), T07-013 | `itest:planner-variables`: changing `$region` on a 30-viewport board where 5 use it re-plans exactly 5 |
| [PRF-025](../product/09-performance-contract.md#prf-025--local-first-analytics) | §4.5 (local placement), §4.12 (Postgres fallback pyramids) | `itest:planner-local-first` (Exact answerability issues no remote query; server refinement uses the same `LogicalQuery`); `itest:no-pulsusdb-writes` |
| [EST-043](../product/15-estate-navigation.md#est-043--fetch-plan-budgets-and-timing) | §4.1, §4.8 (Background and Prefetch budgets per level) | `itest:fetch-plan-levels` ([T12](T12-entity-catalogue.md) co-owns Table 15-6) |
| [SRF-044](../product/04-surfaces.md#srf-044--traceql-metrics-and-service-graph-slice) | §4.12 (R5, service-graph slice) | `itest:service-graph-slice`: a TraceQL metrics query and its service-graph slice plan to one `traceql_metrics_range` and one `service_graph` call |
| [SRF-041](../product/04-surfaces.md#srf-041--selection-vs-baseline-compare) | §4.12 (R6; TraceQL `compare()` native) | `itest:compare-native-and-r6` |
| [SRF-034](../product/04-surfaces.md#srf-034--patterns-as-the-default-for-large-results) | §4.12 (R9 pattern diff, NEW verification) | `itest:pattern-diff-verify` |
| [ALR-085](../product/07-alerting.md#alr-085--history-queryable-as-telemetry) | §4.11, T07-020, T07-021, T07-022 | `itest:vsrc-alerts-per-team`: `sum by (team) (count_over_time(ALERTS{alertstate="firing"}[1w]))` over a seeded week matches the transition table; `{source="pulsus-dash", kind="alert_transition"}` rows match; the PulsusDB query log shows neither |
| [ALR-086](../product/07-alerting.md#alr-086--prometheus-compatible-read-api-for-history) | §4.11 (pure-virtual evaluation reused by T06 §4.13) | `itest:prom-read-alerts` (T06 co-owns) |
| [ENT-006](../product/11-enterprise.md#ent-006--scoped-users-see-no-out-of-scope-data) | §4.7, §4.11 (scope on virtual sources), T07-014, T07-016, T07-023 | `prop:scope-every-physical`: every physical query in the golden-plan corpus, including planner-generated ones, carries a `ScopeProof`; `itest:scope-paths` (T10 (draft) co-owns) |
| [ENT-007](../product/11-enterprise.md#ent-007--metrics-scopes-on-labels-fail-closed-per-family-o1-pending) | §4.7, T07-015 (O1 pending, ADR-0013 option B) | `itest:scope-family-fail-closed`: scope `k8s.namespace.name=payments`; a family with `k8s_namespace_name` returns payments series only; a family without it returns none and `Completeness.withheld` names it with the collector fix |
| [ENT-009](../product/11-enterprise.md#ent-009--out-of-scope-entities-in-the-atlas) | §4.7 (`filter_response` for native ops) | `itest:scope-native-anonymise` (T10 (draft) co-owns policy) |
| [AI-047](../product/06-ai-copilot.md#ai-047--budgets-and-caps) | §4.8, T07-018 | `prop:agent-budget`: simulated agent loops never exceed 300 cost-s, 200 physical queries or 4 concurrent |
| [AI-051](../product/06-ai-copilot.md#ai-051--coverage-aware-primitives) | §4.12, T07-024 | `itest:coverage-labels` (agent evidence carries the approximation) |

## 4. Design

### 4.1 Pipeline

```
 browser (scene state, cameras)                              BFF dash-planner
 ─────────────────────────────                              ──────────────────────────────────────────────────────────
 ScenePlanRequest{gen, viewports, context, hints} ─WS──►  1a Classify  source, signal, selectors and floors from the substituted text (§4.3)
                                                          1b Resolve   step from range, px, pass and floor; level prediction, grid alignment (§4.3)
 Replan{viewport deltas}  (≤ 1 per frame, coalesced)       2 Bind       templates/{{entity}}/$vars → concrete queries (catalogue);
 Cancel{viewport|plan}                                                   language module Plan with the resolved step → planned text
 ApproachHint{entity, level, dist, dwell}                  3 Lower      planned text → LogicalQuery (v1: OpaqueQuery, exact-text hash
                                                                         of the planned text, §0; classify PulsusDB | Virtual | Mixed, §4.11)
 Pressure{level}                                           4 Merge      session-local dedupe, range-union, derivation, fusion (§4.4)
                                                           5 Place⚡     local answerability per logical query (§4.5)
                                                           6 Physicalise→ PhysicalQuery[] + VirtualQuery[] + Combine DAG (§4.11, §4.12)
                                                           7 Scope      v1: identity / refuse restricted (§0); later T10 scope::rewrite (§4.7)
                                                           8 Place▣     cache tiles by scoped key; singleflight (§4.5)
                                                           9 Admit      budget check, priority, deadline (§4.8)
                                                          10 Execute    pulsusdb-client | dash-vsrc, streams → Combine → frames (JSON, Arrow from the engine)
 ◄── frames{plan, viewport, pass, gen, exactness} ─────────11 Stream     per pass; Completeness trailer per viewport
```

- **Classify** (1a) runs first. It is a cheap classification of the source and the signal, which
  yields the signal's capabilities (`SignalCaps`) and every virtual-source floor (15 s for `ALERTS`
  and `ALERTS_FOR_STATE`, 300 s for `pulsus_anomaly_score`; §4.3). It runs on the query after the
  language module's variable substitution, with the step-dependent macros (`$__interval`,
  `$__rate_interval`) left as placeholder durations. Macros never change selectors, so the step is
  not needed to classify and there is no circularity; selectors that a variable value introduces are
  seen. It reads the metric names and selectors from that text with the same upstream parser that
  `prom.Plan` uses (ADR-0021), and finds every reserved or virtual selector and its floor. A text the
  parser rejects is classified as a PulsusDB query; the `VirtualGuardLayer` byte match still applies
  (T07-020). In v1 nothing resolves to a virtual source (§0), so Classify yields the signal's
  capabilities alone.
- **Resolve** (1b) computes the step from the viewport's range, width and pass and the floor from
  Classify (§4.3; the §0 table: step, level and alignment do not depend on the text). The step is
  therefore final before any text is planned. Exactness that depends on the query's functions (from
  the parser design) is attached at Lower.
- **Bind** reads the scene's `Context` (entity set, window, filters, baseline; IA-002) and the
  Board's variable values. It then calls the language module's `Plan` (ADR-0021) with the final step
  from Resolve, which substitutes `$vars` and macros (`$__interval`, `$__rate_interval`) and applies the
  rate rewrites and the rate window. **Lower** builds the `LogicalQuery` from the planned text, and
  `LogicalKey` hashes those bytes. Bind keeps a **dependency index** `(context member | $var) →
  Vec<ViewportId>`, so a change re-binds only the viewports that read it (T07-013).
- The baseline (comparison ghost, A/B) is bound as a second `TimeRange` on the `LogicalQuery`
  (`baseline: Some(..)`), which physicalises to a shifted query with the same step grid.

#### T07-001 — Planning is pure and fast
**MUST** — Steps 1–9 MUST be pure and synchronous over immutable snapshots (catalogue, rollup table,
cache index, variable values). Steps 1–8 MUST complete in ≤ 2 ms p99 for a 200-viewport Board, and an
incremental replan of one viewport in ≤ 0.2 ms, so a full replan per camera change is affordable.

### 4.2 Normalisation and identity

**v1:** every query is an `OpaqueQuery` keyed on its exact text bytes (§0); no normalisation of any
kind, so whitespace and comments keep their meaning. **From the parser design**, a parsed query is
printed canonically (matchers sorted, whitespace and duration literals canonical (`1m0s`→`1m`),
redundant parentheses removed, comments dropped by the parser) and
`LogicalKey = xxh3_128(signal, canonical_text, shape)`.

#### T07-002 — Opaque text is sent unchanged and fails closed
**MUST** — *(Revised 1.5-rc, ADR-0021.)* Query text the planner holds only in planned form MUST be
sent to PulsusDB byte-for-byte as `Plan` returned it, keyed on those bytes, with no fusion, no
virtual-source resolution and no rewrite beyond ADR-0021's list. Because its scope cannot be proven, it MUST be refused with
`scope_denied` unless the principal's scope is unrestricted. *(2026-11-21, #65.)* The log volume
template of §0 embeds the text as its single operand, byte for byte; it is composition around the
text, not a rewrite of it, and the reserved-name guard runs on the user's text first.

### 4.3 Resolution: step from pixel width, and rollup level selection

**PulsusDB picks the rollup level from the range `end − start`, not from the step** (api.md §3.6).
With the default `PULSUS_ROLLUP_LEVELS=60,720,7200,86400` and
`PULSUS_ROLLUP_RANGES=10800,57600,604800,7776000`:

| Range | Level read | Planner consequence |
|---|---|---|
| < 3 h | raw | step ≥ the scrape interval (from catalogue, default 15 s) |
| 3 h – < 16 h | 60 s | step is a multiple of 60 s; a finer step only repeats bucket values |
| 16 h – < 7 d | 720 s | step is a multiple of 720 s |
| 7 d – < 90 d | 7200 s | step is a multiple of 7200 s |
| ≥ 90 d | 86400 s | step is a multiple of 86400 s |

PulsusDB documents that when `start` and `step` are whole buckets of the level, each point is
evaluated at its own time. Otherwise points take their bucket's value. Range functions are rounded up
to whole buckets, with at least 5 buckets for `rate`/`increase` below 12 minutes.

`resolve` is pipeline step 1b. Its `sig` comes from step 1a (Classify), which reads the substituted
text with macro placeholders (§4.1): `sig.source` is the source it found (`PulsusDb`, `Virtual` or
`Mixed`), and `sig.min_step` is the largest of every operand's `min_step` and every virtual floor
it found (below).
Step 2 (Bind) passes the resulting `step` to the language module's `Plan`. Resolution depends on the
source that Classify found:

- **PulsusDB source:** predict the rollup level from the range (table above), then
  `step = max(rollup-derived step, sig.min_step)`.
- **Virtual source:** no rollup prediction at all; a virtual source has no rollup level.
  `step = max(base step from range, width and pass, virtual floor)`.
- **Mixed expression** (one logical query with PulsusDB and virtual operands, §4.11.2): the whole
  logical query has one shared step, `step = max(PulsusDB rollup-derived step, every operand's
  min_step, every virtual floor)`. Join operands always share that step.
- **Mixed scenes:** each logical query resolves its own step from its own source. A PulsusDB
  viewport and a virtual viewport in the same scene can therefore get different steps for the same
  window.

So:

```rust
pub fn resolve(range: TimeRange, px: u32, pass: Pass, sig: &SignalCaps, roll: &RollupTable) -> Resolved {
    let px_per_point = match pass { Pass::Coarse => 4.0, _ => 1.0 };        // PRF-027: coarse ≈ width/4
    let raw_step     = range.len() / (px as f64 / px_per_point);            // CSS px, not device px
    let level        = match sig.source {                                   // from step 1a (Classify)
        Source::Virtual  => None,                                           // virtual sources have no rollup level
        Source::PulsusDb | Source::Mixed => roll.predict(range.len()),      // table above; None = raw (the PulsusDB operands' level)
    };
    let floor        = level.map_or(sig.min_step, |l| l.width.max(sig.min_step)); // sig.min_step: max of operand floors and virtual floors
    let step         = NICE.ceil_multiple_of(raw_step.max(floor), floor);   // ladder below, multiple of floor
    let step         = step.max(range.len() / sig.max_intervals);           // 11 000 PromQL/LogQL, 10 000 TraceQL metrics
    let start        = range.start.floor_to(step);                          // grid alignment: PulsusDB read cache + our tiles
    let end          = range.end.ceil_to(step);
    let exactness    = match sig.source {
        Source::Virtual  => Exactness::RawExact,                            // with source: Virtual{table} (§4.11.2)
        Source::PulsusDb | Source::Mixed => predict_exactness(level, &expr_fns), // v1: predict_exactness(level), §0; Mixed: weakest operand (§4.11.3)
    };
    Resolved { start, end, step, level, exactness }
}
// NICE = 1s 2s 5s 10s 15s 30s 1m 2m 5m 10m 12m 15m 30m 1h 2h 3h 6h 12h 1d 2d 7d
```

Examples (1 600 CSS-px viewport, fine pass):

| Window | px step | Level | Step chosen | Points |
|---|---|---|---|---|
| 1 h | 2.25 s | raw | 15 s (scrape) | 240 |
| 6 h | 13.5 s | 60 s | 60 s | 360 |
| 2 d | 108 s | 720 s | 12 m | 240 |
| 30 d | 27 min | 7200 s | 2 h | 360 |
| 6 h, `pulsus_anomaly_score` (virtual) | 13.5 s | none (a PulsusDB query would read 60 s) | 5 m (virtual floor 300 s) | 72 |

The last row is the case where the rollup width a PulsusDB query would get (60 s at 6 h) is below
the virtual floor (300 s). The virtual source skips rollup prediction, so the 60 s width never
applies: the step is `max(13.5 s, 300 s)` = 300 s, already on the `NICE` ladder (5 m).

**Mixed worked case** (6 h, 1 600 CSS px, fine pass):
`sum by (service) (rate(http_requests_total[$__rate_interval])) and on(service) pulsus_anomaly_score{signal="latency"} > 0.8`.
Classify finds a PulsusDB operand (scrape floor 15 s) and a `pulsus_anomaly_score` operand (virtual
floor 300 s), so `sig.source` is `Mixed` and `sig.min_step` = 300 s. The PulsusDB operand's
predicted level is 60 s. The step is `max(13.5 s, 60 s, 15 s, 300 s)` = 300 s, applied to both
operands (72 points); 300 s is a whole multiple of the 60 s level, so the PulsusDB operand stays on
its grid. `Plan` receives 300 s, so `$__rate_interval` is planned from that step.

**Exactness of virtual and mixed results.** `resolve` returns `RawExact` for a virtual source, and
the result carries `Completeness{exactness: RawExact, source: Virtual{table}}` (§4.11.2). For a
mixed join, the weakest-operand rule (§4.11.3) applies unchanged: in the case above, the join is
`Predicted{60 s}` from its PulsusDB operand.

For PRF-027's example (1 200 px, 1 h, coarse), `raw_step` = 12 s, raised to the 15 s scrape floor:
within the ±1 level tolerance of the acceptance.

#### T07-003 — Step from pixels, aligned to the level grid
**MUST** — The coarse pass (P2) MUST use a step of about range / (CSS px / 4) and the fine pass (P3)
about range / CSS px, each raised to the larger of the predicted level width and the signal floor
(a virtual source has no level and uses its virtual floor alone), rounded up to
the `NICE` ladder as a multiple of that floor, and raised further to respect the signal's interval
cap. `start` MUST be floored and `end` ceiled to the step.

**Level-split refine.** At 2 d, the level caps the chart at 240 points across 1 600 px. When the
viewport is **focused** and budget allows, the fine pass splits the range into chunks that each fall
under the next switch point (for 2 d: 4 × 12 h, each read at 60 s with a 2 m step, 1 440 points). It
then concatenates them (`Combine::ConcatTime`). This costs ~4× the reads, is charged to the budget,
and is never used for prefetch. The same trick with chunks under 3 h reads raw, which is how a zoomed
6 h window reaches raw resolution. The explain view labels it "split ×4 → 60 s". It relies on the
documented range→level rule; drift is caught by explain sampling ([T06](T06-bff-architecture.md)
§4.9).

#### T07-004 — Level-split is focused-only
**MUST** — Level-split MUST be used only for the focused viewport, only in P3, only when more than
50 % of the principal's interactive budget remains, and never for prefetch, agents or alert
evaluation.

**Exactness prediction.** *(v1, §0: `RawExact` if the level is `None`, otherwise `Rollup{level}` predicted from the range alone; the function check below applies from the parser design.)* `RawExact` if the level is `None`. `Rollup{level}` if a selector's
function is in PulsusDB's rollup-eligible list (`rate`, `increase`, `*_over_time`
min/max/sum/avg/last, instant selector…). `RawExact` (read raw) otherwise.

#### T07-005 — Predicted exactness is labelled as predicted
**MUST** — A predicted exactness MUST be reported as `Predicted{level}` in the Completeness block
until a PulsusDB explain or R10 confirms it; it MUST NOT be shown as ✓ exact.

**Per-signal resolution.**
- **LogQL metric** queries use the same formula, with floor 5 s (the 5 s log rollup).
- **`patterns`** has a floor of 10 s (PulsusDB floors to the 10 s bucket).
- **TraceQL metrics** has no documented rollup. The floor is 1 s and PulsusDB snaps the window
  outward to step multiples, so aligned requests are exact.
- **Profiles** `select_series` uses floor 10 s, and `merge` windows are capped at 24 h (PulsusDB's
  `PULSUS_PROFILES_MAX_QUERY_LENGTH`).
- **Heatmaps** choose a y-bucket count of `px_h / 4`.
- **Scatter** asks `max_points = px_w × px_h / 8` (cap 10⁷, PRF-017).
- **Virtual sources** (§4.11): floor 15 s for `ALERTS`/`ALERTS_FOR_STATE` (the minimum evaluation
  interval), 300 s for `pulsus_anomaly_score` (its stored resolution); no rollup level. Step 1a
  (Classify) sets the floor, so Resolve (1b) applies it before `Plan` runs; Lower's full
  classification (§4.11.2) follows.

### 4.4 Dedupe and merge across viewports

Four mechanisms are applied in order, each recorded in the plan:

1. **Identity.** The same `PhysKey` (scoped query text: exact bytes in v1, canonical from the parser design; step, aligned range, level) is one
   physical query with N subscribers.
2. **Range union.** For the same query and step with overlapping or adjacent ranges, one fetch covers
   the union when `len(union) ≤ 1.25 × Σ len(parts)`. Typical cases are split views, the ±1 window
   prefetch and the baseline ghost when it overlaps the window.
3. **Display derivation.** When viewport B needs the same query at a coarser step than A, and A's
   range covers B's, B subscribes to A's data. The GPU decimates it (min/max per pixel column,
   [T02](T02-vis-engine.md)), so a Lens sparkline costs nothing extra.
4. **Template fusion** *(from the parser design, §0)*. Lens templates mark repeated tiles as `foreach(label)`, for example the pod
   small-multiples strip. N bindings `f(sel{pod="a"})…f(sel{pod="z"})` become one grouped query
   `f(sel{service="checkout"}) by (pod)`, split client-side by label (`Combine::SplitBy`). Caps:
   PromQL `limit=` set to bindings + 10 %; LogQL metric results above 500 series are an error in
   PulsusDB, so fusion splits into groups of ≤ 400; TraceQL `by()` is capped at 1 000 series, so
   fusion splits into groups of ≤ 800.

#### T07-006 — Fusion is declared, never inferred
**MUST** (from the parser design, §0) — Template fusion MUST be applied only where the template author declared `fusable_by`
(T11 schema). The planner MUST NOT infer grouping or common sub-expressions from arbitrary PromQL,
because the rewrite is not semantics-preserving in general (`topk`, `absent`, binary-op matching).

#### T07-007 — Merges never lose coverage
**MUST** — Range union MUST only be applied when `len(union) ≤ 1.25 × Σ len(parts)`, and display
derivation only when A's range covers B's and A has ≤ 8× B's point count. Every merge MUST be
recorded in the plan so the explain view can show it.

Across sessions, the identity dedupe is extended by T06's singleflight and the L1/L2 tiles. A NOC
wall of 50 viewers on one board issues each physical query once.

### 4.5 Placement: local, cache or remote

For each logical query, the placer asks in order:
1. **Local** (T13 (draft)): `LocalEngine::answerability(&LogicalQuery)` returns `Exact`,
   `Approx{coverage}` or `No`. Health, RED and USE over entities answer from pyramids. Re-facets and
   Compare answer over loaded chunks. When the answer is `Exact`, no remote query is issued.
2. **Tiles:** the browser reports the tile keys it holds in IndexedDB (a bloom filter in
   `ScenePlanRequest`, T04). The BFF checks L1/L2. Only missing tiles are physicalised, so a pan
   fetches one new tile, not the window. Held tiles are painted immediately as P0, hatched as stale
   until refreshed (PRF-026).
3. **Remote:** physicalise to PulsusDB, to a virtual source (§4.11), or to both with a BFF join;
   fallbacks in §4.12.

This is how "local first, show cached" ([09 §6](../product/09-performance-contract.md)) becomes
mechanical: the local and cached passes are placements that complete in < 16 ms.

#### T07-008 — Placement order
**MUST** — The placer MUST try local answerability, then held and server tiles, before issuing any
remote query, and MUST physicalise only the tiles that are missing.

### 4.6 Passes, progressive refinement and cancellation

```
 pass:   P0 cached ──► P1 local ⚡ ──► P2 coarse ☁ ──► P3 fine ✓/☁ ──► P4 flank (±1 window) ──► P5 approach
 prio:   —            —             Interactive      Refine           Prefetch                Prefetch
 skip if:              No           est(P3) < 80 ms   —                budget < 30 %           no hint
         or P3 tiles all cached
```

- Each frame carries `(plan_id, viewport_id, pass, generation, exactness)`. The browser paints a
  higher pass over a lower one with the crossfade ("sharpens, never jumps"; VL-015, no spinners) and
  drops frames whose `generation` is older than the viewport's current one.
- **Supersede.** Every viewport has a generation counter. A replan that changes a viewport's
  `PhysKey` set unsubscribes it from the old keys. A physical query with zero subscribers is
  cancelled ([T06](T06-bff-architecture.md) §4.3) unless (a) it is > 80 % delivered, in which case
  it finishes into the cache, or (b) it is within a **linger** window of 150 ms. Linger absorbs
  pan-back jitter at the end of an inertial flick ([03](../product/03-interaction-model.md),
  "interruptible instantly").
- **Debounce.** During continuous camera motion the browser sends at most one `Replan` per frame.
  The planner issues P3 for a viewport only after its x-domain has been stable for 120 ms. P2 and P1
  run immediately.
- **Flank.** After P3 completes for a time viewport, P4 fetches one window width either side at the
  P3 step (PRF-028), so `[`/`]` steps and one-window pans need no new request.
- **Off-screen** viewports (Boards) are planned with `Visibility::OffScreen{distance}`. At ≤ 1
  viewport-height away, P2 runs as prefetch; further away, nothing runs. Collapsed Board sections
  never query (SRF-016); their anomaly strip reads the local pyramid.

#### T07-009 — No stale paint
**MUST** — Every frame MUST carry the viewport generation it was planned for, and the browser MUST
drop any frame older than the viewport's current generation, so a stale response never paints over
fresh intent, even if a cancel races.

#### T07-010 — Supersede cancels
**MUST** — A physical query with zero subscribers MUST be cancelled within one frame of the replan
that orphaned it, unless it is > 80 % delivered (finish into the cache) or within the 150 ms linger
window.

#### T07-011 — Fine pass waits for stability
**MUST** — P3 MUST NOT be issued for a viewport until its x-domain has been stable for 120 ms; P1 and
P2 MUST NOT be delayed by this debounce.

#### T07-012 — Off-screen and collapsed viewports do not query
**MUST** — Viewports more than one viewport-height off-screen, and viewports in collapsed sections,
MUST NOT produce physical queries. Off-screen viewports within one viewport-height MAY run P2 at
Prefetch priority only.

#### T07-013 — Changes re-plan only dependents
**MUST** — A change to a Context member or a Board variable MUST re-bind only the viewports the
dependency index lists for it. Other viewports keep their generation and their data.

### 4.7 RBAC rewrite insertion point

*v1 (§0): the rewriter is the identity for unrestricted principals and refuses restricted ones; the
text rewrite below applies from the parser design.* The scope rewrite happens at **step 7: after physicalisation (step, window, fusion, fallback and
virtual-query generation are all decided) and before any cross-session cache key, singleflight or
dispatch**. This matches T10 (draft)'s contract: "rewrite after planning, before dispatch".
Rewriting the final *physical* text, rather than the logical query, means that queries the planner
itself generates (fusion `by (pod)`, the R6 `count by (k)` fan-out, the R9 verification query,
level-split chunks, the PulsusDB operand of a BFF join) pass the same gate as user text.

```rust
// T10 (draft) `pulsus-dash-scope`, wrapped by the T06 ScopeRewriter trait
let r: Rewritten = scope::rewrite(&phys.text, phys.signal, &cx.scope.matchers(phys.signal), &cx.scope.fields)?;
phys.text  = r.query;
phys.proof = ScopeProof { scope_fp: r.scope_fp, tenant_binding: cx.tenant.binding_id, rewriter_version };
completeness.withheld.extend(r.withheld);   // metric families failed closed (T07-015)
```

- Steps 1–6 run under one principal inside one session, so their dedupe is safe before the rewrite.
  Everything shared **across** sessions (L1/L2 tiles, singleflight) is keyed after it, on
  `(tenant_binding_id, scope_fp, scoped text hash, …)`. Cache sharing is then exactly as wide as
  scope sharing.
- Local answers (step 5) need no rewrite, because everything the browser holds was scope-filtered
  when it was served. Pyramid tiles are served per `scope_fp` (T13 (draft)).
- When [R12](pulsusdb-requirements.md) lands, the rewriter emits a header instead of rewritten text
  for signals PulsusDB covers. Keys still include `scope_fp`.

#### T07-014 — Every physical query is scope-rewritten
**MUST** — Every physical PulsusDB query and every virtual query MUST pass through
`ScopeRewriter::rewrite` at step 7 and carry a `ScopeProof`; `ScopeError` MUST fail the viewport
closed. No cache key or singleflight key MAY be computed before step 7.

**Metrics scopes (open decision O1).** PulsusDB does not promote resource attributes onto metric
series (§0.1 of the [PulsusDB requirements](pulsusdb-requirements.md), R16). Pending the product
owner's decision on [ADR-0013](../adr/0013-metrics-data-scopes.md), the planner follows **option B**:

1. For each metric family referenced by a physical PromQL query, the rewriter looks up the family's
   label set (L1 metadata, from `/api/v1/series?match[]={__name__="fam"}` with a 60 s TTL).
2. If every scope attribute is present as a label (under the tenant's label ⇄ attribute mapping,
   e.g. `k8s.namespace.name` → `k8s_namespace_name`), the scope matchers are injected into every
   selector of that family.
3. If any scope attribute is absent, every selector of that family is replaced by a **provably empty
   selector** (the scope label with an unsatisfiable matcher pair `L="v", L!="v"`), which keeps the
   expression valid and returns no series. The family is added to `Completeness.withheld` with the
   missing labels and the collector-side fix (OTel `resource_to_telemetry_conversion`, or a PulsusDB
   promotion list per R16), which the coverage meter shows (ENT-007).
4. A `target_info` join is never used for enforcement. It MAY be used for display only (e.g. entity
   derivation, [T12](T12-entity-catalogue.md)).

#### T07-015 — Metrics scopes fail closed per family (O1 pending)
**MUST** (from the parser design and M-UI6; in v1 restricted principals are refused, T07-002) — Until O1 is decided, the planner MUST enforce metrics data scopes on metric labels per
ADR-0013 option B: families carrying every scope label are filtered by the scope; families missing
any scope label MUST return no series to the scoped principal and MUST be reported in
`Completeness.withheld`. A `target_info` join MUST NOT be used to enforce a scope. If O1 is decided
otherwise, this rule is revised; T07-014 holds under every option.

#### T07-016 — Native operations are filtered on the way out
**MUST** — Native operations with no selector to rewrite (service graph, compare, inventory) MUST
have their results passed through `ScopeRewriter::filter_response`: edges and entities outside scope
are removed or anonymised per org policy ([15](../product/15-estate-navigation.md)), and totals are
adjusted or shown as "+N restricted".

### 4.8 Budgets (per user, per AI agent) and R14 fallback

Budget unit: **cost-seconds**, the estimated backend wall time (PulsusDB or Postgres). Estimates are
made before execution and calibrated afterwards.

**v1 estimate (no parse, §0):** `est = max(prior(signal, kind, level) × points, ewma(LogicalKey))`,
where `points = range / step`, `prior` is a per-(signal, kind, level) cost per point calibrated from
observed latencies, and `ewma` is the observed cost of the same exact-text key (absent on first
use). The selector-based heuristics in the table below apply from the parser design.

| Signal | Heuristic estimate (R14 fallback) | Inputs (all cheap, cached ≤ 60 s) |
|---|---|---|
| PromQL | Σ over selectors of `series(sel) × points_read × c_level` | `series` from `/api/v1/status/tsdb` `seriesCountByMetricName` (answered from PulsusDB's resident label cache, zero ClickHouse), scaled by matcher selectivity from cached label-value counts. `points_read = range / (level width or scrape)` |
| LogQL | `bytes(selector, window) / scan_rate` | `volume` (served from the 5 s rollup, zero body reads), cached per (stream selector, hour) |
| TraceQL | `span_rate(service) × window × selectivity / span_scan_rate` | Span rate from RED pyramids or service-graph `calls` |
| Profiles | `profiles(service) × window` | `select_series` totals at a coarse step |
| Virtual sources | `rows(table, window, matchers) / pg_scan_rate` + join cost `points(L) + points(R)` / `join_rate` | Partition row estimates (`pg_class.reltuples`) × index selectivity |

`c_level` and the scan rates are an EWMA of observed `latency / estimate` per (cluster, route,
level), which corrects the heuristics continuously. When R14 lands, `X-Pulsus-Explain: estimate`
replaces the estimate column for PromQL.

| Principal | Budget (defaults; per-tenant overrides in runtime settings) | On exhaustion |
|---|---|---|
| Human, interactive | Token bucket of 30 cost-s per 10 s, burst 60. Prefetch ≤ 15 % of it. Level-split only when > 50 % remains | The focused viewport always gets P2. Others degrade to coarse, then to cached only, with the coverage note "budget: coarse" |
| AI agent (per investigation) | 300 cost-s total, ≤ 200 physical queries, ≤ 4 concurrent, wall clock ≤ 90 s for stage 2 (PRF-014) | The tool call returns `budget_exhausted{remaining}`. The agent must rank its next queries. Cost is shown on the RCA card ([06](../product/06-ai-copilot.md)) |
| External agent (MCP token, T15 (draft) class `external_agent`) | Per token: 60 cost-s per minute, ≤ 2 concurrent | `budget_exhausted` + `429` on the MCP route |
| Alert evaluation ([T16](T16-alert-evaluator.md) class `alerting`) | Not budget-limited. Highest priority class after Interactive; capacity is sized by T16 sharding | The evaluator reports lag and never silently skips |
| Alert backtest ([T16](T16-alert-evaluator.md) class `backtest`) | Charged to the author's human budget at Refine priority | Coarser backtest step |
| Background jobs (`Budget::background(tenant)`: catalogue harvest [T12](T12-entity-catalogue.md), sweeps, fallback pyramid builder) | Per-tenant share of the Background class ([T06](T06-bff-architecture.md) §4.10) | Sweep cadence stretches, and stale age shows in the Atlas header |
| Tenant | Σ of the above ≤ the tenant quota | Fair-share across users (DRR) |

The agent caps are in physical queries and cost. T15 (draft) separately caps *tool calls* (40 per
auto-RCA). One tool call may expand into several physical queries, and whichever cap is reached first
applies.

#### T07-017 — Budgets are enforced before execution
**MUST** — Every physical and virtual query MUST be admitted against its principal's budget at step
9, using the estimate. A single query estimated at > 60 cost-s MUST be refused before execution with
a narrowing hint (a high-cardinality label to pin, or a shorter window), surfaced like a PulsusDB
`422`.

#### T07-018 — Agent caps
**MUST** — An AI-agent investigation MUST NOT exceed 300 cost-s, 200 physical queries or 4
concurrent queries; an external-agent token MUST NOT exceed 60 cost-s per minute or 2 concurrent
queries. Exhaustion MUST be returned to the caller as `budget_exhausted{remaining}`, never as a
silent truncation.

### 4.9 Prefetch on approach (semantic zoom)

The browser's camera controller emits `ApproachHint{entity, target_level, screen_px, dwell_ms,
velocity}` when an entity's projected size crosses 0.6 × the expansion threshold (~120 px,
[15](../product/15-estate-navigation.md)), or when the pointer dwells on it for > 300 ms
([03](../product/03-interaction-model.md), INT-022).

1. The planner resolves the target scene the dive would open: the entity's Lens template, the L2
   cluster grid or the L3 node packing ([15](../product/15-estate-navigation.md)).
2. It plans that scene at **P2 coarse only**, with the target's typical viewport sizes from the
   template, at Prefetch priority, into the cache, without streaming to the browser except for the
   header tiles that the morph animation needs (the node becomes the Lens header).
3. On dive, the real plan finds P2 already in L1 (or in flight, so it subscribes) and only P3 is new.
   That is how the Lens reaches "first coarse < 300 ms" (PRF-010) as the camera arrives.

#### T07-019 — Approach prefetch caps
**MUST** — A session MUST have at most 3 concurrent approach targets, ranked by `1/distance × dwell`.
A hint that recedes (velocity away, or the entity leaves the frustum) MUST cancel its queries after
the 150 ms linger. Approach prefetch MUST run at Prefetch priority, coarse only.

### 4.10 Plan explain view

The Inspector's "Query ▸" row ([03](../product/03-interaction-model.md)) and the workbench explain
action (SRF-028) open **Plan**, which is also the AI's "How I got here" source
([06](../product/06-ai-copilot.md)):

```
┌ Plan · Lens checkout · gen 14 · 23 viewports → 9 logical → 7 physical (3 cached) ── 412 ms · 6.1 cost-s ┐
│ ▾ p99 latency (vp 4)          ⚡ P1 local 3 ms → ☁ P2 coarse 88 ms → ✓ P3 fine 240 ms                  │
│    logical  histogram_quantile(0.99, sum by (le)(rate(http_server_duration_bucket{svc="checkout"}[5m]))) │
│    scope    + {k8s_namespace_name=~"payments|core"}   (team: payments, rewriter v3)                    │
│    resolve  6h @1600px → level 60s → step 60s · start aligned −00:00:40 · exactness: rollup (predicted)│
│    shared   with vp 1 (sparkline, display-derived), vp 9 (identity)                                    │
│    physical GET /api/v1/query_range … step=60 timeout=9.9                                              │
│             X-Pulsus-Query-Id 3f9c…e1 · read-cache hit (through 13:02:00) · 240 ms · 12 batches        │
│ ▸ pod strip ×24 (vp 10–33)    fused → sum by (k8s_pod_name) … · SplitBy · 1 physical                   │
│ ▸ span scatter (vp 6)         R2 fallback: heatmap + 3 stratified searches (sampled 1:14)              │
│ ▸ alerts per team (vp 7)      virtual: ALERTS (Postgres alert_transitions) · BFF eval · 18 ms          │
│ [Run PulsusDB explain] (re-executes with X-Pulsus-Explain: 1, bypasses read cache, 0.8 cost-s)          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The `PlanExplain` tree is produced from the `Plan` (§5.2) with no extra queries. "Run PulsusDB
explain" is on demand only, because explain requests bypass PulsusDB's read cache. It shows the
generated SQL, rows read, server time and the `rollup_route`/`rollup_piece` stages, and confirms or
corrects the predicted exactness. Virtual-source nodes show the Postgres table, the pushed-down
predicates and the BFF evaluation time.

### 4.11 Postgres-backed virtual sources

*From the parser design (§0; M-UI4). Classification, push-down, evaluation and joins all need a
parsed query. In v1 reserved names are refused by the byte match of §0.*

[ADR-0012](../adr/0012-derived-state-in-postgres.md) decision 3: the BFF exposes Dash-derived state
through the same query interface as telemetry. The planner owns the semantics; `dash-vsrc`
([T06](T06-bff-architecture.md) §4.12) executes them against the Postgres tables of
[T11](T11-postgres-schema.md) and [T16](T16-alert-evaluator.md).

#### 4.11.1 Reserved selectors

| Selector | Signal | Backing table (T11) | Series / stream shape |
|---|---|---|---|
| `ALERTS` | PromQL | `alert_transitions` (time-partitioned, 13 months) + `alert_instances` (current) | Labels `alertname`, `alertstate`, `severity`, `rule_uid`, flags `acked`/`silenced`/`in_maintenance` (`"true"`/`"false"`), plus the rule's labels. Value 1 at each step where the instance is in that state. `alertstate` ∈ `pending`, `firing`, `nodata`, `error`; Normal, Resolved and Paused produce no series (Prometheus semantics, extended with the Table 3.2 states of [07](../product/07-alerting.md)) |
| `ALERTS_FOR_STATE` | PromQL | same | Labels as `ALERTS` without `alertstate`; value = Unix seconds the instance became active (Pending entry), while Pending or Firing |
| `pulsus_anomaly_score` | PromQL | `anomaly_scores` (5-minute resolution, 30 days) | Labels `entity_ref`, `entity_type`, `signal`, plus entity identity labels from the catalogue; value = score |
| `{source="pulsus-dash"}` | LogQL | `alert_transitions`, `notification_attempts`, `entity_change_events` | Stream labels `source`, `kind` (`alert_transition`, `notification_attempt`; `change_event` from M-UI3 with [T12](T12-entity-catalogue.md)), `alertname`, `severity`, `entity_ref`; line = the row as JSON; structured fields for every column |

#### T07-020 — Reserved selectors resolve to Postgres, never to PulsusDB
**MUST** — *(v1: the refusal of §0 applies and nothing resolves to Postgres.)* From the parser design, at step 3 (Lower) the planner MUST classify every selector whose metric name equals `ALERTS`,
`ALERTS_FOR_STATE` or `pulsus_anomaly_score`, and every LogQL stream selector with the equality
matcher `source="pulsus-dash"`, as virtual. A query containing a virtual selector MUST NOT be sent to
PulsusDB; `pulsusdb-client`'s `VirtualGuardLayer` refuses any request text that still contains one.
Reserved names shadow any PulsusDB series of the same name for Dash users (documented limit; §13 Q7).
Only exact-name selection is virtual: a `__name__` regex or a `source=~` matcher is not resolved
against Postgres and never matches virtual series.

#### 4.11.2 Classification and evaluation

Step 3 (Lower) classifies each `LogicalQuery`:

| Class | Example | Execution |
|---|---|---|
| **PulsusDB** | `rate(http_requests_total[5m])` | Normal path |
| **Virtual** | `sum by (team) (count_over_time(ALERTS{alertstate="firing"}[1w]))` | Entirely in `dash-vsrc` |
| **Mixed** | `sum by (service) (rate(http_requests_total{code=~"5.."}[5m])) and on(service) ALERTS{alertstate="firing"}` | PulsusDB operand physicalised normally; virtual operand in `dash-vsrc`; join in the BFF (§4.11.3) |

Virtual evaluation:
1. **Push-down.** `dash-vsrc` generates SQL against the partitioned tables under RLS: the time window
   (partition pruning, widened by the largest range-vector duration and the 5-minute lookback),
   equality matchers on indexed columns (`alertname`, `alertstate`, `severity`, `rule_uid`,
   `entity_ref`, `kind`), and equality label matchers on `labels jsonb` with `@>`. Regex matchers are
   evaluated in the BFF with `pulsus-re2` (the same RE2 semantics as PulsusDB).
2. **Materialise.** Rows become Arrow state intervals `(series_id, from, to, value)`, which
   `pulsus-colexec` samples on the step grid to series (Prometheus staleness semantics: a series ends
   at its last interval).
3. **Evaluate.** The PromQL or LogQL expression above the selectors is evaluated by `pulsus-colexec`
   over those series, using the lowering in `dash-vsrc` (one Go implementation, shared with the BFF
   join kernel).
4. **Stream.** Results leave as Arrow frames with `Completeness{exactness: RawExact, source:
   Virtual{table}}`, through the same Combine, cache (T06-013 virtual horizon) and frame path.

**Supported subset over virtual series** (anything else returns `virtual_unsupported{construct}`,
shown in the viewport and in the editor diagnostics):

| Area | Supported |
|---|---|
| PromQL range functions | `rate`, `irate`, `increase`, `delta`, `changes`, `resets`, `count_over_time`, `sum_over_time`, `avg_over_time`, `min_over_time`, `max_over_time`, `last_over_time`, `present_over_time`, `absent_over_time` |
| PromQL aggregations | `sum`, `avg`, `min`, `max`, `count`, `count_values`, `topk`, `bottomk`, `group`, with `by`/`without` |
| PromQL other | instant-vector functions (`abs`, `clamp*`, `ceil`, `floor`, `round`, `label_replace`, `label_join`, `absent`, `timestamp`, `time`, `vector`, `scalar`), arithmetic, comparison (incl. `bool`) and set operators, `offset`, `@` |
| Not supported in v1 | subqueries, `histogram_quantile` and native histograms, `predict_linear`, `holt_winters`, `quantile_over_time`, `stddev*` |
| LogQL | stream selector, line filters (`|=`, `!=`, `|~`, `!~`), label filters, `| json`, `| line_format`; metric queries `count_over_time`, `rate`, `bytes_over_time`, with `sum`/`count`/`topk` by labels |

#### T07-021 — Virtual PromQL is evaluated in the BFF with a documented subset
**MUST** (from the parser design, §0) — PromQL and LogQL over virtual selectors MUST be evaluated in the BFF by `dash-vsrc` and
`pulsus-colexec`, covering at least the supported subset above. A construct outside the subset MUST
return `virtual_unsupported{construct}`; it MUST NOT be approximated silently or forwarded to
PulsusDB.

#### 4.11.3 Binary-op joins with PulsusDB series

ADR-0012 allows virtual sources in PromQL "only as whole-selector operands joined in the BFF". The
planner splits the AST at the **mixed spine**: the set of nodes whose subtree contains both virtual
and PulsusDB selectors.

- Every maximal **pure** subtree below the spine is an operand. PulsusDB operands are physicalised
  as ordinary queries (same step, aligned `start`/`end`, scope-rewritten at step 7, cached and
  deduplicated like any other); virtual operands are evaluated as above.
- Spine nodes are evaluated in the BFF by `Combine::Kernel(binop)` per step, with Prometheus vector
  matching (`on`, `ignoring`, `group_left`, `group_right`), arithmetic, comparison (`bool`) and set
  operators (`and`, `or`, `unless`), and also aggregations and instant-vector functions applied above
  a join.
- **Not allowed on the spine:** range-vector functions and subqueries whose argument contains a mixed
  node (they would need a range of a joined result). These return
  `virtual_unsupported{mixed_range}` with the hint "move the range function inside each operand".

**Join limits** (per-tenant overridable downwards only):

| Limit | Default | On breach |
|---|---|---|
| Series per operand | 10 000 | `too_broad` with the operand's top cardinality label as hint |
| Result series | 10 000 | `too_broad` |
| Points per join (Σ operand points) | 5 × 10⁶ | Step coarsened ×2 (coverage "join: coarsened"), then `too_broad` |
| Many-to-many match | — | Error, as Prometheus ("many-to-many matching not allowed") |
| Mixed spine depth | 8 nodes | `virtual_unsupported{depth}` |
| Join compute | charged to the budget (§4.8) | As any budget exhaustion |

The join's exactness is the weakest of its operands (a rollup or predicted PulsusDB operand makes the
result `Rollup`/`Predicted`), so the coverage meter stays honest.

#### T07-022 — BFF joins are bounded and honest
**MUST** (from the parser design, §0) — A mixed expression MUST be split at the mixed spine; operands MUST be whole pure subtrees;
spine nodes MUST be evaluated in the BFF with Prometheus vector-matching semantics within the join
limits above. A range function or subquery over a mixed node MUST be refused. The result's
exactness MUST be the weakest of its operands.

Outside PromQL, virtual sources mix into scenes the ordinary way: a viewport bound to
`{source="pulsus-dash", kind="alert_transition"}` and a viewport bound to a PulsusDB log query share
the scene, the Context, the cursor and the compare tools, because both return the same Arrow shapes
through the same planner (ALR-085).

#### T07-023 — Virtual sources honour tenancy and scope
**MUST** — Virtual queries MUST run under Postgres RLS for the request's tenant and MUST additionally
apply the principal's data scope: scope matchers on labels become SQL predicates on the rule labels
and entity identity columns, and rows whose entity is out of scope are removed. Derived state is
"data" for ENT-006 and MUST NOT leak out-of-scope alert names, labels or counts.

### 4.12 PulsusDB fallbacks (concrete plans)

*From M-UI2. Each operation below composes query text from structured inputs Dash holds (catalogue,
Context, template fields, PulsusDB responses), never by parsing user text (§0). Where `<sel>` or
`{sel}` stands for a selector, it is that structured selector; an operation started from an arbitrary
user query needs the parser design.*

#### T07-024 — Approximations are labelled
**MUST** — Whenever a fallback in this section is used, the planner MUST set
`Completeness.approximation` (and `exactness` where applicable) to name it, so the coverage meter and
agent evidence state it (VIZ-027, AI-051). A fallback MUST NOT be presented as exact.

**R2: span scatter** (until `/api/traces/v1/points` exists). `LogicalOp::SpanPoints` becomes:
1. **Density (P2):** `GET /api/traces/v1/metrics/query_range?q={<filter>} | histogram_over_time(duration)&step=<px step>`.
   This returns power-of-two duration buckets (api.md §4.4.1) and is drawn as a heatmap. It is exact
   for counts. Its coverage is labelled "density: log₂ buckets".
2. **Points (P3), stratified:** using the bucket counts from step 1, issue K ≤ 4 searches over
   duration bands, from the slowest band down:
   `GET /api/traces/v1/search?q={<filter> && duration >= <lo> && duration < <hi>} | select(span:duration, status, resource.service.name)&start&end&limit=<n_k>&spss=100`.
   `n_k` is proportional to the band's count, and the **top band is always fetched in full** up to
   20 000 traces, so outliers survive. `limit` ≤ 262 144 and `spss` ≤ 100 are PulsusDB's caps. The
   search's own ordering decides which traces are kept within a band. Combine is `StratifiedUnion`,
   and each point carries a weight `count_band / fetched_band`. Coverage reads "sampled 1:14,
   outliers complete".
3. **Brush (Lens/Traces workbench):** a brushed region re-issues step 2 restricted to that region's
   time and duration bounds. In the storyboard ([13](../product/13-core-flow-storyboard.md)) this is
   what makes the 2.0 s line crisp.

**R4: entity health pyramids** (until PulsusDB serves span-derived RED rollups or a supported rule
pack). `LogicalOp::Health` is placed in this order:
1. **PulsusDB rollups** when the recording-rule pack is registered and the PulsusDB ruler is enabled
   (R4 fallback (a) in the [PulsusDB requirements](pulsusdb-requirements.md)): ordinary PromQL over
   the recorded series at the rollup levels.
2. **Postgres fallback tiles** otherwise ("self-ruler"): the worker's fallback pyramid builder
   ([T06](T06-bff-architecture.md) §4.6) evaluates the same rule pack with ordinary PulsusDB reads at
   Background priority and stores the results as **compressed Arrow tiles** in Postgres
   (`pyramid_tiles`: one row per entity × signal × level × tile, zstd Arrow IPC `bytea`, 7-day default
   retention; ADR-0012 decision 4). The planner reads tiles by key from Postgres (through
   `dash-vsrc`, scope-filtered per `scope_fp`), serves them on `/api/dash/v1/pyramids/…`, and the
   browser engine (T13 (draft)) answers locally.
3. **Regenerate on demand:** a tile that is missing or beyond retention is planned as a coarse
   PulsusDB query at Refine priority for display now, and enqueued for the builder, which writes it
   back to Postgres. Coverage reads "health: computed by Dash".

#### T07-025 — Fallback pyramids are Postgres tiles
**MUST** — When PulsusDB cannot serve health rollups, pyramid tiles MUST be stored in and read from
Postgres as compressed Arrow tiles keyed by entity × signal × level × tile, with retention enforced
by partition drop (default 7 days), and regenerated on demand. They MUST NOT be written to PulsusDB.

**R5: service graph over time and at scale.** Under assumption **A1** (PulsusDB raises the
`service_graph` edge cap to ≥ 50 000; [design README](../README.md#3-assumptions)), the Atlas edge set
is one call.
- **Over time:** `ServiceGraph{step}` becomes N calls
  `GET /api/traces/v1/service_graph?start=t_i&end=t_i+step`, with `step` ≥ 1 m and aligned to whole
  minutes (PulsusDB stores per-minute edge totals). Caps are N ≤ 60 per plan (wider requests coarsen
  the step), with parallelism 6 at Prefetch/Refine priority. Combine is `WindowSeries` into per-edge
  Arrow series of calls, failed, p50/p95/p99. Each call counts only calls whose two halves start
  inside the window, so edges undercount slightly at window boundaries; exactness is labelled
  "windowed". Windows older than the finalisation horizon (end of their 5-minute interval + 3 min + 1
  min run cadence) are cached as immutable tiles, so replaying the same incident twice costs nothing.
  If the collector's service-graph connector metrics exist as PromQL series (detected by the
  catalogue), the planner prefers one `query_range` over them.
- **Degradation path (A1 false or cap reached):** when a `service_graph` response is `truncated`,
  the planner switches that scene to the **partitioned fallback**: edges are derived from TraceQL
  metrics grouped by client and server service
  (`{ kind = client } | rate() by (resource.service.name, span.peer.service)` and the server-side
  equivalent), partitioned by service set so each `by()` stays under the 1 000-series cap, at
  Refine priority, and the coverage meter shows "edges: truncated at N, partitioned (approximate)".
  The edge-count coverage meter shows the truncation until the full set is assembled.

#### T07-026 — Service-graph truncation is never silent
**MUST** — The planner MUST plan the service graph as a single call under A1, and MUST switch to the
partitioned TraceQL-metrics fallback when a response is `truncated`, labelling the result as
truncated or approximate until the partitioned edge set is complete.

**R6: Compare for logs and metric labels.** Traces use TraceQL `compare()` natively (SRF-041). Logs:
1. Candidate keys: `detected_labels` and `detected_fields` over the selection window, keeping keys
   with cardinality 2–500, ≤ 20 keys.
2. For each key k and side ∈ {S, B}, an instant query:
   `sum by (k) (count_over_time({sel} <| parser if field> <| selection filter for S> [W_side]))` at
   `time=end_side`. That is 2 × 20 = 40 queries, parallel 8, Refine priority.
3. Totals: `sum(count_over_time({sel}[W_side]))`, two queries.
4. `Combine::Kernel(compare)` runs the same divergence kernel as the browser (T13 (draft)), and
   outputs Different, Unchanged and Coverage.

Metrics: for each label k, `count by (k) (last_over_time(<sel>[W_S]))` and the same over `W_B`. If
the selection is a condition (for example "series above threshold"), S becomes
`count by (k) (max_over_time(<sel>[W_S]) > <T>)`. Each query has `limit` so the PromQL series cap
truncates honestly. Coverage lists keys excluded by the cardinality cap.

**R9: pattern diff.** `PatternDiff{selector, a, b}` becomes two
`GET /api/logs/v1/patterns?query=<selector>&start&end&step=<same>` calls with an identical step
(≥ 10 s), diffed by `(pattern, level)`, with counts normalised by window length: NEW, GONE, ↑↓ (ratio
≥ 2 and |Δ| ≥ 20 lines). PulsusDB keeps the top 1 000 per call, so a "NEW" pattern may only have
dropped out of B's top 1 000. For the top 10 NEW candidates the planner verifies with
`sum(count_over_time({sel} |= "<longest literal fragment of the template>" [W_B]))`. A non-zero count
downgrades the pattern to ↑. Coverage reads "top 1 000 patterns per window; 10 NEW verified".

**R13: batch.** Until `POST /api/v1/batch` exists, a plan's physical queries for one cluster are
issued concurrently over the pooled connections (HTTP/2 multiplexed where negotiated,
[T06](T06-bff-architecture.md) §4.3). They share one deadline and a priority, and are tagged with
their `PhysKey`, which the frames carry as the stream id. When R13 lands, queries with the same
`(start, end)` and kind are grouped into batch bodies of ≤ 50 entries. The browser-facing protocol is
unchanged.

**R14: estimates.** §4.8.

R3/R7/R8 fallbacks belong to the catalogue and change feed ([T12](T12-entity-catalogue.md)).

### 4.13 Degradation, LIVE mode and memory pressure

| Trigger | Planner behaviour |
|---|---|
| `Overloaded{class}` from T06 §4.10 | Drop P4/P5, skip P3, step ×2; coverage "server busy: coarse view" |
| Budget exhausted | Coarse, then cached only; the focused viewport is protected |
| `422` too broad | Retry once at coarse ×4 if it is a resolution problem, otherwise surface it with the hint |
| `Pressure{level}` from the browser (T01/T04 memory monitor) | Re-plan affected viewports at the next coarser rollup level, drop P4/P5 and held raw chunks are released by the browser; source badge reflects the rollup |
| LIVE (`L`) | Each viewport's head tile is re-planned every `max(step, 1 s)` as a delta query `[last_ts, now]`; immutable tiles are untouched; a hidden tab (`document.visibilityState`) suspends live refresh |

#### T07-027 — Truncation and too-broad answers are surfaced
**MUST** — A PulsusDB `truncated` flag, a `422` or a planner refusal MUST reach the viewport as a
Completeness flag or error with a machine-readable narrowing hint. The planner MUST NOT drop such a
result silently or replace it with partial data presented as complete.

#### T07-028 — LIVE refreshes only the head
**MUST** — In LIVE mode the planner MUST refresh only the head tile of each visible time viewport by
delta, at most every `max(step, 1 s)`, and MUST suspend live refresh for hidden tabs.

#### T07-029 — Memory pressure degrades to rollups
**MUST** — On `Pressure{level}` the planner MUST re-plan the affected viewports to rollup data within
one plan cycle and MUST NOT issue P4/P5 for them until pressure clears.

### 4.14 Expressions across queries (workbench A, B, …)

The Metrics workbench supports queries A, B, … and expressions over them, such as `A / B`
(SRF-030). An expression viewport binds `Binding::Expression{refs: [A, B], expr}`. Each referenced
query is planned normally (shared with its own viewport by identity dedupe), and the expression is a
`Combine::Kernel(expr)` node evaluated in the BFF with the same kernel as §4.11.3, on the common step
grid (the coarser of the referenced steps). Expressions that PulsusDB can evaluate as one PromQL
query are not rewritten into one: keeping A and B separate lets their viewports and the expression
share fetches.

**v1 form (no BFF parse, §0).** The client expands the expression into one PromQL query by replacing
each reference token (`A`, `B`, …, the only tokens it recognises) with `"(" + text + "\n)"`: the
referenced query's exact text, then a newline, then the closing parenthesis. The newline ends any
`#` line comment at the end of the operand, so the generated `)` and the rest of the expression are
never commented out. The viewport is bound as an ordinary `Binding::Query`. The BFF plans it as an opaque
query, so `A / B` beside A and B costs three physical queries; PulsusDB evaluates the expression and
reports its errors. The `Combine::Kernel` form above and T07-030 apply from the parser design.

Test: `unit:expr-expand-line-comment` (client, Vitest): with A = `up # note` and B = `up`, `A / B`
expands to `(up # note` + newline + `) / (up` + newline + `)`; against `pulsus-fake` it returns
the same series as `up / up`, and an operand without a comment expands with the same newline.

#### T07-030 — Expressions reuse operand fetches
**MUST** (from the parser design, §0; v1 uses the expanded form above) — An expression over workbench queries MUST be evaluated from its operands' results on a
common step grid, without issuing additional physical queries for the operands, and MUST apply the
join limits of §4.11.3.

## 5. Interfaces

### 5.1 Browser ⇄ planner messages (logical; T04 frames them)

```rust
pub enum ClientMsg {
    Plan    { plan_gen: u64, scene: SceneRef, context: Context, vars: VarMap, viewports: Vec<ViewportSpec>, held_tiles: Bloom },
    Replan  { plan_gen: u64, upserts: Vec<ViewportSpec>, removes: Vec<ViewportId>, context: Option<Context>, vars: Option<VarMap> },
    Cancel  { target: CancelTarget /* Viewport(id) | Plan(gen) | All */ },
    Approach(ApproachHint),
    Pressure { level: PressureLevel /* Moderate | Critical */, viewports: Vec<ViewportId> },
    Live    { on: bool },
    Visibility { hidden: bool },
    Explain { viewport: ViewportId, run_pulsusdb: bool },
}
pub struct ViewportSpec {
    pub id: ViewportId, pub gen: u32,
    pub binding: Binding,                 // Query{lang,text} | Template{tpl, entity} | Native(NativeOp) | Expression{refs, expr}
    pub need: DataNeed,                   // Series | Heatmap{y} | Points{max} | Table{rows} | Flame{nodes} | Patterns | Graph | Health
    pub px: PixelExtent,                  // css w,h + dpr
    pub x: TimeDomain,                    // absolute ms; A/B and baseline via Context
    pub visibility: Visibility,           // OnScreen | OffScreen{distance_vh: f32} | Collapsed
    pub focus: bool,
}
pub enum ServerMsg { Frame{/* T04 */}, Completeness{viewport, pass, c: Completeness}, Budget{remaining, class}, Explain(PlanExplain), Error{viewport, e} }
```

### 5.2 Planner IR (authoritative; shared with T13, T15 and T16)

**v1 IR (no parse, §0).** Everything the v1 planner holds about a query:

```rust
pub enum QueryLang { PromQL, LogQL, TraceQL }
pub enum QueryKind { Range, Instant, LogStreams, LogVolume }      // TraceQL kinds from M-UI2
pub struct OpaqueQuery { pub lang: QueryLang, pub kind: QueryKind, pub text: String } // exact bytes, never parsed
pub struct LogicalQuery {                             // v1
    pub key: LogicalKey,                               // xxh3_128(signal, lang, kind, text bytes, shape)
    pub signal: Signal, pub class: SourceClass,        // class is always PulsusDb in v1
    pub op: LogicalOp, pub range: TimeRange, pub baseline: Option<TimeRange>,
    pub resolution: Resolution, pub shape: ResultShape, pub purpose: Purpose,
}
pub enum LogicalOp { Text(OpaqueQuery) }              // v1: the only variant
// PhysicalQuery and Plan as below; Combine is Identity | ConcatTime in v1; no VirtualQuery
```

**Parsed IR (from the parser design, §0).** The variants carrying parsed expressions
(`promql::Expr`, `logql::Expr`, `traceql::Expr`, `logql::Selector`, `Selector`), `VirtualQuery`,
`Combine::Kernel` and `Local` exist only once the parser design is accepted; `Text(OpaqueQuery)`
stays for text the planner does not hold in parsed form (T07-002).

```rust
pub struct LogicalQuery {
    pub key: LogicalKey, pub signal: Signal,          // Metrics | Logs | Traces | Profiles | Entities | Dash
    pub class: SourceClass,                            // PulsusDb | Virtual | Mixed (§4.11.2)
    pub op: LogicalOp, pub range: TimeRange, pub baseline: Option<TimeRange>,
    pub resolution: Resolution,                        // Auto{px} | Step(ms) | Points(n)
    pub shape: ResultShape,                            // Series | Matrix2D | Points | Table | Flame | Edges | Distribution
    pub purpose: Purpose,                              // Display | Compare | Alert | Agent | Prefetch
}
pub enum LogicalOp {
    PromQL(promql::Expr), LogQL(logql::Expr), TraceQL(traceql::Expr), Profile(ProfileSelect),
    ServiceGraph { step: Option<Duration> },                          // R5
    SpanPoints { filter: traceql::Expr, fields: Vec<Attr>, max: u32 },// R2
    Compare { signal: Signal, selector: Selector, selection: Selection, baseline: Selection, dims: DimSpec }, // R6 / TraceQL compare()
    PatternDiff { selector: logql::Selector, a: TimeRange, b: TimeRange },                                    // R9
    Health { pyramid: PyramidId, entities: EntityFilter, metrics: Vec<HealthMetric> },                       // R4 / T13
    Expression { refs: Vec<LogicalKey>, expr: promql::Expr },                                                 // §4.14
    Local(colexec::Plan),                                             // runs only in T13 engine
}
pub struct PhysicalQuery {
    pub key: PhysKey, pub route: Route, pub params: SmallVec<[(Cow<'static, str>, String); 8]>,
    pub level: Option<RollupLevel>, pub exactness: Exactness, pub est: CostEstimate,
    pub pass: Pass, pub priority: Priority, pub deadline: Instant, pub proof: ScopeProof,
    pub serves: SmallVec<[LogicalKey; 4]>,
}
pub struct VirtualQuery {                             // executed by dash-vsrc (T06 §4.12)
    pub key: PhysKey, pub source: VirtualSourceId,    // Alerts | AlertsForState | AnomalyScore | DashEvents | PyramidTiles
    pub pushdown: SqlPredicates, pub residual: colexec::Plan,
    pub step: Option<Duration>, pub range: TimeRange, pub est: CostEstimate, pub proof: ScopeProof,
}
pub enum Combine { Identity, ConcatTime(Vec<PhysKey>), SplitBy(Label), Diff{a: PhysKey, b: PhysKey},
                   StratifiedUnion(Vec<PhysKey>), WindowSeries(Vec<PhysKey>), Kernel(colexec::Plan) }
pub struct Plan { pub id: PlanId, pub gen: u64, pub logical: Vec<LogicalQuery>, pub physical: Vec<PhysicalQuery>,
                  pub virtual_: Vec<VirtualQuery>, pub dag: Vec<(LogicalKey, Combine)>,
                  pub bindings: HashMap<ViewportId, Vec<LogicalKey>> }
```

### 5.3 Cross-doc interfaces

| Interface | Direction | Contract |
|---|---|---|
| Planner IR (§5.2: v1 IR now, parsed IR from the parser design) | **Defined here** | T13 executes `LogicalQuery` locally. T15 agent tools submit `LogicalQuery` with `Purpose::Agent`. T16 uses `Purpose::Alert` (no passes, no budgets beyond the evaluator's) |
| `ClientMsg`/`ServerMsg` (§5.1) | Defined here, framed by T04 | T04 adds stream ids, resume, compression |
| `ScopeRewriter` (wraps T10 `scope::rewrite` / `filter_response`) | Defined in T06, implemented by T10 (draft) | Runs at step 7 on every physical and virtual query; keys use `scope_fp`; returns `withheld` families (T07-015) |
| `VirtualSource` / `dash-vsrc` | Trait in T06; semantics here (§4.11) | Tables `alert_transitions`, `alert_instances`, `notification_attempts`, `anomaly_scores`, `entity_change_events`, `pyramid_tiles` defined by T11/T16 |
| `LocalEngine::answerability` | Defined by T13 (draft) | Pure, ≤ 0.1 ms |
| Templates with `foreach(label)` fusion | **Assumed from T11/T12** | The Lens template schema carries `fusable_by` |
| Catalogue snapshot (scrape interval, cardinalities, Lens resolution, label ⇄ attribute map) | Assumed from [T12](T12-entity-catalogue.md) | Read-only snapshot, ≤ 5 ms resolve |
| Camera approach hints, memory pressure | Assumed from [T02](T02-vis-engine.md)/[T03](T03-browser-runtime.md) camera controller and T01 memory monitor | `ApproachHint` at most every 100 ms per entity |
| `VisHint` | From [T09](T09-query-editors.md) | Planner confirms or overrides on result shape (series count > 50 → band) |

## 6. Data & storage

The planner itself is stateless apart from per-session plan state (in memory on the api replica that
holds the WS session). It reads:

| Data | Where |
|---|---|
| Rollup table, interval caps | `runtimeinfo` + `rollup_ranges_s` config (T06 §4.9) |
| Catalogue snapshot, label ⇄ attribute map | [T12](T12-entity-catalogue.md) snapshot (Redis/Postgres) |
| Cost EWMA calibration | In memory per replica; persisted hourly to runtime settings for warm start |
| Virtual sources | Postgres (§4.11.1), via `dash-vsrc` |
| Fallback pyramid tiles | Postgres `pyramid_tiles` (§4.12) |
| Result tiles | T06 caches |

## 7. Performance budget

| Item | Budget | Tie | Measured |
|---|---|---|---|
| Plan steps 1–8 for a 200-viewport Board | ≤ 2 ms p99 (incremental replan of 1 viewport ≤ 0.2 ms) | PRF-005, PRF-022 | `bench:planner-plan` (criterion), span `planner.plan` |
| `Replan` round trip (WS in → first P1/P2 frame out, cached) | ≤ 20 ms | PRF-006 | RUM + span |
| Lens first coarse | ≤ 300 ms (P2 for a typical service); ≤ 50 ms with an approach-prefetch hit | PRF-010 | `load:synthetic-lens` |
| Lens fully refined | ≤ 1.5 s (P3) | PRF-011 | same |
| Cancel → PulsusDB stream reset | ≤ 1 frame after `Cancel` arrives | PRF-030 | span events; `itest:planner-cancel` |
| Physical queries per Lens (16 tiles) | ≤ 8 after fusion and derivation | — | `dash_planner_physical_total / plans` |
| Virtual query (1 week `ALERTS`, ≤ 1 000 series) | p95 ≤ 150 ms incl. evaluation | ALR-085 | `bench:vsrc-alerts-week` |
| BFF join (2 × 1 000 series × 1 000 steps) | ≤ 40 ms | ALR-085 | `bench:bff-join` |

## 8. Security, tenancy & RBAC

The rewrite insertion point is §4.7 (T07-014). Opaque queries (in v1, every query) are refused for
scoped principals (T07-002). Metrics scopes fail closed per family pending O1 (T07-015). Virtual sources run
under RLS plus scope predicates (T07-023). AI agents plan as the user, with `Purpose::Agent`, under
their own budget, and every physical query appears in the investigation's tool-call log with its
`X-Pulsus-Query-Id`. Budgets and singleflight are keyed per tenant ([T06](T06-bff-architecture.md)
§4.7).

## 9. Failure modes & degradation

| Condition | Planner behaviour | User sees |
|---|---|---|
| PulsusDB `422` too broad | §4.13 | "Too broad" with a narrowing chip |
| Budget exhausted | Coarse, then cached only. The focused viewport is protected | Coverage "budget: coarse" |
| Overload (`Overloaded{class}`) | Drop P4/P5, skip P3, step ×2 | "Server busy: coarse view" |
| Fallback in use (R2/R4/R5/R6/R9) | Normal | Coverage line names the approximation (sampled, windowed, partitioned, top-1000, computed by Dash) |
| Rollup prediction mismatch | Label switches to the confirmed exactness on the next explain sample. Metric raised | Badge corrects itself |
| Template binding fails (entity gone) | That viewport only | NoData with "entity last seen 12:03" ([15](../product/15-estate-navigation.md) ephemeral) |
| Postgres unreachable | Virtual and mixed viewports fail; PulsusDB-only viewports unaffected | "Alert history unavailable" on the affected viewports |
| Virtual construct unsupported | That viewport only | `virtual_unsupported` with the construct named |
| Metric family withheld by scope | Selector replaced by an empty one | Coverage meter names the family and the collector fix |

## 10. Testing

- **Property tests** (`prop:planner-resolve`): `resolve()` never exceeds interval caps, always
  aligns start to step, the step is always a multiple of the predicted level width, and P2 ≈ width/4.
  Union and derivation never lose coverage (`prop:planner-merge`).
- **Golden plans:** recorded scenes (Lens, 80-viewport Board, Atlas L0→L2 dive, alert-history Board)
  → snapshot of `PlanExplain`, diffed in CI (`golden:plan-explain`).
- **Differential:** fusion output equals the unfused per-binding results on seeded PulsusDB.
  Level-split concatenation equals single-request results within PulsusDB's documented rollup
  distances. Virtual PromQL equals Prometheus evaluation of the same expression over the same
  samples exported as a TSDB block (`diff:vsrc-promql`); BFF joins equal PulsusDB evaluation when the
  virtual operand is replaced by an equivalent ingested series in a test-only tenant
  (`diff:bff-join`).
- **Never sent:** the ALR-085 acceptance run asserts the PulsusDB query log contains no reserved
  selector (`itest:vsrc-alerts-per-team`), and a fuzzer over mixed expressions asserts
  `dash_virtual_leak_total` stays 0.
- **Replay:** deterministic camera recordings ([T01](T01-frontend-architecture.md)) check the cancel
  counts, the "no stale paint" invariant (generation checks) and the prefetch hit rate (target ≥ 70 %
  of dives) (`replay:no-stale-paint`, `replay:approach-prefetch`).
- **Budget:** simulated agent loops cannot exceed their caps; starvation tests run across tenants
  (`prop:agent-budget`, `sim:tenant-fairness`).
- **Load:** `load:synthetic-lens` (PRF-034), owned by T05.

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI1 | **First:** a per-viewport subset (T07-003 step, T07-010 cancel, T07-012 off-screen) over HTTP `/query` ([T04](T04-wire-format-and-data-plane.md) §5.2), for metrics and the LogQL stream and volume plan kinds (`logql_streams`, `log_volume`). **Then:** the WS scene session (§5.1), merge, passes and budgets. Metrics; steps 1–4 and 6–11; identity/union/derivation; P0/P2/P3/P4; cancellation; human budgets; plan explain; multi-query expressions in the v1 form (§4.14); all query text opaque (§0); LIVE head refresh; memory-pressure replan |
| M-UI2 | Traces/profiles; remaining logs plan kinds (patterns, detected fields, tail); R2/R9; the parser design (§0) and then fusion; approach prefetch (PRF-029) |
| M-UI3 | Local placement (T13); R5 windowed + partitioned fallback; R6; level-split; R4 Postgres fallback pyramids |
| M-UI4 | Virtual sources and BFF joins (ALR-085); agent budgets; explain in "How I got here" |
| M-UI5 | Board variables dependency index (SRF-017); 200-viewport boards (PRF-022) |
| M-UI6 | Scope enforcement on all signals (ENT-006/ENT-007, after O1) |

R13/R14 paths are flag-gated per cluster as PulsusDB ships them.

## 12. Alternatives considered

| Option | Why not |
|---|---|
| Per-viewport queries planned in the browser | Loses cross-session singleflight and server-side scope rewriting, and doubles the work when the BFF must re-plan anyway |
| Fixed step = range / 250 (a common query-UI default) | Wastes rollup levels (finer than bucket) or under-resolves wide viewports, and misses grid alignment |
| General PromQL CSE and grouping inference | Not semantics-preserving in general (`topk`, `absent`, binary-op matching). Template-declared fusion gets most of the win safely |
| Sending explain on every query for exact labels | Bypasses PulsusDB's read cache, so performance would be worse |
| Writing derived series into PulsusDB so PulsusDB evaluates them (ADR-0010) | Rejected by D2 / ADR-0012 |
| Reusing `pulsus-promql`'s evaluator over a Postgres storage adapter for virtual sources | Attractive for parity (licence-compatible under D3), but couples Dash to PulsusDB's internal storage traits; revisit if its storage API becomes public (§13 Q8) |
| `target_info` join to enforce metrics scopes | Not safe for enforcement (ADR-0013 option C) |

## 13. Open questions

1. Can PulsusDB expose `PULSUS_ROLLUP_RANGES` in `runtimeinfo`, so Dash need not mirror it? (Small ask, in R10.)
2. Is level-split acceptable to PulsusDB engineering? It circumvents the range-based level choice, which is partly a cost guard.
3. Does the TraceQL search ordering contract give a usable "slowest first" within a duration band (R2 step 2)?
4. Fusion caps vs `reader.traceql_max_series` (1 000) for TraceQL `by()`, for example per-operation strips.
5. Should approach prefetch be learned (per-user dive likelihood) rather than distance and dwell only?
6. PRF-010/PRF-011 gate at p75 while SRF-009 states p95 for the same Lens targets; the gate runs both percentiles until the product spec reconciles them.
7. Reserved names shadow PulsusDB series named `ALERTS` (e.g. from Prometheus remote-write). Is an escape hatch needed (a per-tenant prefix for the virtual names)?
8. Virtual PromQL: own `pulsus-colexec` lowering (chosen) vs `pulsus-promql`'s evaluator behind an adapter.
9. O1: if the product owner picks an option other than B, §4.7 and T07-015 are revised.
10. `S` per binding (scrape interval) for the rate window: from the catalogue or runtimeinfo.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; rules T07-001…T07-030. **D2 / ADR-0012:** added Postgres-backed virtual sources (§4.11: `ALERTS`, `ALERTS_FOR_STATE`, `pulsus_anomaly_score`, `{source="pulsus-dash"}`), BFF evaluation subset, mixed-spine binary-op joins with limits, `VirtualQuery` IR and `SourceClass`; R4 fallback pyramids stored as Postgres Arrow tiles (§4.12). **A1:** service graph planned as one call; partitioned TraceQL-metrics fallback kept as the degradation path on `truncated`. **O1:** metrics scopes follow ADR-0013 option B pending decision (T07-015). Added flank pass P4 wording for PRF-028, LIVE head refresh, memory-pressure replan, Board variable dependency index, multi-query expressions (SRF-030), `Pressure`/`Live`/`Visibility` client messages |
| 1.0-rc | 2026-11-19 | Roadmap D5 ([12](../product/12-roadmap.md#21-delivery-order-2026-11-19) §2.1): §11 M-UI1 starts with a per-viewport subset over HTTP `/query`; the WS scene session, merge, passes and budgets follow later in M-UI1; LogQL stream and volume plan kinds move to M-UI1 |
| 1.1-rc | 2026-11-19 | [ADR-0015](../adr/0015-go-bff.md), [ADR-0014](../adr/0014-typescript-react-web-client.md): new §0; the planner is Go (`internal/planner`); the shared `pulsus-plan` IR is dropped in favour of Go types plus a JSON form and fixtures for T13; §4.2 parses PromQL with a Go PromQL parser and treats LogQL and TraceQL as opaque in v1 (T07-002) |
| 1.2-rc | 2026-11-19 | ADR-0015 "Query validation": the BFF parses no query language in v1. §0 gains the v1 opaque-planning table and the later parser design (decided before fusion in M-UI2; a server-side parser needs a new ADR); §4.2 no longer uses a Go PromQL parser; §4.14 v1 expression form (client-expanded text) with T07-030 deferred to the parser design; SRF-030 test and §11 updated |
| 1.3-rc | 2026-11-19 | Code review r2 of #56: §0 v1 table made complete (no parse, lex or rewrite anywhere in v1; exact-text `LogicalKey` with `unit:planner-opaque-key`; v1 `ScopeRewriter`; byte-match reserved-name refusal; native operations built from structured inputs); T07-002 revised so it does not depend on parsing; §5.2 gains the v1 IR (`OpaqueQuery`, `LogicalOp::Text`) and marks the parsed IR as the later parser design; §4.2, §4.3, §4.4, §4.7, §4.8 (v1 estimate), §4.11, §4.12, T07-006, T07-015, T07-020 to T07-022 marked accordingly |
| 1.4-rc | 2026-11-19 | Code review r3 of #56: §4.14 v1 expansion puts a newline before each generated closing parenthesis so an operand ending in a `#` comment cannot comment out the rest; test `unit:expr-expand-line-comment`; SRF-030 row updated; review r8: §4.1 pipeline steps 7 and 10 state v1 scope handling and JSON frames until the engine |
| 1.5-rc | 2026-11-21 | [ADR-0021](../adr/0021-query-planning-is-server-side.md): PromQL is parsed in `internal/pulsusdb/prom` for the planning shape only (§0 table); v1 queries are opaque except for ADR-0021's closed list of planning rewrites, and `LogicalKey` hashes the planned text; new §0 row "Planning rewrites"; §4.1 Bind substitutes through the language module's `Plan`; T07-002 revised; open question 10 |
| 1.5-rc | 2026-11-21 | Design review r1 of the ADR-0021 PR: §4.1 pipeline runs Resolve before Bind, so `Plan` gets the width-dependent step, and Lower keys the planned text (classification is now step 3); `unit:planner-opaque-key` compares the upstream query with the planned text |
| 1.5-rc | 2026-11-21 | Design review r2 of the ADR-0021 PR: §4.1 step 1 splits into 1a Classify (source and signal from the binding and the source kind: `SignalCaps` and the virtual-source floor, 15 s alerts, 300 s anomaly scores) and 1b Resolve (step from range, width, pass and that floor), so Bind calls `Plan` with the final step; §4.3 `resolve` and the virtual-source floor reference the stages |
| 1.5-rc | 2026-11-21 | Design review r3 of the ADR-0021 PR: §4.3 `resolve` branches on the source from Classify: a PulsusDB source predicts the rollup level and takes `max(level width, sig.min_step)`; a virtual source skips rollup prediction and takes `max(base step, virtual floor)`, with `Exactness::Virtual`; in a mixed scene each logical query resolves its own step; worked case 6 h anomaly score gives 300 s, not 60 s; T07-003 wording aligned |
| 1.5-rc | 2026-11-21 | Design review r4 of the ADR-0021 PR: §4.1 Classify runs on the substituted text with step-dependent macros as placeholder durations, reading selectors with the upstream parser to find every reserved selector and floor; §4.3 a mixed expression has one shared step (max of the PulsusDB rollup-derived step, every operand's `min_step` and every virtual floor), with a worked case (anomaly score joined with a rate, 300 s for both operands); `Exactness::Virtual` removed: a virtual source resolves to `RawExact` with `source: Virtual{table}`, and the weakest-operand rule applies to mixed joins |
| 1.6-rc | 2026-11-21 | #62: §0 v1 reserved-name refusal also screens the completion inputs (`match[]`, `metric`) |
| 1.7-rc | 2026-11-21 | #65 Part A: §0 v1 table row "Log volume (#65)" (byte-for-byte embedding in a fixed template, newline before the suffix, positions mapped back); T07-002 note |
