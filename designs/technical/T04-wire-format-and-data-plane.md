# T04 — Wire format & data plane

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.2-rc · 2026-11-21 |
| **Milestone** | M-UI0 (metric matrix, framing, cancel, R1 harness) → M-UI1 (heatmap, IndexedDB, priorities, events) → M-UI2 (all signals) → M-UI3 (pyramids, compare, change feed) |
| **Related ADRs** | [ADR-0005](../adr/0005-arrow-wire-format.md), [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md) (supersede ADR-0001), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T04-wire-format-and-data-plane.md (not tracked) |

## 0. Applicability under ADR-0014 and ADR-0015 (2026-11-19)

The browser application is TypeScript and the BFF is Go; the Rust/WASM chart engine arrives with
#68 ([ADR-0014](../adr/0014-typescript-react-web-client.md) §5, [ADR-0015](../adr/0015-go-bff.md)).

| Topic | Until the engine (#68) | From the engine on |
|---|---|---|
| Results to the browser | **JSON frames** (`application/json`), one schema per result type in `api/openapi.yaml`, carrying the same fields, `key_hash` and coverage block as the §4.3 schemas; decoded in TS at one seam, `client/src/data/decode.ts` | Arrow IPC in DSF frames (§4.3–§5.4) for engine-rendered frames, streamed to the engine worker without main-thread parsing; JSON for config, CRUD and DOM-only results |
| Schemas | §4.3 is authoritative; the machine-readable copy is `wire/schemas/*.yaml` (field names, Arrow types, metadata keys) with golden IPC fixtures in `wire/fixtures/` | The Go writer reproduces the fixtures and the Rust engine decodes them (`unit:codec-roundtrip`, both sides) |
| BFF conversion (§5.6) | Go: streaming `encoding/json` token decoder; `strconv` for value strings; protobuf via `google.golang.org/protobuf` | Plus Arrow Go (`arrow-go`) builders and IPC writer with 64-byte alignment |
| `dash-keyhash` | Go in the BFF, writing `key_hash` into JSON frames | Also Rust in the engine and `pulsus-synth`; one fixture corpus fixes the hash of sorted canonical label sets |
| `QueryRequest` (§5.2) | Built by the TS client from the OpenAPI types, parsed by the Go BFF | Same |
| Browser byte path (§4.1, §5.7), T04-015 | Not applicable: `fetch` + JSON decode in TS | Stand, through the engine adapter (the successor of `shim/net.js`, [T03](T03-browser-runtime.md) §0) |
| IndexedDB chunk cache (§6.1) | Implemented in TS; caches JSON frames; T04-017 and T04-018 stand | Caches Arrow chunks |
| R1 harness (§10) | — | `crates/dash-bench-wire` in the engine workspace, driven by Playwright through the engine adapter |

## 1. Context & problem

[ADR-0005](../adr/0005-arrow-wire-format.md) chose Arrow IPC from the BFF to the browser. Until
PulsusDB emits a columnar format natively (R1 in [pulsusdb-requirements](pulsusdb-requirements.md)),
the BFF converts PulsusDB's JSON: in M-UI1 into **JSON frames** for the TS client, and from the
chart engine on (#68) into Arrow (§0). PulsusDB today answers range queries in PromQL-compatible JSON
(the standard query-API response shape) for metrics and its native logs JSON,
with sample values as **strings** and log timestamps as nanosecond **strings** (PulsusDB API §2.1,
§3.2). Trace fetch is OTLP JSON or protobuf by `Accept` (§4.1). Profiles are Connect JSON or proto
(§5). The current upstream API reference documents no Arrow output.

The product specification needs:
- 10⁸ line points and 10⁷ scatter points client-side ([PRF-016](../product/09-performance-contract.md#prf-016--10⁸-line-chart-points), [PRF-017](../product/09-performance-contract.md#prf-017--10⁷-scatter-points)), in < 1.5 GB
  ([PRF-023](../product/09-performance-contract.md#prf-023--memory-budget));
- no interaction waiting on the network ([PRF-006](../product/09-performance-contract.md#prf-006--no-interaction-waits-on-the-network));
- cached data first, then coarse, refine and prefetch, with aggressive cancellation and truncation
  honesty ([09 §6](../product/09-performance-contract.md#6-progressive-data-strategy));
- coarse data on screen in < 300 ms and fully refined in < 1.5 s (PRF-010, PRF-011, from M-UI2);
- a coverage meter on every viewport ([VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport)) and visible data trust ([AUD-041](../product/01a-audiences-and-perspectives.md#aud-041--show-data-trust)).

Under decision D2 ([ADR-0012](../adr/0012-derived-state-in-postgres.md)), Dash-derived state (alert
history and state, baselines, anomaly scores, derived change events, fallback pyramids) lives in
PostgreSQL and is served through the same query interface as telemetry. The data plane must carry
both kinds of result in one format, and must never write to PulsusDB.

This document is **authoritative** for:
- the Arrow schemas for every result type;
- the DSF frame envelope;
- the BFF → browser protocol, request ids, priorities and cancellation;
- the coverage block;
- the IndexedDB cache format;
- the R1 benchmark harness and the decision procedure.

Query *semantics* (what to ask, at which step, and the virtual-source resolution) belong to
[T07](T07-scene-query-planner.md). The BFF service that implements the conversion belongs to
[T06](T06-bff-architecture.md).

## 2. Goals / non-goals

**Goals**
- One columnar format end to end in the browser. Every result type decodes with `arrow-ipc` zero-copy
  into the chunk arena ([T03 §4.3](T03-browser-runtime.md#43-shared-memory-layout-and-ownership)).
- Streaming. The first record batch paints before the response ends.
- Every request is cancellable, and cancellation reaches PulsusDB (R11).
- Every answer carries a uniform coverage block, filled from whatever PulsusDB reports today (R10
  fallback).
- Meet the R1 acceptance in WASM: 1 000 series × 10 000 points decoded in **< 50 ms** on reference
  (a).
- Postgres-backed derived results (D2) arrive in the same schemas as telemetry.

**Non-goals**
- Config/CRUD APIs. These stay JSON ([ADR-0005](../adr/0005-arrow-wire-format.md)) and are owned by
  [T06](T06-bff-architecture.md) and [T11](T11-postgres-schema.md).
- Planning, deduplication and step choice ([T07](T07-scene-query-planner.md)).
- Pyramid construction and local query execution (T13 (draft)). This doc only fixes their wire
  layout.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [PRF-006](../product/09-performance-contract.md#prf-006--no-interaction-waits-on-the-network) | §4.1, §4.4, §6.1 (co-satisfied with T01, T03) | `bench:offline-interaction` |
| [SRF-033](../product/04-surfaces.md#srf-033--log-volume-histogram) | §5.2 (`log_volume` → `metric_matrix.grid`, §4.3); brush → Context time co-satisfied with T02 | `itest:pulsusdb-contract` (volume conversion); `replay:context-propagation` (brush on the volume sets Context time) |
| [PRF-016](../product/09-performance-contract.md#prf-016--10⁸-line-chart-points) | §4.2, §5.7 | `bench:frame-line-1e8`; `bench:decode-r1` |
| [PRF-017](../product/09-performance-contract.md#prf-017--10⁷-scatter-points) | §4.3 (`span_points/1`), §5.7 | `bench:frame-scatter-1e7` |
| [PRF-023](../product/09-performance-contract.md#prf-023--memory-budget) | §5.7 | `bench:memory-heaviest` |
| [PRF-024](../product/09-performance-contract.md#prf-024--graceful-degradation-under-memory-pressure) | §5.7, §9 | `bench:memory-pressure` (rollup within 1 s, badge changes) |
| [PRF-026](../product/09-performance-contract.md#prf-026--show-cached-marked-stale) | §6.1 | `replay:progressive` (cached data hatched in the first frame; hatching cleared on fresh paint) |
| [PRF-027](../product/09-performance-contract.md#prf-027--coarse-first) | §4.4 (rank 0 part; co-satisfied with T07) | `replay:progressive` (first query step ≈ width/4; painted before refine) |
| [PRF-028](../product/09-performance-contract.md#prf-028--refine-and-pre-fetch-neighbours) | §4.4, §6.1 (co-satisfied with T07) | `replay:progressive` (pan by one window issues no query) |
| [PRF-030](../product/09-performance-contract.md#prf-030--cancel-superseded-requests) | §5.4 | `replay:cancel-storm` (10 changes in 1 s → 9 cancelled, last painted) |
| [PRF-031](../product/09-performance-contract.md#prf-031--truncation-honesty) | §5.1 (`error/1`), §5.3 | `replay:truncation` |
| [VIZ-005](../product/05-visualisation-catalogue.md#viz-005--lod-never-hides-signal-silently) | §5.3 (co-satisfied with T02) | `replay:truncation` |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) | §5.3 | `replay:truncation` ("truncated" + narrow; "100 %" when complete) |
| [AUD-041](../product/01a-audiences-and-perspectives.md#aud-041--show-data-trust) | §4.2 (null = gap), §5.3 (data age, partial badge) | `golden:gallery` (gap page); `replay:truncation` |
| [IA-001](../product/02-information-architecture.md#ia-001--object-vocabulary-and-persistence) | §4.6 | `e2e:no-pulsusdb-write` |
| [VL-002](../product/08-visual-language.md#vl-002--neutral-series-palette-with-stable-identity-colours) | §4.2 (`key_hash`; co-satisfied with T02) | `unit:colour-hash` |
| [VL-015](../product/08-visual-language.md#vl-015--no-spinners-on-data) | §4.4 (co-satisfied with T02) | `replay:progressive` |
| [INT-028](../product/03-interaction-model.md#int-028--live-mode) | §5.5 (`live_metric`, `tail`; co-satisfied with T02) | `replay:live-scroll` |
| [INT-031](../product/03-interaction-model.md#int-031--events-on-the-time-axis) | §4.3 (`events/1`; co-satisfied with T02) | `replay:events-markers` |

## 4. Design

### 4.1 Data path overview

*The browser half below is the engine path (from #68, §0); until then JSON frames go to `fetch` and
the TS decoder.*

```
 PulsusDB ──JSON / OTLP-proto / Connect-proto──► BFF (T06) ◄── Postgres virtual sources (D2):
                                                  │              ALERTS, ALERTS_FOR_STATE,
                                                  │              pulsus_anomaly_score,
                                                  │              {source="pulsus-dash"} events,
                                                  │              fallback pyramid tiles
                                                  ├─ scope check (v1: text unchanged, restricted scopes refused; T07 §0) → PulsusDB request (+X-Pulsus-Query-Id)
                                                  ├─ streaming parse → JSON frames (M-UI1); Arrow Go builders → RecordBatch (from the engine, §0)
                                                  ├─ coverage assembly (§5.3)
                                                  └─ DSF framing (§5.1) ──HTTP/2 body or WS binary──┐
 browser                                                                                          ▼
  native HTTP decompression (zstd/br/gzip) → shim/net.js → [copy 1] chunk arena (SAB, 64-B aligned)
   → DSF parser (slices) → arrow-ipc decode (zero-copy Buffers) → Chunk published (T03 §4.3)
   → render: f32 render columns → [copy 2] GPU buffer      → local engine (T13, draft) reads the same Chunk
```

Interaction reads only published chunks. A network response changes what the next frame draws; it
never gates a frame (T01-005).

#### T04-001 — One columnar format on the data plane
**MUST** — Every data-plane result from the BFF to the chart engine, whether its source is PulsusDB
or a Postgres virtual source, MUST be one or more Arrow IPC messages in DSF frames, using the schemas
of §4.3. Until the engine lands, and afterwards for DOM-only results, results MUST be JSON frames whose
schema is the OpenAPI image of the §4.3 schema of the same name (§0). JSON MUST otherwise be used
only for requests and for config/CRUD.

### 4.2 Conventions for every schema

- **Time.** Absolute instants are `Timestamp(Nanosecond, "UTC")` (int64), except where a grid makes
  them implicit (§4.3). Schema metadata `dash.time_unit` is always stated.
- **Strings.** Repeated strings (label keys and values, service names, span names) are
  `Dictionary(UInt16|UInt32, Utf8)`. Each stream emits every dictionary once, before its first batch.
  There are **no delta or replacement dictionaries in v1**: arrow-rs's handling of IPC delta
  dictionaries must be verified first.
- **Identity.** Series, streams and entities carry a `key_hash: UInt64`, the `xxh3_64` of the sorted
  canonical label set, computed by `dash-keyhash` in the BFF (Go) and, for synthetic data, in `pulsus-synth`; both match
  one fixture corpus (§0). It drives stable series colours (T02-005) and cache keys.
- **Alignment.** The BFF writes IPC with 64-byte buffer alignment (an Arrow Go writer option, §0),
  so float columns are naturally aligned inside the 64-byte-aligned arena slab.
- **Compression.** No Arrow body compression. The browser's native HTTP decompression
  (`Content-Encoding: zstd` where the client advertises it, otherwise `br` or `gzip`) and WS
  `permessage-deflate` do it in native code, off our threads, and keep a zstd decoder out of WASM.
- **Schema id.** `dash.schema = "<name>/<major>"` in schema metadata. The browser rejects an unknown
  major and accepts additive minor columns.
- **Absent vs NaN.** An absent point is null in the validity bitmap and is drawn as a gap. NaN and
  ±Inf are preserved as IEEE values. PulsusDB's strings `"NaN"`, `"+Inf"` and `"-Inf"` map to those
  values.

#### T04-002 — Schema identity and evolution
**MUST** — Every schema MUST carry `dash.schema = "<name>/<major>"`. Minor versions MUST be additive
(new nullable columns or metadata only). The browser MUST reject an unknown major.

#### T04-003 — Dictionaries once, before use
**MUST** — Every dictionary MUST be emitted once per stream before the first batch that references it.
Delta and replacement dictionaries MUST NOT be sent in wire v1.

#### T04-004 — Stable identity hash
**MUST** — `key_hash` MUST be `xxh3_64` over the canonical, sorted label set, computed by the single
`dash-keyhash` implementation, so the same series has the same hash in every response, session and
source.

#### T04-005 — Absent is null, not interpolated
**MUST** — A missing sample MUST be encoded as null in the validity bitmap. The BFF MUST NOT fill
gaps, and NaN/±Inf MUST round-trip bit-exactly.

### 4.3 Result-type schemas (authoritative)

**`labels/1`** is the series, stream and group dictionary shared by metric, log and profile results.
It is sent as its own part before the data part that references it.

| Column | Type | Notes |
|---|---|---|
| `series_id` | `UInt32` | dense, per request |
| `key_hash` | `UInt64` | §4.2 |
| `label_key` | `Dictionary(UInt16, Utf8)` | long form: one row per (series, label) |
| `label_value` | `Dictionary(UInt32, Utf8)` | |

**`metric_matrix.grid/1`**. Used by PromQL `query_range`, LogQL metric queries, TraceQL metrics,
profile `select_series`, log volume over time, and the Postgres virtual series (`ALERTS`,
`ALERTS_FOR_STATE`, `pulsus_anomaly_score`). Points sit on the request grid `start + k·step`, which
PulsusDB anchors on `start` (API §2.1, §3.2), so timestamps are implicit.

| Column | Type | Notes |
|---|---|---|
| `series_id` | `UInt32` | → `labels/1` |
| `values` | `FixedSizeList(Float64 nullable, N)` | one row per series; the child array is contiguous per series, which is exactly the M1 polyline input |

Metadata: `dash.grid.start_ms`, `dash.grid.step_ms`, `dash.grid.len` (= N),
`dash.result = metric | log_volume | log_rate | trace_metric | profile_series | virtual`,
`dash.source = pulsusdb | postgres`, `dash.unit` (from the
[05 §10](../product/05-visualisation-catalogue.md#10-vis-configuration-field-config-parity)
unit ids). Batches hold ≤ 64 series or ≤ 1 MiB. Optional negotiated variant
`values: FixedSizeList(Float32, N)` (`precision=f32`) for render-only parts such as 10⁴-series
band + outlier scenes; the Inspector re-fetches exact values on click.

**`metric_matrix.sparse/1`**. Used for raw samples and exemplars, where points are off-grid.

| Column | Type |
|---|---|
| `series_id` | `UInt32` |
| `points` | `List(Struct{ t: Timestamp(ns), v: Float64 })` (children contiguous across series; offsets give per-series runs) |
| `exemplar_trace_id` | `FixedSizeBinary(16)` nullable (exemplar results only) |
| `exemplar_span_id` | `FixedSizeBinary(8)` nullable |

**`heatmap/1`**. Used by native and classic histograms, TraceQL `histogram_over_time`, and the R2
fallback span-duration heatmap.

| Column | Type | Notes |
|---|---|---|
| `series_id` | `UInt32` | group (e.g. service) |
| `bucket_lo`, `bucket_hi` | `Float64` | in `dash.unit`; one row per (group, bucket) |
| `counts` | `FixedSizeList(Float64, N)` | on the grid, as in `metric_matrix.grid` |

**`log_lines/1`**. Used by LogQL stream queries and live tail. Rows are in request direction
(`dash.direction = backward|forward`).

| Column | Type | Notes |
|---|---|---|
| `ts` | `Timestamp(ns)` | from the string `ts_ns` (API §2.1) |
| `stream_id` | `UInt32` | → `labels/1` (indexed stream labels) |
| `line` | `Utf8` | batch ≤ 4 MiB, so 32-bit offsets suffice |
| `level` | `UInt8` | detected level: 0 unknown, 1 trace, 2 debug, 3 info, 4 warn, 5 error, 6 fatal |
| `entry_key` | `UInt64` | `xxh3_64(ts, stream key_hash, line)`: dedupe across pages, tail resume |
| `metadata` | `List(Struct{k: Dictionary(UInt16,Utf8), v: Utf8})` nullable | structured metadata (needs `categorize-labels`, API §2.1) |
| `parsed` | same as `metadata` | pipeline-extracted fields |
| `trace_id` | `FixedSizeBinary(16)` nullable | extracted by the BFF from metadata/parsed when present (pivot link) |

**`log_patterns/1`**. Used by `/patterns` and the R9 baseline diff.

| Column | Type | Notes |
|---|---|---|
| `pattern_id` | `UInt32` | |
| `pattern` | `Utf8` | template with `<_>` |
| `level` | `UInt8` | per (pattern, level) series, as PulsusDB emits them (API §2.6.4) |
| `total`, `baseline_total` | `UInt64`, `UInt64` nullable | |
| `status` | `UInt8` | 0 same, 1 NEW, 2 GONE, 3 up, 4 down (BFF-diffed until R9) |
| `samples` | `FixedSizeList(UInt32, N)` | sparkline on the grid |

**`span_points/1`** (R2). Used by the span scatter.

| Column | Type | Notes |
|---|---|---|
| `start` | `Timestamp(ns)` | |
| `duration_ns` | `Int64` | |
| `status` | `UInt8` | 0 unset, 1 ok, 2 error |
| `service` | `Dictionary(UInt16, Utf8)` | |
| `name` | `Dictionary(UInt32, Utf8)` | |
| `trace_id` / `span_id` | `FixedSizeBinary(16)` / `(8)` | |
| `weight` | `Float32` | inverse sampling probability (1.0 = unsampled) |
| `attr.<key>` | `Dictionary(UInt32, Utf8)` nullable | requested `fields=` |

Until R2 lands, the planner asks for `heatmap/1` plus `trace_tree/1` for brushed traces. The same
viewport accepts either result type (R2 fallback).

**`trace_tree/1`**. Used by the waterfall. The BFF requests `Accept: application/protobuf` from
`/api/traces/v1/trace/{id}` (API §4.1) and converts to Arrow. Spans come in **DFS pre-order**, so
`subtree_end` makes collapse and expand O(1).

| Column | Type | Notes |
|---|---|---|
| `parent_idx` | `Int32` | −1 for root or orphan |
| `depth` | `UInt16` | |
| `subtree_end` | `UInt32` | exclusive row index |
| `span_id`, `parent_span_id` | `FixedSizeBinary(8)` | |
| `start` | `Timestamp(ns)` | |
| `duration_ns` | `Int64` | |
| `service`, `name` | `Dictionary(UInt16/UInt32, Utf8)` | |
| `kind`, `status` | `UInt8`, `UInt8` | OTLP enums |
| `status_message` | `Utf8` nullable | |

The same response carries three more parts:
- `span_attrs/1` in long form: `span_idx UInt32`, `scope UInt8` (resource, span, event, link,
  instrumentation), `key Dictionary(UInt16,Utf8)`, `type UInt8`, `str Utf8?`, `i64 Int64?`,
  `f64 Float64?`, `bool Boolean?`;
- `span_events/1`: `span_idx`, `ts`, `name`;
- `span_links/1`.

The critical path is computed client-side by the waterfall layout ([T02 §4.8](T02-vis-engine.md#48-every-vis-in-05-mapped-to-primitives)).

**`profile_flame/1`** and **`profile_flame_diff/1`**. These come from the Connect `FlameGraph`, whose
nodes are `[x offset (delta), total, self, name index]` per level (API §5). The BFF prefix-sums the
offsets, so each row is a ready M3 rect.

| Column | Type | Notes |
|---|---|---|
| `level` | `UInt16` | y |
| `x` | `UInt64` | absolute offset in ticks |
| `total`, `self` | `UInt64`, `UInt64` | width = `total / root_total` |
| `name` | `Dictionary(UInt32, Utf8)` | dictionary = PulsusDB `names` verbatim |
| *(diff only)* `r_x`, `r_total`, `r_self` | `UInt64` | from `FlameGraphDiff` |

Metadata: `dash.profile.type`, `dash.unit`, `total`, `max_self`, and for diffs `left_ticks` and
`right_ticks`. Profile time series use `metric_matrix.grid/1` with `dash.result=profile_series`.

**`entities/1`** (R3 / [T12](T12-entity-catalogue.md)), with **`entity_edges/1`**.

| Column | Type | Notes |
|---|---|---|
| `entity_id` | `UInt64` | stable id (T12 defines derivation) |
| `kind` | `Dictionary(UInt8, Utf8)` | region, cluster, namespace, service, pod, node, host, … |
| `name` | `Utf8` | |
| `parent_id` | `UInt64` nullable | containment |
| `signals` | `UInt8` | bitmask: metrics, logs, traces, profiles |
| `first_seen`, `last_seen` | `Timestamp(ms)` | |
| `state` | `UInt8` | 0 OK, 1 Watch, 2 Degraded, 3 Failing, 4 Unknown ([08 §4](../product/08-visual-language.md#4-shape-and-redundancy-accessibility)) |
| `score` | `Float32` | anomaly score |
| `class` | `Dictionary(UInt8, Utf8)` nullable | canonical class ([16](../product/16-infrastructure-model.md) Table 16-1); null for hierarchy levels and services |
| `shape_family` | `UInt8` nullable | one instanced draw per value per viewport ([T12](T12-entity-catalogue.md)) |
| `shape_form` | `UInt8` nullable | sub-form within the family (instance parameter) |
| `provider` | `Dictionary(UInt8, Utf8)` nullable | e.g. `aws`, `azure`, `gcp`, `on-prem` |
| `flags` | `UInt8` | bitmask: managed, inventory-only, unknown type, restricted, gone, pending |

Attributes for each entity go in a long-form `entity_attrs/1` part (`entity_id`, `key`, `value`).
`entity_edges/1` holds `src UInt64`, `dst UInt64`, `rel UInt8` (calls, runs_on, contains),
`conn UInt8` (rpc, messaging; from the service graph, API §4.5), `calls` and `failed` (`UInt64`), and
`p50_ns`/`p95_ns`/`p99_ns` (`Float64`).

**`health_pyramid/1`** (R4 / T13 (draft)). There is one part per resolution level (10 s, 1 m, 12 m,
2 h, 1 d). Each part is a grid with entities as rows.

| Column | Type | Notes |
|---|---|---|
| `entity_ix` | `UInt32` | index into the entity part |
| `state` | `FixedSizeList(UInt8, N)` | five-state per bucket, worst-wins merged |
| `score` | `FixedSizeList(UInt8, N)` | anomaly score quantised 0–255 (`dash.score_scale`) |
| `rate`, `err_ratio`, `p95` | `FixedSizeList(Float32, N)` nullable | requested measures only |

Metadata: `dash.pyramid.level_s`, `dash.grid.*`, `dash.source = pulsusdb | postgres`. Where PulsusDB
serves R4 rollups, the BFF converts them. Otherwise the pyramid is the Dash-derived fallback, stored
in PostgreSQL as compressed Arrow tiles (`bytea`, one row per entity × signal × level × tile, 7-day
default retention, regenerated on demand) and streamed verbatim
([ADR-0012](../adr/0012-derived-state-in-postgres.md), [T11](T11-postgres-schema.md)). With 2 000
entities × 1 440 buckets (1 m × 24 h), `state` and `score` take 5.8 MB uncompressed. These columns
are dominated by runs of OK and 0, so HTTP zstd compresses them heavily. That must be verified with
the synthetic estate ([T05 §4.5](T05-testing-and-performance.md#45-seeded-synthetic-telemetry-and-the-incident-replay-corpus)).

**`compare/1`**. Used by TraceQL `compare()` and the R6 fallback.

| Column | Type | Notes |
|---|---|---|
| `key` | `Dictionary(UInt16, Utf8)` | |
| `value` | `Utf8` | |
| `sel_count`, `base_count` | `UInt64` | |
| `divergence` | `Float32` | BFF-computed; the client may re-rank |
| `verdict` | `UInt8` | 0 different, 1 unchanged, 2 insufficient data |

Metadata: `sel_total`, `base_total`. Keys excluded by cardinality caps are listed in the coverage
block, so "unchanged" and "not measured" stay distinguishable.

**`events/1`**. Used by event markers on time charts and by the Time Ribbon in Space scenes: annotations and alert transitions (from
Postgres, M-UI1), Dash-derived change events (the `{source="pulsus-dash"}` stream, Postgres), and the
PulsusDB change feed (R8, M-UI3). Columns: `seq UInt64`, `ts`, `end` nullable,
`kind Dictionary(UInt8,Utf8)` (deploy, config, flag, alert, annotation, invalidate), `entity_id`,
`title Utf8`, `attrs List(Struct{k,v})`, `source UInt8` (0 pulsusdb, 1 postgres).

### 4.4 Streaming and chunking

Within one part, the BFF emits frames in this order:

```
 SCHEMA(labels) → BATCH(labels)… → META(planned) → SCHEMA(data) → BATCH(data)… → META(final) → END
```

- **The first data batch is small**: ≤ 64 KiB or ≤ 8 series, flushed as soon as it is built. Later
  batches are ≤ 1 MiB. This keeps time-to-first-paint close to the BFF's first upstream byte.
- **Coarse → fine** are *separate parts* with `rank` 0, 1, 2… ([09 §6](../product/09-performance-contract.md#6-progressive-data-strategy)
  steps 2–3). Rank 0 is the planner's coarse query (step ≈ visible range / (pixel width / 4),
  [T07](T07-scene-query-planner.md)). The client keeps the coarse chunk until a finer part covers the
  same range, then crossfades over 150 ms. Rank 1 refines the visible range; rank 2 prefetches one
  window width on each side at the refined step.
- **Long ranges** are time-split by the BFF into grid-aligned sub-ranges, which lets PulsusDB work in
  parallel and lets the BFF parse in parallel. Each sub-range is a batch in the same part, in time
  order. This also respects PulsusDB's 11 000-interval cap per `query_range` (API §3.2).
- **Progress, not spinners.** While a part is open, the viewport shows the best rank it has (cached,
  coarse or refined). The viewport-edge shimmer appears only if no rank ≥ 1 has arrived 300 ms after
  the request (T02-007).

#### T04-006 — First batch is small and early
**MUST** — The BFF MUST flush the first data batch of every part at ≤ 64 KiB or ≤ 8 series as soon as
it is built.

#### T04-007 — Ranks never regress
**MUST** — The client MUST replace a chunk only with data of equal or finer rank for the same range
and request generation, so a stale or coarser response never paints over a fresher or finer one.

### 4.5 Error model

Upstream errors become an `ERROR` frame with an `error/1` batch (§5.1) for the affected part, never
a failed HTTP response for the whole request, so the other parts of a viewport still paint.
`too_broad` (PulsusDB `422`, profiles `429 resource_exhausted`) always carries a `suggestion` that
the coverage meter turns into a one-click "narrow" action.

### 4.6 No write path to PulsusDB (D2)

The data plane is read-only towards PulsusDB. Reserved selectors and derived results are resolved by
the planner against Postgres virtual sources ([T07](T07-scene-query-planner.md)) and framed like any
other result, with `dash.source = postgres`. The draft's fallback of building health pyramids as
recording-rule series in PulsusDB is removed.

#### T04-008 — The data plane never writes to PulsusDB
**MUST** — No data-plane request kind MUST cause a write to PulsusDB. Alert history and state,
baselines, anomaly scores, derived change events and fallback pyramids MUST be read from and written
to PostgreSQL only ([ADR-0012](../adr/0012-derived-state-in-postgres.md)). Dash's only writes to
PulsusDB are its self-telemetry and the configured audit export.

## 5. Interfaces

### 5.1 Dash Stream Frame (DSF) envelope

Each response body (`Content-Type: application/vnd.pulsus.dash-stream;v=1`) and each WS binary
message is a sequence of frames:

| Off | Type | Field |
|---|---|---|
| 0 | `u8` | `version` = 1 |
| 1 | `u8` | `type`: 1 SCHEMA, 2 BATCH, 3 META, 4 END, 5 ERROR, 6 PROGRESS, 7 EVENT, 8 PING |
| 2 | `u16` | `flags`: bit0 last frame of part, bit1 volatile (touches "now"), bit2 from BFF cache |
| 4 | `u32` | `part_id` |
| 8 | `u32` | `payload_len` |
| 12 | `u16` | `rank` (resolution rank) |
| 14 | `u16` | reserved (0) |
| 16 | … | payload: one Arrow IPC encapsulated message (SCHEMA/BATCH); a single-row `coverage/1` batch (META); a single-row `error/1` batch (ERROR) |

All fields are little-endian. The 16-byte header keeps the payload start 8-aligned. The data worker
reads headers straight out of the arena slab without copying ([T03 §5.2](T03-browser-runtime.md#52-bootstrap-and-the-network-byte-pump)).
A frame may span `net_commit` chunks. The parser holds a cursor, and only a frame split across two
slabs is stitched, which costs one small copy of at most the frame tail.

`error/1`:

| Column | Type | Notes |
|---|---|---|
| `code` | `UInt8` | bad_query, too_broad, unauthorised, forbidden_scope, upstream_unavailable, timeout, cancelled, rate_limited, internal |
| `http_status` | `UInt16` | upstream status (e.g. 422, 429) |
| `message` | `Utf8` | |
| `position` | `UInt32` nullable | byte offset into the query, for [T09](T09-query-editors.md) |
| `retry_after_ms` | `UInt32` nullable | |
| `suggestion` | `Utf8` nullable | "narrow" suggestion ([PRF-031](../product/09-performance-contract.md#prf-031--truncation-honesty)) |

#### T04-009 — DSF header layout
**MUST** — Every DSF frame MUST start with the 16-byte little-endian header above, with `version = 1`
and the reserved field 0, and its payload MUST be exactly `payload_len` bytes.

#### T04-010 — Decoders bound and validate everything
**MUST** — The DSF parser MUST bound every length against the slab before reading, and Arrow IPC MUST
be decoded with validation on (offsets and buffer lengths checked) before a chunk is published. A
violation MUST fail only that part, with an `internal` error and a RUM event.

### 5.2 HTTP endpoints (data plane)

| Method & path | Body | Response |
|---|---|---|
| `POST /api/dash/v1/query` | `QueryRequest` (JSON) | DSF stream |
| `POST /api/dash/v1/cancel` | `{request_id, part_ids?}` | `204`, for parts inside a still-open multi-part response |
| `GET /api/dash/v1/live` | WebSocket, subprotocol `pulsus-dash.v1` | §5.5 |
| `GET /api/dash/v1/bootstrap` | — | JSON: session, tenant, `scope_epoch`, wire versions, flags ([T03 §5.2](T03-browser-runtime.md#52-bootstrap-and-the-network-byte-pump)) |

`QueryRequest` is JSON because it is small; the TS client builds it from the OpenAPI types and the Go
BFF parses it.
[T07](T07-scene-query-planner.md) owns the field semantics.

```json
{ "v": 1, "request_id": "9f2c1e0a-000041", "priority": "interactive",
  "accept": ["metric_matrix.grid/1", "labels/1", "coverage/1"],
  "parts": [ { "part_id": 1, "kind": "promql_range", "query": "sum by (pod) (rate(http_requests_total{service=\"checkout\"}[1m]))",
               "start_ms": 1795000000000, "end_ms": 1795003600000, "step_ms": 15000, "rank": 0,
               "limits": { "max_series": 2000 }, "precision": "f64" } ],
  "cache": { "have": ["<chunk key>", "…"] } }
```

| `kind` | Source (verified in the PulsusDB API reference) | Result | Fallback / requirement |
|---|---|---|---|
| `promql_range` | `/api/v1/query_range`; reserved selectors → Postgres virtual source | `metric_matrix.grid` | R1 |
| `promql_exemplars` | `/api/v1/query_exemplars` | `metric_matrix.sparse` | — |
| `logql_streams` | `/api/logs/v1/query_range` + `categorize-labels` | `log_lines` | — |
| `logql_metric` | `/api/logs/v1/query_range` (matrix) | `metric_matrix.grid` | R1 |
| `log_volume` | `/api/logs/v1/volume` (top-N vector) or `count_over_time` matrix | `metric_matrix.grid` (over time) or `compare/1` single side (top-N) | — |
| `log_patterns` | `/api/logs/v1/patterns` × 2 | `log_patterns` | R9 |
| `log_fields` | `/api/logs/v1/detected_fields` | `compare/1` (single side) | R6 |
| `trace_fetch` | `/api/traces/v1/trace/{id}` (protobuf) | `trace_tree` + parts | — |
| `traceql_search` | `/api/traces/v1/search` | `span_points` (root spans) | — |
| `traceql_metrics` | `/api/traces/v1/metrics/query_range` (native trace-metrics body) | `metric_matrix.grid` / `heatmap` | R1 |
| `span_points` | — (R2 not available) | `span_points` | R2 → `heatmap` + brushed `trace_fetch` |
| `service_graph` | `/api/traces/v1/service_graph` | `entity_edges` | R5 → N windowed calls; edge cap per assumption A1 |
| `profile_merge` / `profile_diff` | Connect `SelectMergeStacktraces` / `Diff` (`application/proto`) | `profile_flame(_diff)` | — |
| `profile_series` | Connect `SelectSeries` | `metric_matrix.grid` | R1 |
| `entities` | — | `entities`, `entity_edges` | R3 → label-values fan-out ([T12](T12-entity-catalogue.md)) |
| `health_pyramid` | R4 rollups when available; otherwise Postgres fallback tiles (D2) | `health_pyramid` | R4 (T13 (draft)) |
| `compare` | TraceQL `compare()`; paired counts for logs and metrics | `compare` | R6 |
| `events` | Postgres (annotations, alert transitions, `{source="pulsus-dash"}`); PulsusDB change feed when R8 lands | `events` | R8 |

Request headers: `X-Dash-Request-Id` (the client id, also in the body), `traceparent` (the browser
span, [T05 §4.7](T05-testing-and-performance.md#47-real-user-performance-telemetry-dash-observing-itself)),
and `X-Dash-Wire: 1`.

#### T04-011 — Two wire versions in flight
**MUST** — The BFF MUST serve wire *N* and *N−1*, so a tab that is still open survives a rolling
deploy, and `/bootstrap` MUST advertise the versions served.

### 5.3 Coverage block (`coverage/1`, R10)

This single-row batch is sent as META twice per part: once `planned` before the data and once
`final` after it (`partial` on an interrupted stream).

| Column | Type | Source today (fallback) |
|---|---|---|
| `phase` | `UInt8` | 0 planned, 1 partial, 2 final |
| `exactness` | `UInt8` | 0 raw-exact, 1 rollup, 2 sampled, 3 estimated. From `X-Pulsus-Explain: 1` → `exactness` `"raw-exact"`/`"rollup"` (API headers, §3.6) |
| `rollup_level_s` | `UInt32` nullable | inferred from the range → level table (API §3.6) until reported directly |
| `sampled_ratio` | `Float64` nullable | R2 response; TraceQL exemplar budgets |
| `truncated` | `Boolean` | `warnings: ["results truncated due to limit"]` (§3.2); `truncated` on service graph (§4.5) and tags (§4.3); `limit` hit on log streams |
| `truncation_reason` | `Dictionary(UInt8, Utf8)` nullable | `limit`, `series_cap` (500 per variant, §2.2), `edges_cap` (1 000 today), `max_nodes` (profiles), `tail_dropped` |
| `dropped_count` | `UInt64` nullable | live tail `dropped_total` (§2.4); edges dropped |
| `series_returned` | `UInt32` | counted by the BFF |
| `rows_read`, `bytes_read` | `UInt64` nullable | `stats` where present (logs `stats.bytes`) |
| `shards_failed`, `shards_skipped` | `UInt16` nullable | **not reported by PulsusDB today** (R10 ask) |
| `retention_floor` | `Timestamp(ms)` nullable | e.g. the profiles look-back floor of 7 days (`PULSUS_PROFILES_MAX_QUERY_LOOKBACK`, §5) |
| `excluded_dims` | `List(Utf8)` | cardinality-capped keys (compare, inventory); masked fields |
| `warnings` | `List(Utf8)` | PulsusDB `warnings` verbatim |
| `upstream_query_ids` | `List(FixedSizeBinary(16))` | `X-Pulsus-Query-Id` per upstream call |
| `read_cache` | `UInt8` nullable | `X-Pulsus-Read-Cache` hit/miss/bypass (§3.2) |
| `data_end` | `Timestamp(ms)` nullable | newest sample instant in the part (freshness) |
| `upstream_ms`, `convert_ms` | `UInt32` | BFF timings (RUM, explain view) |

The browser merges `coverage/1` across the parts of a viewport, adds client facts (source ⚡ local or
☁ server, cache age, GPU tier, LOD reductions from T02-016) and emits `CoverageChanged` to the shell.
The badge shows ✓ exact when every part is `final`, `raw-exact`, untruncated and has no excluded
dimension; it shows "100 %" in that case, never an absent meter. Data age (now − `data_end`, or the
cache age) is the freshness indicator on every viewport. Requesting `X-Pulsus-Explain: 1` adds
generated SQL to every PulsusDB response, so the BFF sets it only where it needs `exactness`, until
R10 offers a cheaper flag.

#### T04-012 — Every part carries coverage
**MUST** — Every data part MUST carry a `planned` and a `final` (or `partial`) coverage block. A
PulsusDB `truncated` flag, limit warning or `422` MUST be mapped into the block or into `error/1`
and MUST NOT be dropped. The client MUST show complete coverage as "100 %" and MUST show data age on
every viewport.

### 5.4 Request ids, priorities and cancellation

- **`request_id`** = `<session 8 hex>-<seq 6 hex>`, unique per tab and allocated by data-0. Parts are
  numbered within a request. The BFF logs `request_id ↔ X-Pulsus-Query-Id`, so a slow viewport
  traces to ClickHouse statements.
- **Granularity.** One HTTP/2 request per *cancellable unit*, normally one viewport and its ranks.
  Parts that share fate (labels + data + coverage) share a request.
- **Priority classes** (`priority` field → BFF scheduler; `fetch` `priority` hint):
  `interactive` > `refine` > `prefetch` > `background`.
- **Generations.** Each viewport has a request generation, incremented by every Context or camera
  change that supersedes its data. Frames from an older generation are discarded (T04-007).
- **Cancellation:**

```
 render: viewport superseded ─► data-0: cancel(request_id) ─► net_cancel → AbortController.abort()
   → HTTP/2 RST_STREAM ─► BFF: request future dropped ─► PulsusDB HTTP request dropped
   → PulsusDB records 499; ClickHouse statements cancelled ← R11 (to be confirmed by PulsusDB)
 Late frames for a cancelled id are discarded by the DSF parser (request table lookup).
```

Until R11 is confirmed, the BFF also coalesces identical in-flight upstream queries and rate-limits
per viewport (R11 fallback).

#### T04-013 — Superseded requests are aborted
**MUST** — When newer user intent supersedes a request, data-0 MUST abort it (HTTP/2 stream reset)
within the same frame, the BFF MUST drop the upstream call within 50 ms, and late frames for that id
MUST be discarded.

### 5.5 WebSocket live channel

One socket per tab on data-0. Client → server messages are **text JSON** control. Server → client
messages are **binary DSF** with `part_id = sub_id`.

| Op | Fields | Server behaviour |
|---|---|---|
| `sub` | `sub_id`, `kind` (`tail`, `changes`, `alerts`, `live_metric`, `collab`), `spec`, `resume` | `tail` → PulsusDB `/api/logs/v1/tail` WS, re-framed as `log_lines/1`; `live_metric` → incremental `query_range` (cheap thanks to the PulsusDB read cache, §3.2); `changes`/`alerts` → `events/1` (alert transitions from Postgres via LISTEN/NOTIFY); `collab` → opaque bytes for T17 (draft) |
| `unsub` | `sub_id` | close the upstream |
| `credit` | `sub_id`, `bytes` | flow control: the server sends at most the granted bytes, then coalesces (metrics) or drops oldest and reports `dropped_count` (tail, matching PulsusDB's own slow-consumer rule, §2.4) |
| `ping` | `t` | `PING` frame echo (RTT for RUM) |

Resume: `tail` resumes from `(last ts, entry_key)`, and `changes` from the last `seq`. Reconnect uses
exponential backoff from 0.5 s to 30 s with full jitter. While disconnected, the LIVE pill shows
"reconnecting…" and LIVE is paused ([03 §6](../product/03-interaction-model.md#6-time-as-a-dimension)).
Live tail budget: ingest → screen < 2 s (PRF-015, M-UI2), of which BFF re-framing may add ≤ 100 ms.

#### T04-014 — Live streams are credit-controlled
**MUST** — The server MUST NOT send more than the granted credit on a subscription. Over credit it
MUST coalesce metric updates or drop the oldest tail lines and report `dropped_count`.

### 5.6 JSON → Arrow conversion in the BFF (R1 fallback)

- **Parsing.** A streaming `encoding/json` token decoder with hand-written state machines, so no
  generic tree is built. Value strings are parsed with `strconv.ParseFloat`. Builders flush a batch every 64 series. The
  matrix `result` array is consumed series by series, so the first batch is emitted before the
  upstream body ends.
- **Parallelism.** Long ranges are time-split (§4.4) into k ≤ cores sub-requests. Each is parsed on
  its own task, and the results are re-ordered by sub-range.
- **Upstream compression.** On the LAN the BFF sends `Accept-Encoding: identity`, which spares
  PulsusDB's level-7 gzip. This is configurable for WAN deployments.
- **Traces and profiles** come as protobuf (`google.golang.org/protobuf`) into Arrow. That is cheaper than JSON because
  values are already binary.
- **Budget** (native, per BFF core): ≥ 150 MB/s of Prometheus JSON, about 6 M points/s. 1 000 × 10 000
  points with k = 4 → ≤ 450 ms added server time. This is the cost R1 removes, and the harness (§10)
  measures it.
- **Pass-through.** If R1 ships an Arrow stream, the BFF re-frames record batches as DSF without
  decoding values. It still validates the schema and rewrites `labels/1` for scope masking.

### 5.7 Zero-copy path from network to GPU

| Step | Thread | Copy? |
|---|---|---|
| Browser decompresses the body natively | browser net | (native) |
| `reader.read()` chunk → `net_alloc` slab in the shared arena | data-k | **copy 1** (fetch never yields SAB-backed chunks, and BYOB readers cannot target a SharedArrayBuffer) |
| DSF header parse; Arrow IPC decode with `Buffer::from_custom_allocation` over the slab | data-k | none |
| Publish `Arc<Chunk>` | data-k | none |
| Column ranges: u32 per (series, column) from f64 timestamps, recomputed on every window or plot-width change (one shared table for a grid chunk; no timestamp is uploaded) | pool | transform |
| Encoded values: `u = (v − v_ref)·2^−exp` per value for the draw's encoding ([T02-014](T02-vis-engine.md#t02-014--precision-f64-on-the-cpu-f32-relative-to-an-encoding-origin); non-finite → gap bits), rebuilt only when the encoding changes, written in slices of ≤ 16 MiB | pool | transform (not a copy of the f64 data) |
| `queue.write_buffer(slice)` | render | **copy 2** (into GPU memory) |
| Staging slab freed on T1; on T2 the encoded slab stays in CPU memory as the decimation input. f64 originals stay in the arena for tooltips, the Inspector and the local engine | — | — |

*(Revised 2026-11-21, #68.)* f32 values keep ~7 significant digits of the encoding's span, which
pixels need; timestamps stay f64 and only column indices reach the GPU (T02-014). WGSL has no f64 or
i64, which is why values are encoded before upload. A WebGPU-only variant uploads raw f64 bits as
`array<vec2<u32>>` and converts to the draw's encoding in a compute pass. This saves the CPU
transform and is a benchmark candidate (§10).

The encoded values of a chunk are keyed (ChunkId, Encoding) in the renderer: a draw list that no
longer references a key releases its buffer before anything is allocated, so a chunk drawn by one
item has at most one resident encoding, and a dropped chunk has no GPU buffer after the next render.
Pan, zoom and resize rebuild the column ranges only; a value-range change re-encodes only when the
encoding choice changes; a theme change rebuilds neither.

**Memory.** At 10⁸ grid points, 1 000 series in one 1 000 × 400 CSS px viewport at DPR 2: f64
values in the arena 0.80 GB; encoded `u` for one encoding 0.40 GB (on the GPU on T1, in CPU memory
on T2), each further simultaneous encoding of the chunk + 0.40 GB; transient staging ≤ 32 MiB on T1
(the 16 MiB slab plus the driver's copy of one slice), 0 on T2; `ColOut` 40 B × series × columns
≈ 80 MB; instances 16 B × (guides + total) ≤ 64 MB; column ranges of a grid chunk < 10 kB. The
engine total ≈ 1.38 GB, so 10⁸ points fit the 1.5 GB tab budget (PRF-023) only for grid chunks,
one resident encoding per chunk, slice staging and ≤ 0.12 GB for the rest of the tab; explicit
timestamps (+0.80 GB of f64 time) and two simultaneous encodings of such a chunk do not fit. Part C
of #68 measures it (`bench:frame-line-1e8`). **Eviction order** under arena
pressure (85 % threshold, T03-023): (1) f64 originals of off-screen chunks, keeping GPU value
buffers and column ranges plus a re-fetch key; (2) raw chunks of visible viewports, replaced by the next rollup level (re-fetched at
`priority = interactive`), with coverage reason `memory`; (3) resident previous scenes beyond the
immediate parent.

#### T04-015 — At most two copies on the network path
**MUST** — Value data MUST be copied at most twice between the network and the GPU: once from the
fetch chunk into the arena slab and once into GPU memory. Decode and publication MUST be zero-copy.

#### T04-016 — Pressure degrades to rollups within 1 s
**MUST** — Under arena pressure, data-0 MUST follow the eviction order above, and every affected
viewport MUST show rollup data and the "reduced resolution (memory)" coverage reason within 1 s.

## 6. Data & storage

### 6.1 IndexedDB chunk cache

The database is `pulsus-dash`, schema version 1. It is opened from data-0 through `web-sys`.

| Store | Key | Value |
|---|---|---|
| `chunks` | `[tenant_hash, scope_epoch, query_fp, step_ms, bucket_start_ms]` | `{ ipc: ArrayBuffer (DSF frames of one part slice), coverage, created_ms, last_access_ms, bytes, wire, build, volatile }` |
| `scenes` | `[tenant_hash, scope_epoch, scene_key]` | last-viewed scene snapshot: Context + chunk keys + camera, for "show cached first" and the Alert Lens instant paint |
| `pyramids` | `[tenant_hash, scope_epoch, level_s, day]` | `health_pyramid/1` slices |
| `lru` (index on `chunks.last_access_ms`) | — | eviction order |

- **`query_fp`** = `xxh3_128` of the canonical query: the AST normal form from the shared parsers
  ([T09](T09-query-editors.md)), or the trimmed text as fallback, plus `kind`, the result schema
  major, and the datasource/database (`X-Pulsus-Database`).
- **Buckets.** A chunk covers `step × 1 024` grid points, aligned to `step` from epoch, so pans and
  zooms reuse whole chunks, and a ±1 window prefetch lands in cacheable buckets.
- **Show cached first.** On scene open, data-0 reads the `scenes` snapshot and its chunks before
  planning, so the first canvas frame shows them hatched as stale; hatching clears per viewport when
  a fresh rank paints.
- **Settled vs volatile.** A chunk whose end is older than `now − 5 min` is *settled*. That threshold
  sits just above PulsusDB's own 4-minute read-cache stability rule (API §3.2). Volatile chunks are
  served stale-with-hatching and always revalidated. The request lists `cache.have` keys so the BFF
  can skip settled buckets.
- **Eviction.** The budget is `min(10 % of navigator.storage.estimate().quota, 1 GiB)` per origin,
  LRU by `last_access_ms`, checked on every write. Pyramids and scenes are evicted last.
- **Invalidation:**
  - a new `build` or `wire` major drops all stores;
  - a changed `scope_epoch` (role or data-scope change, from `/bootstrap`) drops that tenant's keys,
    because a narrower scope must never see wider cached data;
  - logout deletes the database (T10 (draft));
  - `events/1` of kind `invalidate` (backfill, retention change, delete) on the change feed drops the
    matching tenant and time range.
- **Copies.** IDB cannot store SAB views, so writes copy the slab into a fresh `ArrayBuffer`, off the
  hot path at idle priority. Reads land in an arena slab like network bytes.
- **Policy.** `cache.mode = disk | memory | off` per org. Encryption at rest is decided by
  [T18](T18-security.md).

#### T04-017 — Cache keys carry tenant and scope
**MUST** — Every IndexedDB key MUST start with `[tenant_hash, scope_epoch]`, MUST NOT contain raw
query text, and a changed `scope_epoch` MUST drop that tenant's entries before any read.

#### T04-018 — Volatile data is always revalidated
**MUST** — A chunk ending later than `now − 5 min` MUST be shown hatched as stale and MUST be
revalidated; only settled chunks MAY be skipped via `cache.have`.

### 6.2 Other locations

| Data | Where |
|---|---|
| Decoded chunks | core shared arena ([T03 §4.3](T03-browser-runtime.md#43-shared-memory-layout-and-ownership)) |
| Recently served Arrow parts (seconds to minutes) | BFF cache ([T06](T06-bff-architecture.md)) |
| Raw telemetry | PulsusDB (read-only for Dash) |
| Dash-derived state, fallback pyramid tiles | PostgreSQL ([T11](T11-postgres-schema.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md)) |

## 7. Performance budget

| Metric | Budget | 09 |
|---|---|---|
| Decode 1 000 × 10 000 grid (DSF + IPC → arena columns), WASM, (a) | **< 50 ms** p95 (target < 10 ms: zero-copy) | R1, [PRF-016](../product/09-performance-contract.md#prf-016--10⁸-line-chart-points) |
| f32 render-column transform, 10⁷ points, 4 pool threads | ≤ 15 ms | off the frame thread ([PRF-001](../product/09-performance-contract.md#prf-001--frame-rate-during-interaction)) |
| BFF → first DSF data frame after the PulsusDB first byte | ≤ 20 ms | PRF-010 |
| Warm nav → coarse paint: plan 5 + BFF 10 + PulsusDB ~150 + first batch 20 + net 30 + decode/upload/frame 25 | **< 300 ms** | PRF-010 (M-UI2) |
| Lens fully refined (typical service, 1 h) | < 1.5 s | PRF-011 (M-UI2) |
| IDB hit for a 1 MB chunk, read → arena | ≤ 25 ms | [PRF-026](../product/09-performance-contract.md#prf-026--show-cached-marked-stale) |
| Cancel → upstream dropped at the BFF | ≤ 50 ms | [PRF-030](../product/09-performance-contract.md#prf-030--cancel-superseded-requests) |
| Memory pressure → rollup shown | ≤ 1 s | [PRF-024](../product/09-performance-contract.md#prf-024--graceful-degradation-under-memory-pressure) |
| Wire bytes (zstd) vs PulsusDB JSON + gzip, same data | ≤ 1.0× | R1 |
| Live tail added latency (BFF re-frame) | ≤ 100 ms | PRF-015 (< 2 s, M-UI2) |

These are measured by the R1 harness (§10), RUM `dash.query.*` and `dash.decode.*`
([T05 §4.7](T05-testing-and-performance.md#47-real-user-performance-telemetry-dash-observing-itself)),
and the synthetic Lens load in CI.

## 8. Security, tenancy & RBAC

- The BFF sets the tenant (`X-Scope-OrgID`, `X-Pulsus-Database`) on every upstream call. For data
  scopes, in v1 it sends query text unchanged and refuses restricted principals with `scope_denied` ([T07](T07-scene-query-planner.md) §0, T07-002); data-scope matchers are injected from the parser design (T10 (draft); R12 fallback). The browser never chooses a tenant beyond what
  `/bootstrap` granted.
- Field-level masking ([11](../product/11-enterprise.md)) is applied by the BFF *while building
  frames*. Masked values are replaced, not just hidden: a masked `line` or attribute shows as
  `"‹masked›"` and is listed in `coverage.excluded_dims`.
- Postgres virtual sources are read under row-level security with the session's tenant
  ([ADR-0012](../adr/0012-derived-state-in-postgres.md)).
- The decoders are attack surface, because a compromised BFF could send hostile bytes (T04-010).
  Both the DSF parser and IPC decoding are fuzzed ([T05](T05-testing-and-performance.md)).
- IndexedDB keys include `tenant_hash` and `scope_epoch`, and no raw query text (T04-017).

#### T04-019 — Masking happens while building batches
**MUST** — Masked fields MUST be replaced in the frame (the JSON frame until the engine, the Arrow
batch from then on) by the BFF before framing, and MUST be
listed in `coverage.excluded_dims`. Unmasked values MUST NOT reach the browser.

## 9. Failure modes & degradation

| Failure | Behaviour | User sees |
|---|---|---|
| PulsusDB `422 query_too_broad` / profiles `429 resource_exhausted` | `ERROR` with `too_broad` + suggestion | truncation badge with one-click "narrow" |
| `truncated` / limit warning | coverage `truncated`, reason, `dropped_count` | "partial data" badge; "truncated" on the meter with "narrow" |
| Partial stream (connection drop mid-part) | batches kept; coverage `phase = partial` | partial data + "incomplete, retrying"; the planner re-requests missing buckets only |
| Upstream timeout (504 / `deadline_exceeded`) | `ERROR timeout`; coarser rank kept | coverage "server timed out, showing coarser data" |
| BFF unreachable | IDB cache served, all hatched stale | "Offline — showing cached data from 12:03" |
| Schema major mismatch (mid-deploy) | `/bootstrap` advertises wire versions; reload prompt | "Pulsus was updated — reload" |
| Arena pressure | eviction order (§5.7) | "reduced resolution (memory)" |
| WS lost | LIVE paused; resume on reconnect | LIVE pill "reconnecting…" |
| R2/R4/R5 absent | fallback result types (§5.2); R4 → Postgres fallback pyramids | coverage notes "estimated from heatmap", "Dash-derived rollup", etc. |
| Postgres virtual source unavailable | that part fails with `upstream_unavailable`; telemetry parts still paint | coverage "alert history unavailable" |

## 10. Testing

**R1 benchmark harness** (`crates/dash-bench-wire`, M-UI0, shared with PulsusDB engineering as
promised in R1; gate `bench:decode-r1`):

- **Fixture.** `pulsus-synth` ([T05 §4.5](T05-testing-and-performance.md#45-seeded-synthetic-telemetry-and-the-incident-replay-corpus))
  generates, from a seed, 1 000 series × 10 000 points. Each series has 8 labels averaging 40 bytes.
  The mix is 60 % gauges and 40 % counters, with 1 % NaN, 2 % absent points and realistic value
  entropy.
- **Encodings:**
  - (J) Prometheus JSON, the baseline;
  - (A1) `metric_matrix.grid/1`;
  - (A2) `metric_matrix.sparse/1`, with explicit ts;
  - (A3) A1 with f32 values;
  - (P) columnar protobuf: per series packed `fixed64` timestamps and packed `double` values, plus a
    string table, decoded with zero-copy slicing over `bytes`;
  - (P') P with prost's default `Vec` decode.

  Each encoding is tested with identity, gzip-6 and zstd-3 HTTP compression.
- **Measurements:** decode time (arena bytes → typed column slices + labels table); copies, counted
  by an instrumented allocator; peak memory; wire bytes; encode CPU (native); browser decompression
  time, from Resource Timing in the browser leg.
- **Runs.** 5 warm-up and 30 measured runs; we report p50/p95.
- **Environments:** wasm32 in Chrome stable on reference (a), driven by Playwright through the shim;
  the same in Firefox; native x86_64 and aarch64 for encode.
- **Pass (R1 acceptance).** A1 decode < 50 ms p95 on (a), ≤ 1 copy of value data, and zstd wire size
  ≤ J + gzip.

**Decision procedure: Arrow vs columnar protobuf for the PulsusDB → BFF leg**
([ADR-0005](../adr/0005-arrow-wire-format.md)). BFF → browser is Arrow from the engine on regardless (JSON frames before, §0).

1. Run the harness and record each metric for A1 and P.
2. Compute the BFF cost per response for each: P needs transcoding to Arrow, while A1 passes through
   (§5.6).
3. **Choose Arrow unless** P beats A1 by ≥ 25 % on PulsusDB encode CPU (estimated from the harness's
   native encode, with ClickHouse's own Arrow output format as a reference point to confirm with
   PulsusDB engineering), **and** P's total including transcoding is no worse than A1's end-to-end
   latency.
4. If wire size differs by > 15 % after zstd, the smaller one wins ties.
5. Record the outcome in an ADR that supersedes or confirms 0005. Send the measured schema
   (`metric_matrix.grid/1` + `labels/1` + `coverage/1`) to PulsusDB as the suggested R1 shape.

**Other tests:** golden Arrow fixtures for every schema, round-tripped from the BFF writer to the WASM
reader (`unit:codec-roundtrip`); DSF and IPC fuzzing with `cargo-fuzz` (`unit:fuzz-dsf`); JSON →
Arrow property tests that compare against PulsusDB JSON for random series sets, including NaN/Inf
and gaps (`unit:json-arrow-prop`); a cancellation storm and a truncation replay
(`replay:cancel-storm`, `replay:truncation`); and a recording proxy in front of PulsusDB that fails
the nightly storyboard run on any non-self-telemetry write (`e2e:no-pulsusdb-write`).

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI0 | DSF v1, `labels`, `metric_matrix.grid/sparse`, `coverage`, `error`; `/query` + cancel; R1 harness and decision. DSF v1 and `/query` + cancel land with #41 and #42 |
| M-UI1 | `log_lines` (LogQL stream panels, #49); `heatmap`; IDB `chunks` and `scenes` (show cached first); ranks and priorities; generations; time-split conversion; `events` from Postgres (annotations, alert transitions); Postgres virtual series in `metric_matrix.grid`; WS `live_metric` for LIVE charts |
| M-UI2 | `log_patterns`, `trace_tree` + parts, `span_points` (fallback), `profile_flame(_diff)`; WS `tail` |
| M-UI3 | `entities`, `entity_edges`, `health_pyramid` (R4 or Postgres fallback), `compare`, PulsusDB change feed in `events`; WS `changes`; IDB `pyramids` |
| M-UI4 | WS `alerts`, `collab` |

The wire version lives in `/bootstrap`. Schema minors are additive. A major bump ships with N−1
support in the BFF for one release.

## 12. Alternatives considered

| Alternative | Why not |
|---|---|
| JSON to the browser | Rejected by [ADR-0005](../adr/0005-arrow-wire-format.md): string values, no zero-copy, a GC-free parse is impossible at 10⁷ |
| Long-format metric points (`series_id, ts, value` rows) | 2× the bytes for grid data, and series must be regrouped before drawing. The `FixedSizeList` grid is already polyline-shaped |
| Arrow body compression (LZ4/ZSTD buffers) | Puts a decompressor in WASM (size, CPU on our threads). Native HTTP decompression is free to us |
| gRPC-web / Connect streaming to the browser | Protobuf decoding copies into `Vec`s; framing adds JS or extra WASM. DSF over plain HTTP/2 is simpler |
| WebTransport | Attractive for per-stream cancellation and datagrams, but deployment through enterprise proxies is uncertain. Revisit after M-UI4 |
| One multiplexed response per scene | Loses per-viewport cancellation. Kept only for parts that share fate; R13 batching happens server-side |
| Writing fallback pyramids as PulsusDB recording-rule series | Rejected by D2 ([ADR-0012](../adr/0012-derived-state-in-postgres.md)): consumes customer ingest, depends on the ruler |

## 13. Open questions

1. Does arrow-rs IPC decode with `FixedSizeList` children of 10⁴ length and a custom allocation stay
   copy-free in practice? Verify in the harness.
2. Delta dictionaries for live-tail label strings: worth it if verified in arrow-rs (§4.2).
3. Should pyramids use `Float16` measures? WGSL `f16` needs the `shader-f16` feature, which is not
   universal.
4. Should we ask PulsusDB to add a cheap `exactness` response header without explain SQL (refining
   R10)?
5. `Content-Encoding: zstd` support across target browsers and through enterprise proxies. Fall back
   to `br` or `gzip` per the client's `Accept-Encoding`.

**Resolved during formalisation**

1. **D2 applied.** The draft's `health_pyramid` source was "recording-rule series via `query_range`".
   Fallback pyramids are now Postgres Arrow tiles ([ADR-0012](../adr/0012-derived-state-in-postgres.md));
   alert history, anomaly scores and Dash change events are Postgres virtual sources in the same
   schemas (`dash.source`), and T04-008 forbids data-plane writes to PulsusDB.
2. **`events/1` moves to M-UI1**, because [INT-031](../product/03-interaction-model.md#int-031--events-on-the-time-axis) (events on the time axis) is M-UI1. Annotations
   and alert transitions come from Postgres from M-UI1; the PulsusDB change feed (R8) joins at M-UI3.
3. **Coverage badge.** The draft merged only "⚡ local or ☁ server". [09 §6](../product/09-performance-contract.md#6-progressive-data-strategy)
   adds ✓ exact, and [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) requires "100 %" rather than an absent meter; `data_end` was added
   for the freshness indicator of [AUD-041](../product/01a-audiences-and-perspectives.md#aud-041--show-data-trust).
4. **Ranks and generations** were made explicit (T04-007, §5.4) to meet [PRF-030](../product/09-performance-contract.md#prf-030--cancel-superseded-requests)'s "a stale
   response MUST NOT paint over a fresh one".
5. **Memory degradation** gained an eviction order and the 1 s bound of [PRF-024](../product/09-performance-contract.md#prf-024--graceful-degradation-under-memory-pressure).
6. **R1 reference machine.** The draft said "M2"; it is reference (a) of
   [09 §2.1](../product/09-performance-contract.md#21-reference-hardware).

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; design rules T04-001 to T04-019; D2 applied (no write path, Postgres virtual sources and fallback pyramids); `events/1` at M-UI1; coverage `data_end` and ✓ exact; ranks, generations and eviction order; Satisfies table |
| 1.0-rc | 2026-11-19 | Roadmap D5 ([12](../product/12-roadmap.md#21-delivery-order-2026-11-19) §2.1): SRF-033 traced (moved to M-UI1); §11 `log_lines` moves M-UI2 → M-UI1; `log_patterns`, `trace_tree`, `span_points`, `profile_flame(_diff)` and WS `tail` stay M-UI2; DSF v1 and `/query` + cancel land with #41/#42 |
| 1.1-rc | 2026-11-19 | [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md): new §0 (JSON frames to the browser until the engine, #68; schemas mirrored in `wire/schemas/` with fixtures in `wire/fixtures/`; Go conversion and key hash); T04-001 revised for JSON frames; §4.2, §5.2 and §5.6 name Go instead of Rust libraries; review r3: third-party product names replaced by generic wording; review r8: §1, §4.1, §8, T04-019 and §10 separate M-UI1 JSON frames from the Arrow path and state v1 scope handling |
| 1.2-rc | 2026-11-21 | §5.7 render columns and memory follow T02-014 as restated for #68 (column ranges on the CPU, per-draw value encoding, buffers per (chunk, encoding)): two rows (column ranges recomputed per window or width; encoded values rebuilt only on an encoding change, ≤ 16 MiB slices), the buffer-lifetime paragraph, and the 10⁸-point memory table qualified to grid chunks with one resident encoding |
