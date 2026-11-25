# Arrow wire writer (`internal/arrowwire`)

`server/internal/arrowwire` turns the series the BFF decodes from PulsusDB's JSON into Arrow IPC
messages framed as Dash Stream Frames (DSF). PulsusDB answers only in JSON, so the BFF converts
them. This is the committed path; it needs nothing from PulsusDB
([ADR-0005](../../designs/adr/0005-arrow-wire-format.md)). The browser's chart engine reads the
result with its own Arrow IPC reader, which is #68 Part B2.

No route uses the writer yet. Part D of #68 serves it on the query routes when the request's
`Accept` is `application/vnd.pulsus.dash-stream;v=1` (`arrowwire.ContentType`). Until then the
routes answer with JSON frames ([the PulsusDB page](pulsusdb.md)).

Design: [T04 §4.2–§5.3](../../designs/technical/T04-wire-format-and-data-plane.md) (schemas, DSF,
coverage), [ADR-0015](../../designs/adr/0015-go-bff.md) (arrow-go, `wire/schemas`,
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
w := arrowwire.NewWriter(body)                  // one Writer per response and tenant
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

`Grid` and `Error` check their inputs before writing anything. Any failure is `ErrShape`.
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
| `Grid` or `Error` refused (`ErrShape`, or `ErrFrameTooLarge` for a frame over 64 MiB) | one stream-level `ERROR(part 0)\|LAST`: code 8, status 500, message `writer refused` | every later `Grid` or `Error` returns `ErrOrder` and writes nothing. Open parts still close normally, and `End` still works |
| `Add` refused: a series whose `Values` or `Present` length is not the grid's (`ErrShape`), or whose labels cannot fit one 64 MiB frame (`ErrFrameTooLarge`); or a flush whose frame is too large | closes that part: 0-row `BATCH(L)\|LAST`, `META(D)` partial, `ERROR(D)\|LAST` with code 8 and message `writer refused: shape` or `writer refused: frame too large` | later calls on the part return `ErrOrder`. Other parts are unaffected |
| the `io.Writer` fails | nothing more | the write error is sticky. The body is cut mid-frame, so the caller must abort the transport (reset the connection) |

`ErrOrder` also means a caller bug: a call after `Finish`, `Fail` or `End`. `Finish` with a
planned-phase coverage returns `ErrShape` and writes nothing.

The shared wire limits (the per-part and per-body budgets, coverage and error-string cuts, and
the writer's auto-close) arrive with #68 Part B3. B1 bounds only `MaxPayload`, `MaxGridLen`, the
grid and the part ids.

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

The browser's decoder makes this decision (Part B2).

## Golden fixtures

[`wire/fixtures/arrow/`](../../wire/fixtures/arrow/) holds five DSF bodies (`*.dsf`, marked
binary in `.gitattributes`). Each has an `.expect.json` built from the writer's inputs, not from
its output. B2's Rust reader decodes the same files to the same expectations.

| Fixture | What it holds |
|---|---|
| `promql-range-counter` | The counter query against the strict PulsusDB fake, with the planned JSON of `wire/fixtures/json/promql-range-counter.json`. It carries 0.1, NaN, ±Inf, absent, −0, 5e-324 and 1e308. Its coverage is complete but not exact |
| `grid-batches` | 70 × 4 synthetic series in batches 1, 64 and 5. Series 0 has no labels and series 1 has UTF-8 labels. It has NaN payloads, a requested start after the aligned start, `FlagVolatile`, rank 1 and unit `bytes`. Its final coverage is truncated with reason `limit` |
| `grid-error` | Parts 3/4 failed after one sent and one pending series (`too_broad`, 422, with a suggestion), then `ERROR(5)` for a part that never opened (`bad_query`, 400, position 7) |
| `grid-empty` | A part pair finished without series |
| `part-ids` | Parts 1/2 and 3/4 open together, both finished, then `ERROR(5)` and END: a valid body with no stream-level ERROR |

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
| `unit:coverage-complete` (Go) | `TestCoverageFrom` | the `CoverageFrom` mapping, and `series_returned` in the encoded row |
| `ci:go-lint` (depguard `arrow-only`) | `check-depguard-fixture.sh` | arrow-go is imported only in `internal/arrowwire` |

## Dependencies

`github.com/apache/arrow-go/v18` v18.9.0 (Apache-2.0) is used only in this package, through
`arrow`, `arrow/array`, `arrow/ipc` and `arrow/memory`. No body compression is used.

The version is pinned exactly, because the 64-byte column rule depends on arrow-go keeping buffers
that are already padded to 64 bytes. A later version that re-slices them turns
`unit:arrow-alignment` red.

The pin raises `github.com/zeebo/xxh3` to v1.1.0. `unit:keyhash-corpus` holds the series keys
stable.
