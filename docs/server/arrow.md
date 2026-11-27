# Arrow wire writer (`internal/arrowwire`)

`server/internal/arrowwire` turns the series the BFF decodes from PulsusDB's JSON into Arrow IPC
messages framed as Dash Stream Frames (DSF). PulsusDB answers only in JSON, so the BFF converts
them. This is the committed path; it needs nothing from PulsusDB
([ADR-0005](../../designs/adr/0005-arrow-wire-format.md)). The browser's chart engine reads the
result with its own Arrow IPC reader ([Reader](#reader), #68 Part B2).

The PromQL range route (`POST /api/dash/v1/query/promql/range`) writes its 200 body with it
when the request's `Accept` lists `application/vnd.pulsus.dash-stream;v=1`
(`arrowwire.ContentType`; #68 Part D1, [The range route](#the-range-route)). Every other route,
and the range route without that `Accept`, answers with JSON frames
([the PulsusDB page](pulsusdb.md)).

Design: [T04 §4.2–§5.3](../../designs/technical/T04-wire-format-and-data-plane.md) (schemas, DSF,
coverage), [T06-011](../../designs/technical/T06-bff-architecture.md) (the range route's formats),
[ADR-0015](../../designs/adr/0015-go-bff.md) (arrow-go, `wire/schemas`,
`unit:codec-roundtrip`). It implements T04-001 (the writer side), T04-003, T04-004, T04-005,
T04-006 and T04-009, and the T04-012 subset that maps PulsusDB's completeness into `coverage/1`.

## The data path

```
pulsusdb.ResultStream.Next ─► *Series ─► GridPart.Add ─► arrow-go batch ─► IPC payload ─► DSF frame ─► io.Writer
```

One goroutine owns a `Writer` and its `GridPart`s; nothing in the package is safe for concurrent
use. Each `GridPart` holds at most one pending batch, about 1 MiB of values plus their labels.
A frame is built in memory and written whole. Frames that belong together, such as the three
`Grid` frames or a labels batch and its data batch, are written together. A refusal found while
building them therefore writes nothing.

## DSF frames

Every frame starts with a 16-byte little-endian header (T04-009):

| Offset | Type | Field |
|---|---|---|
| 0 | `u8` | version = 1 |
| 1 | `u8` | type: 1 SCHEMA, 2 BATCH, 3 META, 4 END, 5 ERROR, 6 PROGRESS, 7 EVENT, 8 PING |
| 2 | `u16` | flags: bit 0 `FlagLast` (last frame of the part), bit 1 `FlagVolatile`, bit 2 `FlagCached` |
| 4 | `u32` | part id |
| 8 | `u32` | payload length, at most `MaxPayload` = 64 MiB |
| 12 | `u16` | rank |
| 14 | `u16` | reserved, 0 |

`AppendHeader` writes a header. `ParseHeader` reads one and rejects these:
- a short buffer, version ≠ 1, an unknown type or a non-zero reserved field (`ErrHeader`);
- a payload over 64 MiB (`ErrFrameTooLarge`).

| Frame | Payload |
|---|---|
| SCHEMA, BATCH | exactly one encapsulated IPC message: a Schema or a RecordBatch, never a DictionaryBatch |
| META, ERROR | a complete IPC stream: the schema, one one-row batch, then the end-of-stream marker `FF FF FF FF 00 00 00 00` |
| END, PING | empty |

### Alignment

An IPC message that starts at body offset `p` is written as:
- `FF FF FF FF`;
- an `i32` metadata length `L`;
- the flatbuffer metadata, zero-padded to `L` bytes;
- the body.

`L` is the smallest multiple of 8 that is at least the metadata length and puts the body at a
body offset that is a multiple of 64, so `(p + 8 + L) mod 64 = 0`. Every IPC body therefore
starts 64-byte aligned, counted from the start of the response body.

arrow-go (v18.9.0) pads body buffers only to 8 bytes. It keeps whole any buffer whose length is
already its 64-byte padded size. The writer therefore allocates every `metric_matrix.grid/1`
buffer with its length rounded up to 64, and every grid column starts on a 64-byte boundary.
`labels/1`, META and ERROR buffers are 8-byte aligned. Frame lengths are multiples of 8.
`unit:arrow-alignment` checks all of this, including the buffer addresses after an arrow-go
read-back.

## Schemas

The machine-readable schemas are in [`wire/schemas/`](../../wire/schemas/). Each YAML file gives
the ordered fields (name, type, nullability) and the metadata keys (required, format, bounds).
`unit:schema-yaml` holds the Go schemas to them field by field. No column of the four schemas is
dictionary-encoded (T04-003).

| Schema | Columns |
|---|---|
| `labels/1` | `series_id: u32`, `key_hash: u64`, `label_key: utf8?`, `label_value: utf8?` |
| `metric_matrix.grid/1` | `series_id: u32`, `values: FixedSizeList<f64?>[dash.grid.len]` |
| `coverage/1` | the T04 §5.3 block: `phase`, `exactness`, …, `upstream_ms`, `convert_ms` (22 columns) |
| `error/1` | `code: u8`, `http_status: u16`, `message: utf8`, `position: u32?`, `retry_after_ms: u32?`, `suggestion: utf8?` |

**`labels/1`.**
- There is one row per (series, label), in label-name order, and a series' rows are contiguous.
- A series with no labels has one row with both label columns null.
- `key_hash` is the series key from `internal/keyhash` (T04-004).

**`metric_matrix.grid/1`.** There is one row per series. Series ids are dense from 0 in `Add`
order. A present point keeps its float64 bits exactly: NaN payloads, ±Inf and −0 all survive. An
absent point is null in the validity bitmap and its slot holds `0x7FF8000000000000` (T04-005). The
schema metadata is:

| Key | Value |
|---|---|
| `dash.schema`, `dash.time_unit` | `metric_matrix.grid/1`, `ms` (every schema carries these two) |
| `dash.grid.start_ms` | the step-aligned grid start |
| `dash.grid.requested_start_ms` | the request's own start, with `start_ms ≤ it < start_ms + step_ms`; the retention decision uses it |
| `dash.grid.step_ms`, `dash.grid.len` | step (> 0) and the number of points (1 … 4 194 304) |
| `dash.labels_part` | the part id of its `labels/1` part |
| `dash.result`, `dash.source` | `metric` … `virtual`; `pulsusdb` or `postgres` |
| `dash.unit`, `dash.planned` | optional: the unit, and the route's `planned` object byte for byte |

**Codes.**
- `phase`: 0 planned, 1 partial, 2 final.
- `exactness`: 0 raw-exact, 1 rollup, 2 sampled, 3 estimated, 4 unknown.
- `read_cache`: 0 hit, 1 miss, 2 bypass, 3 other.
- `error/1` `code`: 0 bad_query, 1 too_broad, 2 unauthorised, 3 forbidden_scope,
  4 upstream_unavailable, 5 timeout, 6 cancelled, 7 rate_limited, 8 internal.

## API

```go
w := arrowwire.NewWriter(body)                  // one Writer per response and tenant; DefaultLimits()
p, err := w.Grid(arrowwire.GridSpec{
	LabelsPart: 1, DataPart: 2, Grid: grid,     // pulsusdb.Grid (PromGrid)
	RequestedStartMs: from, Result: "metric", Source: "pulsusdb",
	Planned: plannedJSON,                       // optional
}, arrowwire.CoverageFrom(rs.Completeness(), arrowwire.PhasePlanned, 0))
for each series s { err = p.Add(s) }            // p.Flush() pushes a partial batch out early
err = p.Finish(arrowwire.CoverageFrom(rs.Completeness(), arrowwire.PhaseFinal, n))
// or, on an upstream error mid-stream: p.Fail(partialCoverage, arrowwire.ErrorRow{…})
err = w.Error(5, 0, row)                        // an error for a part that never opened
err = w.End()
```

### Frame order

L is the labels part and D the data part.

| Call | Frames |
|---|---|
| `Grid` | `SCHEMA(L)`, `META(D, planned)`, `SCHEMA(D)` |
| a full batch in `Add`, or `Flush` | `BATCH(L, the batch's label rows)`, then `BATCH(D)` |
| `Finish(c)` | the pending batch with `LAST` on its labels batch (or a 0-row `BATCH(L)\|LAST`), then `META(D, c)\|LAST` |
| `Fail(c, e)` | drops the pending series; 0-row `BATCH(L)\|LAST`, `META(D, c as partial)`, `ERROR(D, e)\|LAST` |
| `Error(part, rank, e)` | `ERROR(part, e)\|LAST` |
| `End` | `END` (part 0, rank 0, no flags) |

**Batches.**
- The first data batch holds one series, so the browser can draw it as soon as it arrives
  (T04-006).
- Later batches hold `clamp(⌊1 MiB / (8 · len)⌋, 1, 64)` series.
- A series' labels always go out in the labels batch before the first data batch that refers to
  it. Labels and data batches interleave.
- Every frame of both parts carries the spec's `Rank`, plus `FlagVolatile` when `Volatile` is set.

### Checks and errors

`Grid` and `Error` check their inputs before writing anything. A bad input is `ErrShape`; a call
past a wire limit is `ErrLimit` ([Limits](#limits)).
- **Part ids.** Every id is non-zero; 0 is END's and the stream-level ERROR's. A `Grid`'s labels
  and data ids differ. No id may be used twice in one body, whether its part is open or finished.
- **Grid** (`Grid` only).
  - `Step > 0` and `End ≥ Start`, and `End − Start` does not overflow.
  - `(End − Start)` is a multiple of `Step`.
  - The number of points `n = (End − Start)/Step + 1` is at most `MaxGridLen` = 2²². A
    one-series batch is then 32 MiB of values plus 512 KiB of validity, inside `MaxPayload`.
  - `Start ≤ RequestedStartMs < Start + Step`.

**Refusals.** Every refusal is explicit on the wire:

| Case | The writer writes | Then |
|---|---|---|
| `Grid` or `Error` refused (`ErrShape`, `ErrFrameTooLarge` for a frame over 64 MiB, or `ErrLimit` past `open_parts`, `distinct_parts` or the body budget) | one stream-level `ERROR(part 0)\|LAST`: code 8, status 500, message `writer refused` | every later `Grid` or `Error` returns `ErrOrder` and writes nothing. Open parts still close normally, and `End` still works |
| `Add` refused: a series whose `Values` or `Present` length is not the grid's (`ErrShape`), or whose labels batch, encoded alone, is larger than 64 MiB (`ErrFrameTooLarge`; the size is measured, so a labels frame of exactly 64 MiB is written); or a flush whose frame is too large | closes that part: 0-row `BATCH(L)\|LAST`, `META(D)` partial, `ERROR(D)\|LAST` with code 8 and message `writer refused: shape` or `writer refused: frame too large` | later calls on the part return `ErrOrder`. Other parts are unaffected |
| a limit crossed inside an open part (`ErrLimit`, [Limits](#limits)) | auto-closes that part: the pending series are dropped, then a 0-row `BATCH(L)\|LAST` and a final `META(D)\|LAST` with `truncated` and `truncation_reason` `wire_limit` or `wire_budget`; no ERROR | the part is closed for good: `Add`, `Flush`, `Finish` and `Fail` return `ErrLimit` and write nothing. Other parts are unaffected |
| `Fail` (or an `Add` close) whose coverage or error would make a frame over 64 MiB (reachable only with limits above the defaults: the [cut policy](#limits) keeps both far below it) | closes that part all the same: 0-row `BATCH(L)\|LAST`, a bounded `META(D)` (partial, `truncated`, `truncation_reason` cut to 64 B or `coverage_cut`, the four lists cut to 1 MiB and 4 096 elements in total), then `ERROR(D)\|LAST` with the original code, status, position and retry, and the message and suggestion cut to 1 MiB and 256 KiB (a cut ends in `…(truncated)`; when fewer than its 14 bytes remain the marker is omitted, so a cut never exceeds its budget) | returns `ErrFrameTooLarge`; the part is closed and other parts are unaffected |
| the `io.Writer` fails, or returns a short count (`io.ErrShortWrite`) | nothing more | the write error is sticky: every later call returns it and writes nothing. The body is cut mid-frame, so the caller must abort the transport (reset the connection) |

`ErrOrder` also means a caller bug: a call after `Finish`, `Fail` or `End`. `Finish` with a
planned-phase coverage returns `ErrShape` and writes nothing. A part counts as closed only once its
closing frames are written.

## Limits

One table of limits, in one file,
[`wire/schemas/limits.json`](../../wire/schemas/limits.json), bounds every body on both sides
(plan #68 B3,
[T04-010](../../designs/technical/T04-wire-format-and-data-plane.md#t04-010--decoders-bound-and-validate-everything)).
`DefaultLimits()` equals it, and so do the `dash-wire` reader's constants
([Chart engine](../client/engine.md#limits-and-budgets)); `unit:limits-json` checks both sides.
The writer enforces every limit first and turns each one it reaches into an explicit outcome, so
a body the writer produces never fails in the reader
([T04-012](../../designs/technical/T04-wire-format-and-data-plane.md#t04-012--every-part-carries-coverage), PRF-031: a cut is
`truncated` coverage, never silent).

| Key | Default | Writer | Reader |
|---|---|---|---|
| `max_payload` | 64 MiB | `ErrFrameTooLarge` | `PayloadTooLarge` |
| `max_chunk` | 128 MiB | — | a pushed chunk with a larger backing allocation fails the stream |
| `source_buffer` | 1 MiB | — | Part D's BYOB read buffer |
| `max_grid_len` | 2²² | `ErrShape` in `Grid` | `Schema` |
| `open_parts`, `distinct_parts` | 64, 1 024 (part 0 exempt) | `Grid` counts two parts, `Error` one; a call past either is refused with the stream-level ERROR (`ErrLimit`) | stream `Limit` |
| `rows_per_batch_labels`, `rows_per_batch_grid` | 1 048 576, 65 536 | labels batches are split between series; a single series with more label rows is refused in `Add` and the part auto-closes with `wire_limit`. Grid batches hold ≤ 64 series | part `Limit` |
| `series_per_part`, `label_rows_per_part`, `label_bytes_per_part` | 1 048 576, 4 194 304, 16 MiB | auto-close with `wire_limit` | part `Limit` |
| `meta_list_elements`, `meta_string_bytes` | 4 096, 1 MiB | the cut policy (below) | part `Limit` |
| `reason_bytes` | 64 | `truncation_reason` is always cut to it | — |
| `body_budget` | 64 MiB | the accounting below; auto-close with `wire_budget` | stream `Limit` |
| `value_budget` | 1 GiB | values and validity of every data batch; auto-close with `wire_budget` | stream `Limit` |
| `part_reserve` | 2 163 200 | kept free per open data part (its worst-case `Fail`) | — |
| `stream_reserve` | 1 048 832 | kept free for the stream-level ERROR | — |

`part_reserve` = one coverage of maximal strings and list elements plus one error of maximal
strings: 256 + `meta_string_bytes` + 16 × `meta_list_elements` + 256 + `meta_string_bytes`.
`stream_reserve` = 256 + `meta_string_bytes`. `wire/schemas/limits-test.json` is a small set
(the same keys) for the fixtures and tests only.

**Accounting.** Both sides count the bytes the reader creates, the same way, charged once and
never refunded:

| Item | Body budget | Value budget |
|---|---|---|
| a part | 256 | |
| a SCHEMA (the reader debits it before copying it, also when it then rejects it; the writer's are always accepted) | 256 + field names (children included) + metadata keys and values | |
| a series' label set | 96 + Σ(48 + key + value); a series without labels: 96 | |
| a data batch of `k` series of `n` points | 64 + 32 × `k` | 8 × `k` × `n` + 8 × ⌈`k` × `n` / 64⌉ |
| a coverage row | 256 + string bytes + 16 × list elements | |
| an error row | 256 + string bytes | |

**Admission.** `Grid` is admitted when its two parts fit `open_parts` and `distinct_parts`, and
its charge (two parts, both schemas, the planned coverage) fits the body budget with a
`part_reserve` for every open data part, its own included, and the `stream_reserve`. `Error`
counts one part and its row. A refused call consumes no part id.

**Auto-close.** Before each flush (in `Add`, `Flush` or `Finish`), the writer checks the
per-part limits, then the budgets with the reserves. If the batch would pass one, it drops the
pending series and closes the part with `wire_limit` or `wire_budget`; the closing coverage is
the planned one (or `Finish`'s) as final, with `series_returned` = the series sent. Closing
frames come out of the part's reserve, so `Finish` and `Fail` always fit.

**Cut policy** (every coverage: planned, final, partial, auto-close):
1. `truncation_reason` longer than 64 B is cut at a UTF-8 boundary to 50 B plus the 14-byte
   marker `…(truncated)`, and the coverage becomes `truncated`.
2. If the strings (reason included) would pass `meta_string_bytes`, or the list elements
   `meta_list_elements`: `truncated` is set; the reason is the coverage's own or `coverage_cut`;
   14 bytes are kept for the marker; the lists are filled in column order (`excluded_dims`,
   `warnings`, `infos`, `upstream_query_ids`) from what is left, the string that crosses it is
   cut with the marker, and later elements are dropped.
3. A cut is sticky for its part: every later coverage of the part is `truncated`, with its own
   reason or `coverage_cut`, so the part can never read as complete.

An error row whose message and suggestion pass `meta_string_bytes` is cut: the suggestion to at
most a quarter of it, then the message to the rest, each at a UTF-8 boundary ending with the
marker, so an explicit error always goes out.

**The stream-level ERROR.** A refused `Grid` or `Error` writes `ERROR(part 0)|LAST` (code 8,
`writer refused`) once per body, from the stream reserve. The reader then reports the body as
incomplete (`stream_error()` is `Some`), whatever its parts say.

`NewWriterLimits(w, l)` takes another set (tests use `limits-test.json`).

## Coverage

`CoverageFrom(c pulsusdb.Completeness, phase, seriesReturned)` fills `coverage/1` from what
PulsusDB's JSON reports (PRF-031):

| `coverage/1` | From |
|---|---|
| `truncated`, `warnings`, `infos` | `Truncated`, `Warnings`, `Infos` |
| `upstream_query_ids` | `[QueryID]`, or empty when there is none |
| `read_cache` | `hit`, `miss`, `bypass`, `other` → 0–3; absent → null |
| `read_cache_through`, `data_end` | `ReadCacheThroughMs`, `NewestSampleMs`; negative → null |
| `series_returned` | `seriesReturned` |
| `exactness` | 4 unknown. PulsusDB states exactness only under `X-Pulsus-Explain: 1`, which bypasses its read cache, so the BFF does not send it |
| all else | null or 0. `retention_floor` is set only when the BFF knows a floor; it knows none for PromQL today |

**Completeness** (T04 §5.3, the same rule as T22-006's `100 %`). A part is complete when its
last coverage is final, not truncated, has empty `warnings` and `excluded_dims`, has
`shards_failed`, `shards_skipped` and `dropped_count` null or 0, has `sampled_ratio` null or 1,
and has `retention_floor` null or at most `dash.grid.requested_start_ms`.
- A later floor makes the part *retention-limited*: the meter shows `limited by retention`
  (VIZ-027).
- The meter shows `100 %` when every part is complete.
- `✓ exact` additionally needs exactness 0 on every part. With exactness 4 the badge is
  `☁ server`.

The engine decides this with `Coverage::complete`, `retention_limited` and `exact` against the
part's `GridInfo.requested_start_ms`. The result stays provisional until the body's
`Verdict` ([Chart engine](../client/engine.md#end-of-input-and-the-verdict)).

## Reader

The engine reads these bodies with `dash-wire`'s own Arrow IPC reader, not arrow-rs. The reader
is described on the [Chart engine](../client/engine.md#wire-decoding-dash-wire) page. It accepts
exactly what this writer emits, so a writer change must stay inside these limits or ship
together with a reader change:

- **Messages.** Schema and RecordBatch messages with metadata version V5, little-endian. No
  DictionaryBatch, no dictionary-encoded field, no body compression, no variadic buffers.
- **Metadata.** No custom metadata on messages or fields, and no schema features.
- **Types.** `uint8/16/32/64` (unsigned), `float64`, `bool`, `utf8`, `timestamp_ms` in `"UTC"`,
  `list<utf8>` and `fixed_size_list<float64?>`.
- **Schemas.** Exactly the four v1 schemas, with their columns in order and their metadata keys,
  and no others. An added column is refused as `Unsupported("column")`
  ([T04-002](../../designs/technical/T04-wire-format-and-data-plane.md#t04-002--schema-identity-and-evolution)).
- **Layout.** The flatbuffer as `Builder.Finish` writes it: forward non-zero references, aligned,
  no overlapping objects, the minimal `L` and zero padding. Every buffer is 8-aligned, and every
  grid buffer 64-aligned, in body order and non-overlapping. Offsets start at 0. Every unused
  body byte is 0.
- **Frames.** Payload lengths are multiples of 8. Each SCHEMA and BATCH payload holds one
  message. Each META and ERROR payload holds the schema, one row and the EOS marker.

The committed fixtures pass every rule. `unit:codec-roundtrip` (Rust) decodes all five fixtures
to their `.expect.json`, so a writer change that breaks a rule fails on both sides.

## The range route

`gateway.serveRange` runs every step before the first byte as for JSON: the tenant, the body, the
grid, the plan, the upstream call and the first series read. Only then does `wantsArrow` choose
the format, so the tenant, scope, plan and upstream request are the same for both
([T06-029](../../designs/technical/T06-bff-architecture.md), ENT-006).

### Negotiation

| Request `Accept` | Response |
|---|---|
| absent, `application/json`, `*/*`, `application/*`, anything without the DSF type | JSON frames, byte for byte as before |
| lists `application/vnd.pulsus.dash-stream` (case-insensitive) with `q` > 0 and `v=1` or no `v` | `200`, `Content-Type: application/vnd.pulsus.dash-stream;v=1`, a DSF body |
| lists the DSF type only with another `v` (or `q=0`) | JSON frames |
| any error before the body (400, 404, 413, 422, 429, 502, 503, 504) | the JSON error envelope, whatever `Accept` says |

Every response of the route carries `Vary: Accept`, so a cache never serves one format for the
other; `Cache-Control: no-store` is unchanged.

### The body

One part pair: labels part 1 and data part 2, with `dash.result` `metric`, `dash.source`
`pulsusdb`, `dash.grid.requested_start_ms` the request's `from`, and `dash.planned` the planned
object's JSON bytes, the same bytes as the JSON body's `planned` member. The planned coverage
comes from the response headers' completeness (and the PromQL types warning).

- The first series is added and flushed alone, so the first batch reaches the browser while
  PulsusDB still sends the rest ([T04-006](../../designs/technical/T04-wire-format-and-data-plane.md)).
- Each later series is added as it is decoded; the writer's batch policy decides when a batch is
  written. One `flush()` (the 32 KiB `bufio.Writer`, then the response controller) runs after
  every add, so a committed batch never waits in the buffer.
- At the end, `Finish` writes the pending series and the final coverage: the completeness with
  the types warning first, `series_returned` the series written. With no series the part
  finishes empty (a 0-row labels batch, `series_returned` 0). Then END.

The coverage's `data_end` is the newest sample; the JSON body's `data_age_ms` (server time minus
it) is not carried. The client derives the age from `data_end` and the receipt time.

### Failures in band

A PulsusDB failure after the header ([T04-012](../../designs/technical/T04-wire-format-and-data-plane.md))
does not reset the connection, as the JSON path does. The part is closed with `Fail`: a partial
coverage from the completeness read so far (with the types warning), `series_returned` the series
already written (pending ones are dropped), and an `error/1` row. The error's position is mapped
to the raw text first (`mapPosition`, the same mapping as the envelope's; none inside a
rewrite). The server logs `msg=promql_stream_failed` with the kind; then END.

`apierr.Classify` is the one mapping of a data-call failure: `upstreamError` builds the envelope
from it and `arrowwire.ErrorFrom` the row, so a mid-stream row and the envelope of the same error
before the header agree:

| Failure | Envelope | `error/1` code, `http_status` | Row extras |
|---|---|---|---|
| PulsusDB rejected the query | 400 `invalid` | 0 `bad_query`, 400 | `position` (mapped) |
| reserved selector | 400 `virtual_unsupported` | 0 `bad_query`, 400 | |
| too broad | 422 `too_broad` | 1 `too_broad`, 422 | `suggestion` `narrow` |
| data scope | 403 `scope_denied` | 3 `forbidden_scope`, 403 | |
| rate limited, no tenant slot | 429 `budget_exhausted` | 7 `rate_limited`, 429 | `retry_after_ms` (`Retry-After` × 1 000; 1 000 for the tenant slot) |
| timeout, deadline | 504 `unavailable` | 5 `timeout`, 504 | `suggestion` `narrow` |
| unreachable, unavailable, credentials refused, protocol | 502 `unavailable` | 4 `upstream_unavailable`, 502 | |
| datasource misconfigured | 503 `unavailable` | 4 `upstream_unavailable`, 503 | |
| anything else | 500 `internal` | 8 `internal`, 500, `internal error` | |

The row's message is the envelope's. A cancel (code 6) is never written: the browser is gone.

### Writer outcomes

The handler checks `Writer.Err()` (the sticky I/O error) after every writer call, then:

| Outcome | Already in the body | Handler |
|---|---|---|
| `Grid` refused (`ErrLimit`, `ErrShape`, `ErrFrameTooLarge`) | the stream-level ERROR | END, flush; the body decodes through END |
| `Add`/`Flush` `ErrLimit` | the part's auto-close coverage (`wire_limit`, `wire_budget`) | stops reading PulsusDB; END, flush |
| `Add`/`Flush` `ErrShape`, `ErrFrameTooLarge` | the part's close (`writer refused: …`) | stops reading; END, flush; logs `promql_stream_refused` |
| `ErrOrder` (a bug) | | END, flush; logs `promql_stream_order` at error |
| sticky I/O error, or a failed flush | unknown | stops; no END, no flush; logs `promql_stream_write_failed` |
| the browser went away | | stops; nothing more is written; the deferred close ends the upstream request |

Memory per response is the writer's pending batch (bounded by `limits.json`) and the 32 KiB
buffer. `Finish` and `Fail` set `series_returned` themselves from the series they commit; the
caller's value is ignored.

### Route fixtures and parity

[`wire/fixtures/route/`](../../wire/fixtures/route/) holds what the real handler writes over a
`pulsusfake` upstream with the clock at 2026-11-19T13:00Z (`TestRouteFixtures`, regenerate with
`go test ./internal/gateway -run TestRouteFixtures -args -update`):

| Case | Files | What it holds |
|---|---|---|
| `two-series`, `gaps`, `empty`, `types-warning`, `read-cache`, `future-sample`, `many` | `.dsf` and `.json` | two 61-point series; NaN, ±Inf, −0 and absent points; no series; a failed metric-types lookup (the warning in both); a read-cache hit; a sample after the clock (age 0); 600 series across the batch policy |
| `mid-failure-<class>` | `.dsf` | a failure of the class after the first series (`query-invalid`, `too-broad`, `rate-limited`, `timeout`, `unavailable`, `internal`) |
| `err-<class>` | `.json` | the same failure before the header: `{"status", "retry_after", "body"}`, the body the envelope the handler wrote |
| `limits-many`, `refused-open-parts` | `.dsf` | `many` under `limits-test.json` (auto-close `wire_limit`), and a `Grid` refused with `open_parts` 0 |

There is no `mid-failure-*.json`: the JSON path resets the connection on that failure.
`route_parity` (`engine/crates/dash-wire/tests/route_parity.rs`) decodes each `.dsf` with
`dash-wire` and compares it with its `.json` field by field: `planned` byte for byte; `start`,
`step` and `end` from the grid; series order, key, labels, absent ↔ null, values bit for bit
(NaN by class); `truncated`, `warnings`, `infos`, `query_id`, `read_cache`,
`read_cache_through_ms`; `series_returned` = the series decoded; and `data_age_ms` =
max(0, clock − `data_end`), omitted when `data_end` is null. For each class it checks the row
against the envelope by the table above.

## Golden fixtures

[`wire/fixtures/arrow/`](../../wire/fixtures/arrow/) holds DSF bodies (`*.dsf`, marked binary
in `.gitattributes`). Each has an `.expect.json` built from the writer's inputs, not from its
output. B2's Rust reader decodes the same files to the same expectations. The five B1 fixtures:

| Fixture | What it holds |
|---|---|
| `promql-range-counter` | The counter query against the strict PulsusDB fake, with the planned JSON of `wire/fixtures/json/promql-range-counter.json`. It carries 0.1, NaN, ±Inf, absent, −0, 5e-324 and 1e308. Its coverage is complete but not exact |
| `grid-batches` | 70 × 4 synthetic series in batches 1, 64 and 5. Series 0 has no labels and series 1 has UTF-8 labels. It has NaN payloads, a requested start after the aligned start, `FlagVolatile`, rank 1 and unit `bytes`. Its final coverage is truncated with reason `limit` |
| `grid-error` | Parts 3/4 failed after one sent and one pending series (`too_broad`, 422, with a suggestion), then `ERROR(5)` for a part that never opened (`bad_query`, 400, position 7) |
| `grid-empty` | A part pair finished without series |
| `part-ids` | Parts 1/2 and 3/4 open together, both finished, then `ERROR(5)` and END: a valid body with no stream-level ERROR |

The limits fixtures are written with `limits-test.json` (`distinct_parts` 8 allows four part
pairs per body, so the cases are spread over several bodies). Their boundaries are derived with
the writer's accounting, not hand-picked:

| Fixture | What it holds |
|---|---|
| `limits-budget` | Four one-series part pairs whose schemas carry a derived `dash.planned` padding: three fit the body budget, the fourth series is past it (`wire_budget`) |
| `budget-over` | The same input with the writer's budget checks off (a test knob): the reader fails it with `Limit` |
| `limits-value` | One-series grids of a derived length: three fit `value_budget`, the fourth auto-closes (`wire_budget`) |
| `limits-open-parts` | 1/2 and 3/4 open, `Grid(5, 6)` refused (stream-level ERROR); 1–4 still close normally |
| `limits-distinct-parts` | Four part pairs in turn (8 ids), `Grid(9, 10)` refused |
| `limits-refused` | 1/2, `Error(3)`, 4/5 and 6/7 (7 ids), then `Grid(8, 9)` refused |
| `limits-series` | 1/2 at every per-part limit (100 series, 300 label rows, 4 096 label bytes, a 50-row series, a 25 + 25 + 1-row batch split into two labels batches); 3/4, 5/6 and 7/8 one past each (`wire_limit`) |
| `limits-rows` | A single 51-row series: refused in `Add`, the part auto-closes (`wire_limit`) |
| `limits-strings` | The cut policy: 20 warnings, 1 025 B (cut inside `é`), exactly 1 024 B (unchanged), a 100-B reason, 20 `excluded_dims`, and a cut planned coverage that keeps the clean final `truncated` |
| `limits-errors` | `Error` with a 1 024-B message (unchanged) and with 1 100 B + a 300-B suggestion (cut to 768 B and 256 B) |
| `limits-fail` | A part filled until the body budget leaves exactly its reserves, then `Fail` with maximal strings: the body ends at `body_budget` − `stream_reserve` |

`TestFixtures` (`unit:codec-roundtrip`, Go side) rebuilds every fixture and compares the bytes.
It then reads the committed bytes back with arrow-go, compares them to `.expect.json`, and checks
that null slots hold the canonical NaN. After a deliberate change to the writer or a schema,
regenerate the fixtures from `server/`:

```bash
go test ./internal/arrowwire -run TestFixtures -update
```

Review the diff of both the `.dsf` and the `.expect.json` files. A change to the bytes is a wire
change that B2's reader must accept too.

## Tests and gates

| Gate | Test | Checks |
|---|---|---|
| `unit:codec-roundtrip` (Go) | `TestFixtures` | bytes = the committed fixtures; the arrow-go read-back = `.expect.json` |
| `unit:schema-yaml` | `TestSchemaYAML` | `wire/schemas/*.yaml` = the writer's schemas: names, order, types, nullability, metadata, the `dash.grid.len` maximum, and no dictionaries |
| `unit:json-arrow-prop` | `TestJSONArrowProp` | 200 seeded PulsusDB matrix bodies through `Client.QueryRange` and a `GridPart`; the read-back is bit for bit the decoded series |
| `unit:dsf-writer-order` | `TestWriterOrder`, `TestWriterBadSpecs`, `TestWriterBoundaryGrid`, `TestWriterAddRefusals` | the frame sequence and batch sizes, the refusal contract, and the 2²²-point grid |
| `unit:part-ids` | `TestPartIDs` | zero, equal and reused ids are refused with the stream-level ERROR |
| `unit:dsf-header` (Go) | `TestHeader` | the header bytes, and the rejected headers |
| `unit:arrow-alignment` (Go) | `TestAlignment` | 64-byte bodies and grid buffers, and 8-byte frame lengths |
| `unit:dsf-writer-order` (failure paths) | `TestFailOversized`, `TestStickyWriteError`, `TestLabelsAtPayloadLimit`, `TestCutUTF8` | an oversized `Fail` still closes its part with a bounded META and the upstream code (with limits above the defaults); write errors and short writes are sticky and stop all writing |
| `unit:limits-json` (Go) | `TestLimitsJSON` | `DefaultLimits`, `MaxGridLen`, `MaxPayload` and the costs = `limits.json`; both files' reserves follow their formula |
| `unit:wire-limits` | `TestWireLimits`, the limits fixtures in `TestFixtures` | labels batches split between series; a too-long series refused; error and coverage cuts; `distinct_parts` with `Error`; the derived budget boundaries and the writer's `used` |
| `unit:coverage-complete` (Go) | `TestCoverageFrom` | the `CoverageFrom` mapping, and the committed `series_returned` in the encoded row |
| range route (gateway) | `TestRangeNegotiation`, `TestRangeArrowBody`, `TestRangeArrowEmpty`, `TestRangeArrowFailure`, `TestRangeArrowFinishPending`, `TestRangeArrowPosition`, `TestRangeArrowOutcomes`, `TestRangeArrowCancel`, `TestRangeArrowLimits`, `TestRangeJSONMidFailure`, `TestRangeDSFScopeDenied` | negotiation and `Vary`; a restricted, empty or unset data scope denied with DSF as with JSON, no upstream query; the first batch before the rest; failures in band; the counts; the outcome table; cancel and limits; the JSON reset unchanged |
| error classes | `TestClassify` (`internal/apierr`) | every row of the mapping, envelope and `error/1` |
| route parity | `TestRouteFixtures`, `route_parity` (Rust) | the committed route fixtures = the handler's output; the DSF bodies carry what the JSON bodies carry |
| `bench:json-to-arrow` (report-only) | `BenchmarkRangeBody` | the `many` body as JSON and as DSF |
| `ci:go-lint` (depguard `arrow-only`) | `check-depguard-fixture.sh` | arrow-go is imported only in `internal/arrowwire` |

## Dependencies

`github.com/apache/arrow-go/v18` v18.9.0 (Apache-2.0) is used only in this package, through
`arrow`, `arrow/array`, `arrow/ipc` and `arrow/memory`. No body compression is used.

The version is pinned exactly, because the 64-byte column rule depends on arrow-go keeping buffers
that are already padded to 64 bytes. A later version that re-slices them turns
`unit:arrow-alignment` red.

The pin raises `github.com/zeebo/xxh3` to v1.1.0. `unit:keyhash-corpus` holds the series keys
stable.
