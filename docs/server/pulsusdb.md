# PulsusDB client and the query routes

The BFF reads telemetry from PulsusDB through one package, `server/internal/pulsusdb`
([T06-005](../../designs/technical/T06-bff-architecture.md)). The gateway serves its results to
the browser as JSON frames: the PromQL range and instant routes, the [LogQL routes](#logql-routes)
(log pages, metric results and volume), the editor-completion routes and the data-source check. Every call runs for the active tenant binding under the fixed local
principal (decision D12) with the full-tenant data scope ([T06-002](../../designs/technical/T06-bff-architecture.md)).

```
browser ──HTTP──► gateway (routes, validation, deadlines, frames) ──► pulsusdb.Client ──HTTP──► PulsusDB
                        │                                              │
                        └─ tenant slug → binding (Postgres, under RLS) ┘
```

Only `internal/pulsusdb` makes outbound HTTP requests. The lint rule `pulsusdb-only` (forbidigo in
`server/.golangci.yml`) fails a build that constructs an HTTP client or request anywhere else; the
public-URL self-check (`internal/gateway/selfcheck.go`) and its client in `cmd/pulsus-dash/serve.go`
are the allowed exceptions (T19-002). The self-test fixture `http_client_outside_pulsusdb.go.txt`
proves the rule fires ([build and CI](../development/build-and-ci.md#make-targets)).

## Routes

| Route | Body or parameters | 200 body | Deadline |
|---|---|---|---|
| `POST /api/dash/v1/query/promql/range?tenant=<slug>` | `{"query", "from", "to", "width_px", "timeout_ms"?, "vars"?, "rate"?}` (ms since the epoch; `query` is the raw text) | `PromRangeResponse`, streamed, `planned` first | `timeout_ms`: 200 to 120 000, default 30 000 |
| `POST /api/dash/v1/query/promql/instant?tenant=<slug>` | `{"query", "at", "timeout_ms"?, "vars"?, "step_ms"?}` | `PromInstantResponse`, `planned` first | as above |
| `GET /api/dash/v1/prom/labels` | `tenant`, `from`, `to`, `match` (repeatable), `limit` (1 to 10 000, default 1 000) | `PromValuesResponse` | 10 s |
| `GET /api/dash/v1/prom/label/{name}/values` | `name` (1 to 256 bytes), as above | `PromValuesResponse` | 10 s |
| `GET /api/dash/v1/prom/series` | as labels; at least one `match` | `PromSeriesResponse` | 10 s |
| `GET /api/dash/v1/prom/metadata` | `tenant`, `metric` (optional), `limit` | `PromMetadataResponse` | 10 s |
| `POST /api/dash/v1/query/logql/range?tenant=<slug>` | `{"query", "from", "to", "width_px", "limit"?, "direction"?, "cursor"?, "timeout_ms"?, "vars"?}` (`query` is the raw text) | `LogqlRangeResponse`: a log page (`kind: streams`) or frames streamed on the grid (`kind: series`), `planned` after `kind` | `timeout_ms`, shared by every upstream request of the page |
| `POST /api/dash/v1/query/logql/volume?tenant=<slug>` | `{"query", "from", "to", "width_px", "timeout_ms"?, "vars"?}` | `LogqlVolumeResponse`, `planned` first, one frame per level | `timeout_ms` |
| `GET /api/dash/v1/logs/labels` | `tenant`, `from`, `to`, `query` (optional, at most 65 536 bytes), `limit` | `PromValuesResponse` | 10 s |
| `GET /api/dash/v1/logs/label/{name}/values` | `name` (1 to 256 bytes), as above | `PromValuesResponse` | 10 s |
| `GET /api/dash/v1/logs/series` | `tenant`, `from`, `to`, `match` (repeatable, at least one), `limit` | `PromSeriesResponse` | 10 s |
| `GET /api/dash/v1/datasource/check` | `tenant` | `DatasourceStatus` | 5 s |

The schemas are in `api/openapi.yaml`. Every operation declares `x-permission: query.read`, the
T06-023 declaration that M-UI6 will check, and the required `tenant` parameter
(`^[a-z0-9-]{1,40}$`). The four POST routes are hand-written so that they can stream or write
their own body; the eight GET routes are generated strict handlers. A parameter the generated code cannot bind (missing, or not
an integer) is answered with its field error (`field.required` or `field.type`, `tenant.invalid`
for the tenant) by the gateway's request error handler.

The tenant slug is resolved among the bootstrap organisation's bindings, read under row-level
security through the same call as the bootstrap ([T06-006](../../designs/technical/T06-bff-architecture.md)).
An unknown slug is 404 `not_found` `unknown tenant`; a store failure is 503 `unavailable`
`configuration store unavailable`. Resolution runs under the route's deadline: if the deadline
passes first the answer is 504 `upstream_timeout`, and if the browser went away nothing is
written (the access log records 499).

## Query planning ([ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md))

The PromQL routes and the LogQL range and volume routes take the text the user wrote and plan it
on the server: the browser never builds the query that is sent (T06-029). Each language has its
module (ADR-0018): `prom.Plan` in `server/internal/pulsusdb/prom` and `logs.Plan` in
`server/internal/pulsusdb/logs` ([LogQL planning](#logql-planning)). Each is a pure function in
two halves: `Prepare` checks the inputs, substitutes the variables and classifies the result;
after the route resolves the step, `Prepared.Plan` applies the step macros, the language's
rewrites (PromQL's rate rewrites, LogQL's volume template) and the size limit. The routes call
them today; the alert evaluator will call the same functions with a rule's stored step. The
subsections below up to [Fixtures](#fixtures) describe the PromQL module.

### Inputs and limits

| Input | Limit | Notes |
|---|---|---|
| `query` | 1 to 131 072 UTF-8 bytes | the raw text; JSON Schema `maxLength` counts characters, the server counts bytes |
| `vars` | at most 64 names, each `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; each value at most 4 096 bytes | names checked in byte order |
| `rate` (range) | boolean, default `true` | the rate chip |
| `step_ms` (instant) | 1 000 to 86 400 000 | the step of `$__interval`, `$__rate_interval` and the rate rewrite; without it an instant query is not rated |
| substituted text | 2 MiB (2 097 152 bytes, the request-body limit) | the processing cap, counted before the text is built: in `Prepare` with the placeholder macros, and again in `Plan` with the macros at the resolved step (a `1500ms` is longer than the `1s` placeholder) |
| planned text | 65 536 bytes | checked on the final planned text only |

The raw text may be up to 128 KB because the planned text, not the raw text, is what has to fit
in 64 KiB: a long comment before a bare counter is sent as `rate(x_total[1m])`. A raw text between
64 and 128 KiB whose plan stays that long is accepted, planned, and then refused with 413. The
processing cap is a deliberate, bounded exception: a substituted text over 2 MiB is refused even
when a rewrite would shrink it.

### The rules, in order

1. **Substitution.** The raw bytes are scanned once, left to right, by the lexical states of the
   upstream PromQL lexer (`promql/parser/lex.go`):

   | State | Byte | Next |
   |---|---|---|
   | none | `"` / `'` / `` ` `` / `#` | in `"…"` / in `'…'` / in `` `…` `` / in a comment |
   | `"…"`, `'…'` | `\` | skip it and the next byte (a `$` there is not a reference) |
   | `"…"` | `"` or LF | none |
   | `'…'` | `'` or LF | none |
   | `` `…` `` | `` ` `` | none |
   | comment | LF or CR | none |

   A reference is `$NAME` or `${NAME}` with `NAME = [A-Za-z_][A-Za-z0-9_]*`. It is read in every
   state, except where a backslash skipped it. A reference in a comment is substituted, so
   `up # $r` still needs `$r`. Values are not rescanned, so a quote or a `#` in a value never
   changes the state.

   | Reference | Becomes |
   |---|---|
   | `$__interval` | the step, as a duration (`30s` at 30 000 ms) |
   | `$__rate_interval` | the rate window of the step (below) |
   | any other `$__…`, or a name longer than 64 | itself, unchanged |
   | a name in `vars`, inside `"…"` or `'…'` | the value, encoded by the table below |
   | a name in `vars`, inside `` `…` `` | the value verbatim; a backtick, a CR or U+FFFD in it is refused (row 7b) |
   | a name in `vars`, inside a comment | the value verbatim; an LF or a CR in it is refused (row 7b) |
   | a name in `vars`, outside strings and comments | the value verbatim: it is query text by intent (`$q` with `q=sum(x)`) |
   | a name not in `vars` | itself; the plan is refused with `variable.missing` |

   A value written into a string opened by `"` or `'` is encoded so that the upstream parser reads
   it back as itself:

   | Byte or rune of the value | In `"…"` | In `'…'` |
   |---|---|---|
   | the string's own quote | `\"` | `\'` |
   | the other quote | `'` | `"` |
   | `\` | `\\` | `\\` |
   | 0x07, 0x08, 0x0C, 0x0A, 0x0D, 0x09, 0x0B | `\a`, `\b`, `\f`, `\n`, `\r`, `\t`, `\v` | the same |
   | any other byte 0x00–0x1F, and 0x7F | `\x` and two lowercase hex digits (`\x01`, `\x7f`) | the same |
   | any other ASCII byte | itself | itself |
   | U+FFFD | `\ufffd` | `\ufffd` |
   | any other non-ASCII rune | itself, its bytes unchanged | the same |

   Only the string's own quote is escaped: the upstream lexer accepts `\` followed by the opening
   quote only, so `\"` inside `'…'` is an unknown escape. For a value of ASCII only, the `"…"`
   column is Go's `strconv.Quote` without its quotes. The two recorded deviations from
   `strconv.Quote`:
   - a non-ASCII rune that `strconv.IsPrint` rejects (U+00A0, U+2028) is written as itself;
   - U+FFFD is written `\ufffd`, because the upstream lexer refuses a literal U+FFFD in a string.

   `FuzzEncodeQuoted` checks that the upstream `strutil.Unquote` gives back every valid UTF-8
   value in both forms, and `FuzzValueRoundTrip` that the planned text parses to a matcher with the
   value, or is refused.

   **Row 7b.** A value that cannot be written where it is referenced is refused before any I/O
   (before tenant resolution, the metric-types read and any upstream request). That is a
   backtick, a CR or U+FFFD inside a `` `…` `` string (a backtick would end it, Go's raw-string
   unquote drops a CR, and the upstream lexer refuses U+FFFD), or an LF or a CR inside a comment
   (either would end it). A step macro's text is a duration and is never checked. Missing
   variables (row 7) are reported first, and row 7b comes before the `step_ms` row.

   `Prepare` substitutes every macro as the placeholder `1s`, so the selectors are known before
   the step is.
2. **Shape.** The substituted text is parsed with the upstream PromQL parser
   (`github.com/prometheus/prometheus/promql/parser`): its top-level bare selector (a metric name
   with no offset, `@`, `anchored` or `smoothed`), every metric name, whether it calls
   `histogram_quantile`, and its value type. Any parse or type error gives the unknown shape; a
   parse failure never fails the plan.
3. **Rewrites**, behind `rate` (and only with a step):

   | Shape | Sent |
   |---|---|
   | bare selector of a histogram bucket (`…_bucket` whose type is histogram or unknown) | `sum by (le) (rate(<selector>[w]))`, histogram |
   | bare selector of a counter (type counter, or a name ending in `_total`) | `rate(<selector>[w])` |
   | anything else | as is; histogram when a `…_bucket` metric is read without `histogram_quantile` |

   A wrap sends the selector's exact bytes; bytes outside it (leading comments and blanks) are
   dropped. With `rate: false`, or an instant query without `step_ms`, a candidate is sent as is
   and reported as a candidate. The window is `w = max(4 × step, step + S, 4 × S)` with the scrape
   interval `S` = 15 s until a per-binding one exists, written as the largest of `d`, `h`, `m`, `s`
   that divides it: 5 s gives `1m`, 30 s gives `2m`, 60 s gives `4m`, 1 h gives `4h`, 45 s gives
   `3m`.
4. **Size.** A planned text over 65 536 bytes is refused with 413 and the full plan.

### What `planned` says

Both 200 bodies start with `planned` (`PlannedQuery`), and every error raised after planning
carries it too:

| Member | Meaning | The client |
|---|---|---|
| `query`, `bytes` | the text sent and its length | Explore's "Sent query" when it differs from the text run |
| `expanded` | the substituted text before the rewrite | Open in Explore (#64) |
| `value_type` | the shape's type | — |
| `rate_candidate`, `rate_applied` | the rewrite could apply, and did | the Rate applied chip; the `/s` unit |
| `histogram` | the result is histogram buckets | auto-vis rule 5 (heatmap) and rule 6 |
| `step_ms`, `rate_window_ms` | the step planned at; the window of an applied rewrite | — |

### Refusals

The first refusal wins, in this order. Pointers escape `~` as `~0` and `/` as `~1`.

| Condition | Status | `fields` (pointer, key) | Message |
|---|---|---|---|
| `query` not UTF-8 (the body check) | 400 | `/query`, `field.range` | `query must be UTF-8` |
| `query` empty or over 131 072 bytes | 400 | `/query`, `field.range` | `query must be 1 to 131072 bytes` |
| more than 64 `vars` | 400 | `/vars`, `field.range` | `vars must have at most 64 entries` |
| a bad variable name | 400 | `/vars/<name>`, `field.pattern` | `a variable name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$` |
| a value over 4 096 bytes | 400 | `/vars/<name>`, `field.range` | `a variable value must be UTF-8 and at most 4096 bytes` |
| referenced variables without a value | 400 | one `/vars/<name>`, `variable.missing` per name, first reference first | `no value for variable $a, $b` |
| a referenced value that cannot be written where it is referenced | 400 | one `/vars/<name>`, `variable.unrepresentable` per name, first reference first | `the value of variable $a, $b cannot be written where it is referenced` |
| a macro in an instant query without `step_ms` | 400 | `/step_ms`, `field.required` | `step_ms is required for $__interval and $__rate_interval` |
| the substituted text over 2 MiB | 413 | `/query`, `query.too_large_to_plan` | `the substituted query is over 2097152 bytes, the most the server processes`; `hint.reason: processing_cap`, no `planned` |
| LogQL only (row 9b): a `#` outside strings in the substituted or the planned text | 400 | `/query`, `query.invalid` | `unexpected '#' at byte <N>: LogQL has no comments`; `hint.position.offset` is N, the `#` in the raw text; no `planned` ([below](#row-9b-a-top-level--is-refused)) |
| the planned text over 65 536 bytes | 413 | `/query`, `query.sent_too_large` | `the planned query is over 65536 bytes`; the full `planned` (`bytes` is `len(planned.query)`) |

Every planning refusal has `code: invalid`. A reserved selector is 400 `virtual_unsupported`
([below](#reserved-selectors-t07-0-t07-020-v1)).

### Positions

PulsusDB's error position is a byte offset into the sent text. The server maps it back to the raw
text through two segment maps (sent → substituted → raw), so `hint.position.offset` is always an
offset into what the user wrote ([T09-009](../../designs/technical/T09-query-editors.md)):

1. a byte copied from the raw text maps to itself; every byte of a substituted value maps to the
   start of its reference (`$r`);
2. the end of the whole text maps to the end of the raw text, when the text ends with copied or
   substituted bytes;
3. anything else has no position: every byte of a rewrite's prefix or suffix, its first byte
   included, and offsets out of range.

So for `x_total{job="a"}` sent as `rate(x_total{job="a"}[1m])`, PulsusDB's offset 19 is raw
offset 14; for `up{job="$r"}` with `r=ab`, offset 9 (inside the value) is 8, the start of `$r`; an
offset in `[1m])` has no position and the client underlines the whole text.

### Route order and security ([T06-029](../../designs/technical/T06-bff-architecture.md), T07-020)

| Step | What | On failure |
|---|---|---|
| 1 | the body: required members and ranges | 400 |
| 2 | range: the grid (`width_px` and the window) | 400 `range.too_long` |
| 3 | `Prepare` | the refusals above; nothing has been read |
| 4 | Classify, then the byte guard on the substituted text | 400 `virtual_unsupported`; no upstream request |
| 4b | resolve the step: `FloorStep(base step, floor)`; `CheckCap`: the processing cap with the macros at that step | 413 `processing_cap`; nothing has been read |
| 5 | the route deadline; tenant resolution | as before |
| 6 | metric types, only when the plan depends on them | never fails the request (below) |
| 7 | `Plan` | 413 with `planned` |
| 8 | the byte guard on the planned text (the authoritative check) | 400 `virtual_unsupported` with `planned` |
| 9 | the data scope (the full tenant, D12) | 403 `scope_denied` with `planned` |
| 10 | send `planned.query` | the upstream errors, with `planned` and the mapped position |

No step logs the raw text, the planned text or a variable value.

### Metric types

Whether a bare selector is a counter or a histogram depends on its type, which comes from
PulsusDB's metadata route. `Prepared.NeedsTypes` is true only when the answer can change the plan:
a bare selector whose name does not end in `_total`, or no bare selector, no `histogram_quantile`
and a `…_bucket` metric. `x_total`, `rate(x[5m])` and every refusal read no metadata.

`prom.TypesCache` holds one entry per tenant binding (organisation and binding ID): a read lasts
60 s, a failure is held 5 s, concurrent misses share one fetch (singleflight), and the fetch runs
on with its own 10 s timeout when a caller leaves. A plan waits at most 2 s; after that, or on a
failure, it plans without types (only names ending in `_total` are rated) and puts
`pulsus-dash: metric types unavailable, so only names ending in _total are rated (metric_types_unavailable)`
first in `completeness.warnings`. The fetch logs `metric_types_unavailable` at `warn` with the
binding slug and the error kind. One read asks for at most 10 000 metrics: a name past that has no
type, so only the `_total` rule rates it.

### Classify and the binding order ([T07 §4.1](../../designs/technical/T07-scene-query-planner.md), §4.3)

`Prepare` classifies the substituted text (T07 §4.1 step 1a) before the step is resolved: the
metric names among `ALERTS`, `ALERTS_FOR_STATE` (step floor 15 000 ms) and `pulsus_anomaly_score`
(300 000 ms) are reserved; the source is `virtual` when every name is reserved, `mixed` when some
are, else `pulsus_db`. The floor is the largest of theirs, and `FloorStep(step, floor)` is the
least multiple of the floor at least the step. Because variables are substituted before Classify
and only the step macros wait, a reserved name a variable introduces is found (`$m` with
`m=ALERTS` is `virtual`). In v1 nothing resolves to a virtual source, so the routes refuse any
query that is not `pulsus_db` before any I/O; selectors without a metric name and unparsable text
are left to the byte guard.

The binding order is the contract for the scene planner's Bind too (T07 §4.1): templates and
`{{entity}}` bindings are expanded, then the variables substituted, before Classify; only the step
macros wait for Resolve. v1 has no templates, so the fixture's classify group (V1–V5) proves the
order with variable values; the issue that implements scene Bind owes the gate
`unit:bind-classify-template` (a template binding `pulsus_anomaly_score{service="checkout",signal="latency"}`,
6 h at 1 600 px: `virtual`, floor 300 000 ms, final step 300 000 ms, `Plan` called with it).

**LogQL.** `logs.Prepare` (#116) substitutes, then classifies the stream selectors with the
in-house selector reader (not a parser) before the step is resolved; only the equality matcher
`source="pulsus-dash"` is reserved, and the routes refuse a `virtual` or `mixed` query before any
I/O, then run the T07-020 byte guard on the same text. LogQL reserved selectors have no step floor
(T07 §4.3), so Resolve is the identity. The binding order is the same: variables are substituted
before Classify, so `{source="$s"}` with `s=pulsus-dash` is `virtual`
([LogQL planning](#classify-the-selector-reader)).

### Fixtures

`wire/fixtures/plan/promql.json` holds the planner's cases, run by the Go planner
(`go test ./internal/pulsusdb/prom`) and by the client's StubApi mirror
([Explore](../client/explore.md#the-stubapi-planner-mirror)), so the two cannot drift:

| Section | Holds |
|---|---|
| `plan` | one case per row: `name` (unique), `from` (the test it replaces, or `new`), `inputs`, `types`, `needs_types` (absent on a refusal before types), `shape`, `group` (cases of one group plan to one query: a panel and its rule), `classify`, `resolve`, exactly one of `planned` or `error`, and `to_source` pairs `[sent, raw or null]` |
| `kind_of`, `from_metadata`, `rate_window`, `durations`, `bytes` | the tables of the type rules, the window and the byte counts |
| `reserved` | texts and the reserved name the byte guard reports, or null |
| `functions` | the parser's stable functions; `go test ./internal/pulsusdb/prom -run TestFunctionTable -update` writes it |

The `plan` cases Q1–Q33 (`from: "new (#118)"`) are the value encodings: each string form, the
comment and its CR end, the row-7b refusals and their order, and the string literals the
upstream lexer refuses.

A string member that would be long may be a `Text`: `{"concat": [string | {"repeat": Text, "count": n}, …]}`,
expanded by both runners (the query, `planned.query`, `planned.expanded` and the shape's metric
names). Each case has one shape, the Go parser's; the stub reproduces it with the Lezer tree and
a type check of the parser's rules, with no exemption. To add a case, add a row with its expected
values and run both suites; a case the stub cannot reproduce because of a known limitation of its
type check (regular-expression dialect, string escapes, number lexing, grammar release) is added
with a note on the client page, not exempted.

### The parser boundary

The language modules are isolated by depguard rules in `server/.golangci.yml` (T06-028,
ADR-0018 §3, §4): `logs-isolation` and `prom-isolation` keep each module from importing the other,
and `modules-from-callers` lets only their callers import them (`internal/gateway` today; a
cross-signal caller joins that list in the issue that adds it, citing ADR-0018 §4). The self-test
fixtures `prom_in_logs.go.txt`, `logs_in_prom.go.txt`, `logs_in_core.go.txt` and
`prom_in_store.go.txt` prove the three rules fire (`server/scripts/check-depguard-fixture.sh`).

The depguard rule `promql-parser` (`server/.golangci.yml`) allows
`github.com/prometheus/prometheus` only in `internal/pulsusdb/prom`; the self-test fixture
`promql_parser_outside_prom.go.txt` proves it fires. The module is pinned at `v0.316.0`, the release
of the client's `@prometheus-io/lezer-promql` grammar. The package holds one parser created with
zero options (experimental functions, fill modifiers and unquoted UTF-8 names off), and never sets
a package global of the module. The package links the parser's storage dependencies; `make
go-licenses` lists them in `build/THIRD_PARTY_NOTICES.txt`.

There is no LogQL parser. The upstream LogQL parser package is licensed AGPL-3.0-only, which is
off the `ci:go-licenses` allowlist; its module needs `replace` directives that a dependent module
ignores, and pins a pre-release PromQL parser below `v0.316.0`. LogQL planning needs no parse
(ADR-0021 §5): the selector reader below finds what Classify needs, and the byte guard backs it.

## LogQL planning

`logs.Plan` (`server/internal/pulsusdb/logs`, the LogQL module of ADR-0018) is pure and imports
only the standard library. LogQL needs no metric types, so the whole plan runs before any I/O,
tenant resolution included, and never logs or returns the query text or a value in an error.
The fixture `wire/fixtures/plan/logql.json` holds its cases, run by `go test
./internal/pulsusdb/logs` and by the client's mirror `client/src/api/stub/logsPlan.ts`
([Explore](../client/explore.md#the-stubapi-planner-mirror)).

### LogQL inputs and limits

The inputs, limits and refusal messages are the PromQL ones ([inputs](#inputs-and-limits),
[refusals](#refusals)), byte for byte, so the client maps both languages the same way: `query` 1 to
131 072 UTF-8 bytes, at most 64 `vars`, values at most 4 096 bytes, the 2 MiB processing cap
(counted in `Prepare` with the `1s` placeholder and again at the step), and 65 536 bytes for the
planned text. The step is the grid step (`step_ms` of `planned`); there is no `rate` member (a
`rate` in the body is 400 `/rate` `field.unknown`). Line limits are not a text rewrite: `limit`
stays a request member, sent as the upstream `limit` parameter, as the reference LogQL clients send
it.

### Substitution by the LogQL lexical rules

The raw bytes are scanned once, left to right, with a state:

| State | Byte | Next |
|---|---|---|
| none | `"` / `` ` `` | in a `"…"` string / in a `` `…` `` string |
| `"…"` | `\` | skip it and the next byte |
| `"…"` | `"` or LF | none |
| `` `…` `` | `` ` `` | none |

There is no comment state: PulsusDB's LogQL has no comments ([below](#pulsusdbs-logql-lexer-121)).
Outside strings a `#` is an ordinary byte to the scan, and row 9b then refuses the text.

A reference `$NAME` or `${NAME}` is recognised in every state, except where a backslash skipped
its `$` inside `"…"`:

| Reference | Becomes |
|---|---|
| `$__interval`, `$__rate_interval` | the step, and PromQL's rate window at the step (`max(4 × step, step + 15 s, 60 s)`, so one board means one window); `1s` in `Prepare` |
| any other `$__…` (`$__auto`, `$__range`), or a name longer than 64 | itself, unchanged; PulsusDB refuses it with a mapped position |
| a name in `vars`, inside `"…"` | the value, encoded by the table below |
| a name in `vars`, inside `` `…` `` | the value verbatim; a backtick or CR in it is refused (row 7b) |
| a name in `vars`, outside strings | the value verbatim: it is query text by intent (`$q` with `q={app="x"}`) |
| a name not in `vars` | itself; the plan is refused with `variable.missing` |

A reference after a `#` is top-level text (`{app="x"} # $a` needs `$a`); the text is then refused by
row 9b. Values are not rescanned (`a=$__interval` is sent as typed). A value written into a `"…"`
string is encoded so that it reads back as itself:

| Byte or rune of the value | Written |
|---|---|
| `"` | `\"` |
| `\` | `\\` |
| 0x07, 0x08, 0x0C, 0x0A, 0x0D, 0x09, 0x0B | `\a`, `\b`, `\f`, `\n`, `\r`, `\t`, `\v` |
| any other byte 0x00–0x1F, and 0x7F | `\x` and two lowercase hex digits (`\x01`, `\x7f`) |
| any other ASCII byte | itself |
| any non-ASCII rune, U+FFFD included | itself, its bytes unchanged |

For a value of ASCII only this is Go's `strconv.Quote` without its quotes. The one recorded
deviation: for a non-ASCII rune that `strconv.IsPrint` rejects (U+00A0, U+2028), `strconv.Quote`
writes `\u…` and the planner writes the rune itself. Both forms unquote to the same value, and the
client's mirror needs no Unicode tables to stay byte-identical. `FuzzEncodeDQ` checks that
`strconv.Unquote` gives back every valid UTF-8 value. U+FFFD is written as itself in `"…"` and in
`` `…` ``: PulsusDB's LogQL lexer accepts it in both (unlike the PromQL lexer, which refuses it), so
`{app="$a"}` with `a=x\ufffdy` is sent as the 13 bytes `{app="x` U+FFFD `y"}`.

**Row 7b.** A value that cannot be written where it is referenced is refused before any I/O with
400, one `/vars/<name>` `variable.unrepresentable` per name (distinct, first reference first), and
the message `the value of variable $a cannot be written where it is referenced`: a backtick or a
CR inside a `` `…` `` string (a backtick would end it, and a raw string drops its CRs). Missing
variables (row 7) are reported first.

### Row 9b: a top-level `#` is refused

`hashAt` finds the first `#` outside `"…"` and `` `…` `` by the states above (a backslash in `"…"`
skips the next byte, and an LF ends an unterminated `"…"`). It reads the substituted text, never the
raw text and the values apart, so a `#` that a value brings in is found. Two checks run, both before
any I/O:

1. `Prepare` checks the substituted text, after row 9 and before Classify. A text that holds both a
   `#` and a reserved selector is refused here as `query.invalid`, never as `virtual_unsupported`.
2. `Plan` checks the final planned text again, after the volume template and before row 10. Macros
   and the template add no `#`, so this check fires only if `Prepare` was bypassed; it is the
   final-text guarantee.

The refusal is 400, `code: invalid`, one field `/query` `query.invalid`, the message `unexpected
'#' at byte <N>: LogQL has no comments` and `hint: {"position": {"offset": N}}`, with N the `#`
mapped back to the raw text by the [three rules](#positions) (a `#` inside a value maps to the
reference's start). An offset with no position would give the message `unexpected '#': LogQL has no
comments` and no hint. No `planned` is written. Examples from the fixture:

| Case | Text (vars) | Outcome |
|---|---|---|
| H1 | `# x` CR `{source = "pulsus-dash"}` | refused at 0: a CR does not end anything, and the selector is never sent |
| H2 | `$q` with `q={app="x"} # c` CR `{ source = "pulsus-dash" }` | refused at 0, the reference's start |
| H4 | `{app="$a"} # c` with `a=xyz` | refused at 11 (the substituted text has it at 12) |
| H5, H6 | `{app="x"} \|= "#"`, `` {app="x"} \|= `#` `` | planned as is: the `#` is inside a string |
| H8 | `{app="x\"#"}` | planned as is: the escaped quote does not end the string |
| H9 | `{app="x` LF `# c` | refused at 8: the LF ended the unterminated string |
| H12 | `{app="x"} # y` | refused at 10, though it names no reserved selector |

The refusal matches PulsusDB 0.0.13's own (`unexpected '#' at byte N: expected a valid LogQL
token`), but the planner does not depend on it: a later PulsusDB that accepted comments could never
run a selector that Classify skipped (T07-020). [T09-002](../../designs/technical/T09-query-editors.md)
records this pre-dispatch refusal as a fail-closed guard, not a validity decision.

### PulsusDB's LogQL lexer (#121)

The `logql-lexer` contract subtest ([testing](../development/testing-pulsusdb.md#the-logql-lexer-contract-subtest))
pins what PulsusDB 0.0.13's LogQL lexer does with the bytes the planner relies on (native `GET
/api/logs/v1/query_range`, 2026-11-23; F is U+FFFD):

| Question | Probe texts | Answer |
|---|---|---|
| Does a `#` start a comment, and does it end at CR? | P1 `{app="xyz"} # c`, P2 `# c` CR `{app="x"}` | There are no comments: outside a string, `#` is refused at its own byte, whatever follows (`unexpected '#' at byte 12` and `at byte 0: expected a valid LogQL token`). Inside `"…"` and `` `…` `` it is content |
| U+FFFD in `"…"`? | P6 `{app="xFy"}`, P8 the same with ` )` | accepted (200, empty streams); the string ends at its own quote (`unexpected trailing input at byte 14`) |
| U+FFFD in `` `…` ``? | P7 ``{app=`xFy`}``, P9 the same with ` )` | accepted, the same way |

So the planner models no comment and refuses a `#` itself, fail closed for T07-020, and writes
U+FFFD as itself.

### Classify: the selector reader

`logs.Classify` reads every stream selector `{…}` outside strings, with the lexical units of the
substitution: spaces are SP, HT, CR and LF; a `"…"` string ends at its closing quote, or before an
LF or the end (unterminated); a `` `…` `` string ends at its backtick or the end. LogQL has no
comments, so no text is skipped: a `#` is an "other" byte, and a selector after it is always read.
Inside a selector, only spaces are skipped between tokens:

| Token | Bytes |
|---|---|
| NAME | `[A-Za-z_][A-Za-z0-9_]*`, or a string (a quoted label name), decoded |
| OP | `=~`, `!~`, `!=`, `=` (longest first) |
| STR | a string, decoded: `"…"` by Go's `strconv.Unquote` (an invalid escape or an unterminated string gives no value), `` `…` `` verbatim with every CR removed |
| `}` | ends the selector; the end of the text also ends it |
| other | one byte |

| State | NAME | OP | STR | other |
|---|---|---|---|---|
| no name | a name | no name | a name (decoded) | no name |
| a name | a new name | a name and an op | a name (decoded) | no name |
| a name and an op | a new name | no name | a matcher, then no name | no name |

A selector is reserved when one of its matchers has the name `source`, the op `=` and the value
`pulsus-dash`, all decoded. The source is `pulsus_db` with no reserved selector, `virtual` when
every selector is reserved, else `mixed`; the reported name is `source="pulsus-dash"`. Examples
from the fixture's `classify` group:

| Case | Text (vars) | Source |
|---|---|---|
| L1 | `{source="pulsus-dash"}` | `virtual` |
| L2 | `{source="pulsus-dash", kind="alert_transition"} \|= "x"` | `virtual` |
| L3 | `{source=~"pulsus-dash"}` | `pulsus_db` (only the equality matcher is reserved) |
| L4 | `{source="$s"}` with `s=pulsus-dash` | `virtual` |
| L5 | `sum(count_over_time({source="pulsus-dash"}[$__interval])) + sum(count_over_time({job="a"}[$__interval]))` | `mixed` |
| L6 | `{ source = "pulsus-dash" }` | `virtual` (the byte guard alone misses it) |
| L10 | `{app="x"} \| source="pulsus-dash"` | `pulsus_db`: a label filter is not a selector; the byte guard refuses it |
| L12 | `# {source="pulsus-dash"}` LF `{app="x"}` | `mixed` (both selectors are read); `Prepare` refuses the text by row 9b at 0 first |
| L20 | `{app="x" source="pulsus-dash"}` | `virtual`: after a missing comma the next name starts a new matcher (fail closed) |

The routes run Classify, then the byte guard, on both texts: the substituted text right after
`Prepare` (an early refusal without `planned`) and the planned text after `Plan`. The planned
text's classification is the authoritative one, because a macro can change a decoded value:
`{source="pulsus\x${__interval}dash"}` reads `pulsus\x1sdash` (an invalid escape) at the
placeholder and `pulsus-dash` at a two-day step, so it is refused at the last check, with
`planned`. The byte guard stays behind Classify as the T07-020 backstop: it still refuses the
bytes `source="pulsus-dash"` inside a string or a label filter, and `ALERTS` as a word.

### The volume template

On the volume route `Plan` (`KindVolume`) wraps the substituted text in the fixed template of #65
(T07-002, T07 §0), byte for byte:

```text
sum by (level, detected_level) (count_over_time(<expanded>
| drop __error__ [<VolumeRange(step)>]))
```

`VolumeRange` is `<s>s` for a step of whole seconds (`[5s]`, `[60s]`, every grid step) and `<ms>ms`
otherwise. The newline ends the text. The 65 536-byte limit counts the template (72 bytes at 5 s): a 65 500-byte text plans on the range route and
is refused with 413 on the volume route.

### What LogQL `planned` says

Every LogQL body carries `planned` (`LogqlPlannedQuery`): after `kind` on the range bodies, first on
the volume body (`LogqlVolumeResponse`); every error raised after planning carries it too.

| Member | Meaning |
|---|---|
| `query`, `bytes` | the text sent (on the volume route, the template around `expanded`) and its length |
| `expanded` | the substituted text |
| `step_ms` | the step planned at: the grid step |

`ErrorBody.planned` is the PromQL `PlannedQuery` or the LogQL `LogqlPlannedQuery`; the two closed
schemas exclude each other.

### LogQL positions

PulsusDB's position is mapped back to the raw text by the [three rules](#positions). Both the
volume prefix and the volume suffix are added text, so an offset inside either, the suffix's first
byte (its LF) included, has no position, and neither has the end of the composed text. This
replaces #65's clamp to the end of the text: for `{app="x"` on the volume route, offset 57 (in the
suffix) and offset 47 (in the prefix) have no position and keep their message, and the client
underlines the whole query; offset 50 is raw offset 2. When the offset maps, the first `at byte <N>`
of the message is rewritten to the raw offset: `{app="$a"}` with `a=xyz` and `parse error at byte 8`
(inside the value) gives position 6 and `parse error at byte 6`.

### LogQL route order ([T06-029](../../designs/technical/T06-bff-architecture.md), T07-020)

| Step | What | On failure |
|---|---|---|
| 1 | the body: required members and ranges; range: `limit`, `direction`, the `cursor` pattern | 400 |
| 2 | the grid, whose end must not pass the supported time range | 400 |
| 3 | `logs.Prepare` with the grid step, row 9b included | the refusals (row 9b: 400 `query.invalid` at the `#`); 413 `processing_cap` without `planned` |
| 4 | Classify, then the byte guard, on the substituted text | 400 `virtual_unsupported`, no `planned` |
| 4b | Resolve (the identity) and `CheckCap` at the step | 413 `processing_cap` |
| 5 | `Plan`: row 9b on the final text, then the size | 400 `query.invalid` at the `#`, no `planned`; 413 `query.sent_too_large` with the full `planned` |
| 6 | Classify, then the byte guard, on the planned text (the authoritative check) | 400 `virtual_unsupported` with `planned` |
| 7 | range with a cursor: the cursor against `planned.query` | 400 `cursor.invalid` or `cursor.mismatch` with `planned` |
| 8 | the route deadline; tenant resolution | as before, with `planned` |
| 9 | the data scope (the full tenant, D12) | 403 `scope_denied` with `planned` |
| 10 | send `planned.query` | the upstream errors, with `planned` and the mapped position |

Steps 1 to 7 make no I/O and read no tenant. No step logs the raw text, the planned text or a
variable value. The log completion routes are not planned and keep the byte guard alone.

## What the binding decides

Each upstream request is decorated from the tenant binding only. No header of the browser's
request is forwarded.

| Binding field | Upstream request |
|---|---|
| `datasource_url` | the base URL; a path prefix is kept (`http://h/prefix` → `http://h/prefix/api/v1/query_range`) |
| `scope_org_id` | `X-Scope-OrgID: <value>`, only when set |
| `database` | `X-Pulsus-Database: <value>`, only when set |
| `credentials_ref` | `Authorization: Basic base64(user:password)`, only when set |
| `kind` | must be `pulsusdb`; anything else is refused with 503 `datasource_config` |

Every request also carries `Accept: application/json` and `User-Agent: pulsus-dash/<version>`.
`Accept` is chosen in one place (`acceptHeader` in `source.go`), and a 2xx body is decoded by the
decoder its `Content-Type` selects (`formatOf`; JSON is the only one today, any other type is
`upstream_error`). A second body format can be added there without changing the methods.

### Credentials

`credentials_ref` is a secret reference (`env:NAME` or `file:/absolute/path`,
[T19-010](../../designs/technical/T19-deployment.md)) resolved per request in the server's
environment. The secret must be `user:password` with a non-empty user, and the password must be
**at least 8 bytes and not a number**: neither it nor its space-trimmed form may parse with Go's
`strconv.ParseFloat`, which covers signs, decimals, exponents, hex floats, `Inf`, `NaN` and
underscores. A number outside the float64 range (`1e999`, which ParseFloat answers with `ErrRange`)
counts as a number too (`core.WeakPassword`). A credential that is missing, malformed or weak is refused
before any request: 503 `unavailable` with `hint.reason: datasource_config`, and one log record
`msg=pulsusdb_credentials_weak tenant=<slug>` without the value.

The same rule is checked earlier where it can be:
- `migrate`, when it seeds an empty database and `datasource.credentials_ref` resolves in its
  environment, fails with `config: datasource.credentials_ref: the PulsusDB password must be at
  least 8 characters and must not be a number`. An unresolvable reference is accepted there,
  because `migrate` stores only the reference.
- `pulsus-dash config check` (for `serve`) fails with the same message; `--for migrate` prints it
  as a warning.

A Postgres constraint cannot check this: `tenant_bindings` stores the reference, never the value.

## Upstream requests

| Method | PulsusDB request | Parameters |
|---|---|---|
| range | `POST /api/v1/query_range` (form) | `query` (byte for byte, T07-002), `start`, `end` (seconds, `.mmm` only when not whole), `step` (whole seconds), `timeout` |
| instant | `POST /api/v1/query` (form) | `query`, `time`, `timeout` |
| series | `POST /api/v1/series` (form) | `match[]` in order, `start`, `end` (whole seconds: start floored, end raised), `limit` |
| labels | `POST /api/v1/labels` (form); on a 405 or a 400, the same request once as `GET` | `match[]`, `start`, `end` (whole seconds snapped to the minute: start floored, end raised, at least one minute apart), `limit` |
| label values | `GET /api/v1/label/<name>/values` | as labels; a name that is not a legacy label name (`[a-zA-Z_][a-zA-Z0-9_]*`) is sent in its `U__` form |
| metadata | `GET /api/v1/metadata` | `metric` (if set), `limit` |
| check | `GET /api/v1/status/runtimeinfo` | — |

These are the request shapes that the clients PulsusDB has been tested with send: the method of
`labels`, whole-second completion windows and the label-name escaping follow them. The `U__` form
writes `U__`, then each character as itself when it is a letter, a digit after the first position,
`__` for `_`, and `_<hex code point>_` otherwise (`_FFFD_` for invalid UTF-8): `http.status` is
`U__http_2e_status` and `μs` is `U___3bc_s`. The path therefore never holds a percent escape.

The LogQL methods have their own table ([LogQL in the PulsusDB client](#logql-in-the-pulsusdb-client)).

### Deadlines and the `timeout` parameter

Every route sets its deadline on the request's context ([T06-010](../../designs/technical/T06-bff-architecture.md)):
`timeout_ms` for the query routes, 10 s for the completion routes and 5 s for the check. The
deadline bounds tenant resolution, the wait for a tenant slot, every attempt, every retry sleep
and every body read. When it passes before PulsusDB answered, the route answers 504.

For the range and instant routes, each attempt sends `timeout=<remaining − 100 ms>ms`, computed
just before it is sent, so PulsusDB stops work the browser no longer waits for. An attempt with
less than 100 ms left is not sent: 504 `upstream_timeout`.

The transport dials and handshakes within 5 s each, keeps at most 64 connections per host, waits at
most 125 s for response headers, and the client has an absolute 130 s backstop. A redirect is not
followed: it is a protocol error.

### Retries ([T06-009](../../designs/technical/T06-bff-architecture.md))

| Outcome of an attempt | Retried |
|---|---|
| connection failure before any response (refused, reset, EOF, TLS) | yes |
| `503` with `errorType: "unavailable"` | yes (the body is read through the redactor; a body that stalls past the deadline is 504, a cut, oversized or malformed one is 502 `upstream_error`, neither retried) |
| `503` with `errorType: "timeout"` (504 `upstream_timeout`), another `503` (502 `upstream_unavailable`), `504`, `400`, `401`, `403`, `422`, `429` or any other status | no |

A retry needs all of: fewer than 3 attempts so far; the cluster's retry budget, where the retries
of the last 10 s (counted per `scheme://host:port`, including this one) stay within 10 % of its
requests; and a backoff of 50 ms + random × 350 ms that, plus 100 ms, fits in the remaining
deadline. Requests are never sent twice in parallel. The data-source check makes one attempt.
Go's HTTP transport also replays a `GET` by itself when a kept-alive connection turns out to be
closed before the request was answered.

### Tenant concurrency

At most `pulsusdb.tenant_concurrency` calls (default 16, 1 to 1024) are in flight per tenant
binding ([T06 §4.10](../../designs/technical/T06-bff-architecture.md)). A call waits at most 50 ms
for a slot, then fails with 429 `budget_exhausted`, `hint.reason: tenant_concurrency` and
`Retry-After: 1`. A range stream holds its slot until the response is written or abandoned.

## Range responses

### Grid

The browser sends the range and its chart width; the BFF picks the grid (T07-003 alignment):

- `step` is the first of 1 s, 5 s, 10 s, 15 s, 30 s, 1 min, 5 min, 15 min, 1 h, 6 h, 1 d with
  `step × width_px ≥ to − from`, else 1 d;
- `start = ⌊from / step⌋ × step` and `end = ⌈to / step⌉ × step`;
- more than 11 000 steps is refused: 400 `invalid`, pointer `/from`, key `range.too_long`.

One hour at 1 200 px is a 5 s step. The cases are in `wire/fixtures/json/promql-step.json`, which
both `pulsusdb.PromGrid` and the client's `promGrid` are tested against.

Each upstream point is placed on that grid by `ResultStream` as soon as the body decoder reads it,
so every decoder shares the placement and the points limit and no series is buffered: a series
holds at most one value per grid point. A point whose timestamp is off the grid, before `start`,
after `end` or already present in its series makes the response a protocol error, and decoding
stops there. A grid point without an upstream point
stays **absent**: `null` in the frame, never filled or interpolated
([T04-005](../../designs/technical/T04-wire-format-and-data-plane.md)).

### Streaming

The response is written while PulsusDB's body is decoded, one series at a time
([T06-011](../../designs/technical/T06-bff-architecture.md)): the head and the first frame are
flushed as soon as the first series is decoded, later frames go out through a 32 KiB buffer, and
the completeness block ends the body. Memory holds one series at a time.

If decoding fails after the first frame was written (PulsusDB closed the connection, a malformed
point, the body limit), the server logs `msg=promql_stream_aborted` and resets the connection, so
the browser gets a network error rather than a truncated body that looks complete. If the browser
went away, nothing is logged.

### JSON frames ([T04 §0](../../designs/technical/T04-wire-format-and-data-plane.md), ADR-0014 §5)

```json
{"start":1767225600000,"end":1767229200000,"step":5000,
 "frames":[{"key":"47ad55f1f828d9ee","labels":{"instance":"a:9090","job":"api"},
            "timestamps":[1767225600000,1767225605000,…],"values":[0.1,"NaN","+Inf","-Inf",null,-0,…]}],
 "completeness":{"truncated":false,"warnings":[],"infos":[],"query_id":"…","data_age_ms":30000,"read_cache":"miss"}}
```

- A frame is the JSON image of `labels/1` + `metric_matrix.grid/1`: `key`, `labels` (sorted by
  name), `timestamps` (ms, every grid point) and `values` (same length).
- A value is the shortest text that reads back as the same float64 (`-0` kept), the strings
  `"NaN"`, `"+Inf"` and `"-Inf"`, or `null` for an absent point.
- `key` is xxh3-64 (seed 0) of the canonical label set (labels sorted by name, each written as
  name, 0xFF, value, 0xFF) as 16 lower-case hex digits
  ([T04-004](../../designs/technical/T04-wire-format-and-data-plane.md)); the corpus
  `wire/fixtures/keyhash/labels.json` fixes it.
- Keys appear in that order, without whitespace; strings are escaped as `encoding/json` does,
  HTML characters included (`<` is `<`).

The instant response is `{"result_type","at","frames","scalar"|"string","completeness"}`: a vector
is one frame per sample with one point, a matrix keeps its points as given, a scalar is
`{"timestamp","value"}` and a string `{"timestamp","value"}` (redacted, at most 4 096 bytes).

### Completeness ([PRF-031](../../designs/product/09-performance-contract.md))

| Field | Meaning |
|---|---|
| `truncated` | the answer is incomplete: PulsusDB said so (`"truncated": true` at the top level or in `data`, or a warning or info containing `truncated`), or the BFF cut it at 5 000 000 grid points (warning `pulsus-dash: response truncated at 5000000 points`) |
| `warnings`, `infos` | PulsusDB's texts, redacted and cleaned (below), at most 20 each, then `pulsus-dash: N more warnings omitted` |
| `query_id` | PulsusDB's `X-Pulsus-Query-Id`, when accepted (below) |
| `data_age_ms` | range only: the response's time minus its newest present sample; omitted without samples |
| `read_cache` | `X-Pulsus-Read-Cache` as `hit`, `miss`, `bypass` or `other` |
| `read_cache_through_ms` | `X-Pulsus-Read-Cache-Through`, when accepted |

The completion routes carry the same block (without `data_age_ms`); more than 10 000 values,
series or metrics are cut and marked `truncated`.

**Native histograms.** A range or instant series that carries native histogram samples
(`histograms` in a matrix, `histogram` in a vector) instead of `values` or `value` is skipped; the
rest of the response is kept. Histogram samples next to float samples are dropped and the floats
kept. A skipped series takes no grid space and does not count towards the points limit. Either
way the completeness gets one warning,
`pulsus-dash: native histogram samples skipped in N series`. `truncated` is not set.

## Errors ([T06 §5.2](../../designs/technical/T06-bff-architecture.md))

Every error is the envelope `{"error":{"code","message","hint"?,"query_id"?,"fields"?,"planned"?}}`;
on the PromQL routes every error raised after planning carries `planned`
([query planning](#refusals)).

| Cause | Status | `code` | `message` | `hint`, `fields`, headers |
|---|---|---|---|---|
| PulsusDB rejected the query (400) | 400 | `invalid` | PulsusDB's text, redacted and cleaned | `fields: [{pointer: "/query", message_key: "query.invalid"}]`; `hint.position.offset` when found |
| too broad (422) | 422 | `too_broad` | PulsusDB's text, redacted and cleaned | `hint.action: narrow` |
| PulsusDB rate limited (429) | 429 | `budget_exhausted` | `PulsusDB is rate limiting this tenant` | `hint.reason: upstream_rate_limited`; `Retry-After` copied when accepted |
| no tenant slot | 429 | `budget_exhausted` | `too many queries in flight for this tenant` | `hint.reason: tenant_concurrency`; `Retry-After: 1` |
| deadline, 504, or 503 `timeout` | 504 | `unavailable` | `the query timed out` | `hint: {reason: upstream_timeout, action: narrow}` |
| connection failures, retries exhausted | 502 | `unavailable` | `PulsusDB could not be reached` | `hint.reason: upstream_unreachable` |
| 503 `unavailable` after retries, other 503 | 502 | `unavailable` | `PulsusDB is unavailable` | `hint.reason: upstream_unavailable` |
| 401, 403 | 502 | `unavailable` | `PulsusDB refused the datasource credentials` | `hint.reason: upstream_unauthorised` |
| a log page over 64 MiB, or a log response over 96 MiB before its `resultType` | 422 | `too_broad` | `the log page is larger than 64 MiB; lower the limit or narrow the query`, or `the log response is larger than 96 MiB before its resultType; lower the limit or narrow the query` | `hint.action: narrow` |
| anything unexpected (other status, not JSON, wrong `resultType`, off-grid point, a body over its limit) | 502 | `unavailable` | `PulsusDB returned an unexpected response` | `hint.reason: upstream_error` |
| misconfigured binding (kind, credentials) | 503 | `unavailable` | `the datasource is misconfigured` | `hint.reason: datasource_config` |
| data scope not the full tenant | 403 | `scope_denied` | `data scopes are not supported yet` | — |
| a log route's `cursor` that does not decode, or whose position lies outside its own window | 400 | `invalid` | `cursor is not a cursor of this route` | `fields: [{pointer: "/cursor", message_key: "cursor.invalid"}]` |
| a valid `cursor` of another query, direction, `from` or `to` | 400 | `invalid` | `cursor belongs to another query, direction or time range` | `fields: [{pointer: "/cursor", message_key: "cursor.mismatch"}]` |
| reserved selector | 400 | `virtual_unsupported` | `<name> is a reserved Pulsus Dash name and is not supported yet (it may appear only inside a string)` | `fields: [{pointer: "/query", "/match/<i>" or "/metric", message_key: "query.reserved"}]`; `hint.reserved` |

`query_id` is set whenever PulsusDB returned an accepted query id. Other status texts of PulsusDB
(5xx bodies, unknown `errorType`) are never returned.

**Text bodies.** An error body whose `Content-Type` is `text/plain` (any charset) is read as text,
on every route: at most 64 KiB, invalid UTF-8 replaced with U+FFFD, redacted, then cleaned as any
upstream text. A text 400 is `invalid` and a text 422 `too_broad`, with the text as the message; a
text over 64 KiB is `upstream_error`. A text 503 has no `errorType`, so it is not retried
(`upstream_unavailable`). LogQL errors are text: `unexpected end of query at byte 8: expected '}'`.

**Position** ([T09-009](../../designs/technical/T09-query-editors.md)). A message that starts with
`<line>:<column>: ` (1-based, the column in bytes) gives the byte offset of that line's start in
the sent query plus column − 1, kept only when it lies within the text. Without that prefix, the
first `at byte <N>` (LogQL; `N` is 0-based) gives offset `N`, kept only when `N` is at most the
query's length. The PromQL routes map the offset to the raw text ([positions](#positions)); it is
returned as `hint.position.offset`.
PulsusDB's current messages (for example `unclosed left parenthesis`) carry no position, and the
client underlines the whole query.

### Request validation

A body is at most 2 MiB (413 `invalid` `body too large`), one JSON object with no unknown field
and nothing after it. Errors are 400 `invalid` with one field:

| Condition | `pointer` | `message_key` |
|---|---|---|
| not JSON, not an object, trailing data | `""` | `body.invalid` |
| unknown field `x` | `/x` | `field.unknown` |
| missing required field | `/<field>` | `field.required` |
| wrong type, non-integer number (a variable value by its pointer, `/vars/<name>`) | `/<field>` | `field.type` |
| out of range (`from` < 0, `to` past year 9999, `width_px` outside 1 to 10 000, `from ≥ to` on `/to`, `timeout_ms` outside 200 to 120 000, instant `step_ms` outside 1 000 to 86 400 000) | `/<field>` | `field.range` |
| bytes that are not UTF-8: in the query, else in a variable | `/query` or `/vars` | `field.range` |
| the query, `vars` and the macros | [query planning](#refusals) | |
| range over 11 000 steps | `/from` | `range.too_long` |
| `tenant` missing or not a slug | `""` (message `tenant is required`) | `tenant.invalid` |

The GET routes apply the same rows to their parameters (`limit` 1 to 10 000, `name` 1 to 256
bytes, each `match` at most 65 536 bytes, `/match/<i>` for a bad one).

The log routes add their own rows ([supported time range](#supported-time-range), [cursor](#cursor)):

| Condition | `pointer` | `message_key` (`message`) |
|---|---|---|
| `to` > 9223372036854, before alignment (all five log routes) | `/to` | `field.range` (`to is beyond the supported time range (at most 9223372036854)`) |
| the grid end > 9223372036854 (range and volume) | `/to` | `field.range` (`to is too close to the end of the supported time range for this width`) |
| `from` < 0 (the log GET routes) | `/from` | `field.range` |
| `limit` outside 1 to 5 000 (range) | `/limit` | `field.range` (`limit must be between 1 and 5000`) |
| `direction` not `backward` or `forward` | `/direction` | `field.range` |
| `cursor` not 48 characters of `A-Z a-z 0-9 _ -` | `/cursor` | `field.range` |
| `query` parameter over 65 536 bytes (labels, label values) | `/query` | `field.range` |

Every check, the reserved-selector guard and the grid run before any I/O, tenant resolution
included. The PromQL routes keep their own `to` bound (year 9999).

## Reserved selectors ([T07 §0](../../designs/technical/T07-scene-query-planner.md), T07-020 v1)

Pulsus Dash will serve some series itself. Until it does, a text that names one is refused before
any I/O, tenant resolution included (on the PromQL routes and the LogQL range and volume routes,
Classify and then this guard run on the substituted text before the tenant is resolved, and both
run again on the planned text; the log completion routes have the guard alone): `ALERTS_FOR_STATE`, `ALERTS` or `pulsus_anomaly_score` as a whole word (the bytes
around it are absent or not in `[A-Za-z0-9_:]`, so `ALERTS_total` and `my_ALERTS` pass), or the
exact bytes `source="pulsus-dash"`. The guard screens the query of the range and instant routes,
every `match` and the metadata `metric`, and logs `msg=reserved_selector field=<pointer>` at `info`
without the text. The match is on bytes, so a name inside a string literal is refused too; this is
a documented limit of v1.

## Upstream text is untrusted ([T06-024](../../designs/technical/T06-bff-architecture.md))

Every string the BFF obtains from PulsusDB, from any body or from an accepted header, is redacted
before it can reach a response or a log:

- **Every decoder yields strings through the redactor.** A success body is decoded by the
  source its `Content-Type` selects (`source.go`); today the only one is `application/json`, read
  by `internal/pulsusdb/updec.go`, a streaming JSON tokenizer without reflection, and any other
  type is a protocol error. The `Accept` header is chosen in the same place. Every key and string
  token is returned through the redactor, and a later Arrow decoder must do the same. The lint
  rule `pulsusdb-decoder` forbids `encoding/json` decoding in `internal/pulsusdb` (tests
  excepted), with a self-test fixture.
  Text error bodies are read in `updec.go` too (`readTextBody`), and a log result captured before
  its `resultType` is kept only as a compact JSON image that a second tokenizer re-reads and
  redacts.
- **Redaction** replaces the credential `user:password`, the password (at any length), the Basic
  token, the datasource URL, its `scheme://host[:port]` and its `host[:port]` with `<redacted>`,
  after JSON escapes are resolved. Label keys are hashed from the redacted labels.
- **Cleaning.** Error, warning, info and help texts also get every control byte replaced with a
  space and are cut at 1 024 bytes (at a UTF-8 boundary, with `…`); other data strings are cut at
  4 096 bytes.
- **Samples are numbers, not text.** A sample is parsed as a float64; a token that is not a float
  is a protocol error, and the token is never stored or returned. Samples are not redacted:
  the number `123` is data the datasource serves and cannot be told apart from a password `123`.
  The credential rule above closes that case: no accepted password parses as a number.
- **Headers.** Only `X-Pulsus-Query-Id` (`^[A-Za-z0-9_-]{1,64}$`), `X-Pulsus-Read-Cache` (mapped to
  `hit|miss|bypass|other`), `X-Pulsus-Read-Cache-Through` (`^[0-9]{1,9}$`), `Retry-After` on a 429
  (`^[0-9]{1,6}$`) and `Content-Type` (checked, never copied) are read. A value that redaction
  changed, or that fails its pattern, is treated as absent. No other upstream header is forwarded.

## Cancellation ([PRF-030](../../designs/product/09-performance-contract.md))

The route's context is the browser's: when the browser aborts the fetch, the server cancels the
upstream request, which closes the connection (HTTP/1.1) or resets the stream (HTTP/2), and frees
the tenant slot. A request abandoned before any header is logged with `status=499`. On a log page
that needs more than one upstream request, the cancel ends the current one and no further request
starts.

The budget is 50 ms from the browser's cancel to the upstream request dropped at the BFF
([T04 §7](../../designs/technical/T04-wire-format-and-data-plane.md), T04-013), on the PromQL and
the LogQL routes, which share the client's `do`. `itest:cancel` and `itest:logql-cancel` measure it
the same way:

- the test waits, polling every 1 ms for at most 5 s, until the in-process fake has recorded the
  request that will hang (the fake records after reading the form, so the BFF has written its whole
  request and waits for headers);
- the start is `time.Now()` in the test immediately before it cancels the browser request's context;
- the end is the fake's `CancelledAt`, set when its handler's request context is done. Both clocks
  are the same process's monotonic clock, and nothing sleeps between the two, so the interval is an
  upper bound of "cancel → upstream dropped".

`itest:logql-cancel` covers the first request of a page and its group fetch (the second request);
`itest:cancel-mid-stream` keeps its 100 ms bound for a cancel after the first frame.

## Logs

Each PulsusDB call writes one record: at `warn` on failure, at `debug` on success (with
`read_cache`):

```text
msg=pulsusdb route=<query_range|query|series|labels|label_values|metadata|runtimeinfo|
                    logs_query_range|logs_volume|logs_labels|logs_label_values|logs_series> tenant=<slug>
  kind=<ok|unreachable|timeout|…> status=<n> attempts=<n> duration_ms=<n>
  query_id_present=<bool> query_id_hash=<8 hex> request_id=<id> [page_request=<1..3>]
```

A log page writes one record per upstream request; `page_request` numbers them, so the record
with `page_request=3` shows a page that took three. The range route adds, at `debug`,
`msg=logql_page tenant=<slug> entries=<n> streams=<n> upstream_requests=<1..3> cursor=<bool>
request_id=<id>`; a LogQL metric stream that fails after its header logs `msg=logql_stream_aborted`
(the PromQL routes log `promql_stream_aborted`).

`query_id_hash` is the first 8 hex digits of an HMAC-SHA256 of the raw query id under a key drawn
once per process, so records of one query can be matched without logging the header. No upstream
header value or text, and never the datasource URL, host, credentials or query text, is written to
a log or a response.

## Data-source check ([T06-025](../../designs/technical/T06-bff-architecture.md))

`GET /api/dash/v1/datasource/check?tenant=<slug>` calls `runtimeinfo` once and answers 200
`{"state","checked_at"}`: `ok` on success; `unauthorised` for 401/403; `unreachable` for connection
failures, timeouts and unavailability; `error` otherwise. It answers 404 for an unknown tenant, 503
when the configuration store fails and 504 when its 5 s deadline passes during tenant resolution. `/readyz` never calls it
([T06-026](../../designs/technical/T06-bff-architecture.md)), so readiness does not depend on
PulsusDB. The sidebar's data-source line shows the result ([client](../client/README.md#api-clients)).

## LogQL in the PulsusDB client

The client also calls PulsusDB's native LogQL routes under `/api/logs/v1/`
([T06-005](../../designs/technical/T06-bff-architecture.md)); the [LogQL routes](#logql-routes)
of the BFF are their only callers. Every call goes through the same `do` as the PromQL methods,
so it gets the same decoration, tenant slot, retries, deadline-derived `timeout`, redaction and log
record (T06-006, T06-009).

| Method | `route=` | PulsusDB request | Parameters | Retried | `timeout` |
|---|---|---|---|---|---|
| `LogQueryRange` | `logs_query_range` | `GET /api/logs/v1/query_range` (query string), 1 to 3 times per page | `query` (byte for byte, T07-002), `start`, `end`, `step` (`<n>ms`), `limit`, `direction` | yes, per request | yes |
| `LogVolume` | `logs_volume` | `GET /api/logs/v1/query_range` | `query` (the planned volume text below, byte for byte), `start` = grid start, `end` = grid end, `step` | yes | yes |
| `LogLabels` | `logs_labels` | `GET /api/logs/v1/labels` | `start`, `end`; `query` only when set | yes | no (10 s) |
| `LogLabelValues` | `logs_label_values` | `GET /api/logs/v1/label/<name, path-escaped>/values` | as `LogLabels` | yes | no (10 s) |
| `LogSeries` | `logs_series` | `GET /api/logs/v1/series` | `match[]` in order, `start`, `end` | yes | no (10 s) |

- **Request shape.** `query_range` and `series` are sent as GET with a query string and `step`
  in whole milliseconds with the unit (`5000ms`), the shape of the clients PulsusDB has been tested
  with. A URL longer than 8 KiB is sent as a POST form instead (`maxGetQuery`).
- **Timestamps are ns, written `%019d`.** PulsusDB reads a timestamp of ten characters or fewer as
  seconds, so every ns value is zero-padded to 19 digits (`0` is `0000000000000000000`, `-1` is
  `-000000000000000001`). Times up to 2262-04-11 fit.
- **Completion limits are the BFF's.** PulsusDB ignores `limit` on the completion routes, so
  `LogLabels`, `LogLabelValues` and `LogSeries` cut at `Limit` (at most 10 000) and mark the result
  `truncated`.
- **Reserved selectors** are screened as on the PromQL routes: `query` for the range, volume and
  label calls, `match/<i>` for series.

### Window, grid and metric queries

A log page covers the window `(from, to]` in nanoseconds: an entry at exactly `to` is returned and
one at exactly `from` is not, PulsusDB's own `(start, end]` semantics. Adjacent windows `(a, b]`
and `(b, c]` tile without overlap. Metric results and volume stay on the
[grid](#grid) of the request.

Whether a LogQL query is a log or a metric query is known only from the response's `resultType`
(the text is opaque, T07 §0). The first page is therefore sent on the grid, `(grid start, grid end]`:
a metric query then anchors on the grid and its matrix is returned as a `ResultStream` (placed on
the grid as in #62); for a log query, entries outside the window are dropped from that response.
When the first response is filled entirely by entries beyond the window's near edge (the slack
between the grid and the window holds `limit` entries), the page is re-requested on the window
itself.

JSON member order is not significant. A response may carry `result` before or after `resultType`:
- `resultType` first (every response seen so far): a matrix streams series by series as in #62,
  and a streams result is decoded as it is read;
- `result` first: the value is captured (at most 96 MiB, more is 422 `too_broad`) and decoded once
  `resultType` is known. A metric result in this order does not stream; its first series is handed
  out after PulsusDB's body ended, and the tenant slot is already free by then.

### Paging

PulsusDB documents `limit` as the global top-`limit` entries in `direction` order. Two properties
follow, and the probes and the contract subtest confirm them: a response with fewer than `limit`
entries is the whole of its window, and a response with exactly `limit` entries holds every entry
strictly before its last timestamp. The pager builds on these only:

- **Complete groups only.** A page delivers only whole timestamp groups. The last group of a
  response that hit its limit, which may be a partial subset, is never delivered from that response.
  The main request asks for `limit + 1` entries (at most 5 000), so a page never exceeds `limit` and
  a group is never split unless it alone exceeds `limit`.
- **Group fetch.** A group that fills a response is read whole on the one-nanosecond window
  `(T − 1, T]` with `limit` 5 000, sorted by stream key, then line bytes, then structured metadata,
  then parsed fields, and sub-paged by offset.
- **Cursor.** A page ends with `Next` = `(ts, skip)`: every entry beyond `ts` in direction order has
  been delivered, and so have the first `skip` entries of the group at `ts`. Nothing depends on the
  order or subset in which PulsusDB returns equal timestamps.
- **Short and empty pages.** A page can hold fewer than `limit` entries while `Next` is set. It is
  empty only at the end of the window, or when a group shrank between two requests.
- **Cost.** At most 3 upstream requests per page (main, re-issue on the window, group fetch);
  `LogPage.Requests` and the log's `page_request` count them. Every request shares the caller's
  deadline, takes the tenant slot itself, and no request starts after the caller cancels.
- **Exactly once while the data is unchanged.** Late data at a boundary timestamp between two page
  requests can shift a group's offsets.
- **Documented limit.** Paging returns every entry exactly once while fewer than 5 000 entries
  share one timestamp; beyond that, a page boundary can fall inside the group, and the next page can
  skip or repeat some of those entries. Pages still never exceed `limit`, and paging still ends.

`LogPage.Completeness.truncated` means that data was dropped and no cursor can reach it: a line cut
at 65 536 bytes, or PulsusDB's own `truncated` flag or warning. Reaching `limit` produces a cursor,
not `truncated`. The page's completeness merges those of its requests, and its data age comes from
the newest delivered entry.

The pager reads a decoded `logResponse` (streams, entries, completeness), not the JSON tokenizer,
so another body format can feed it unchanged.

### Streams and levels

Every page request (the main fetch, a re-issue and a group fetch) sends
`X-Loki-Response-Encoding-Flags: categorize-labels`, as the clients PulsusDB has been tested with
do (owner decision, 2026-11-21; a deviation from the #65 Part A plan, which skipped the third
element and left structured metadata out of scope). PulsusDB then answers in the categorised shape:
`data.encodingFlags` lists `categorize-labels`, `stream` holds the indexed stream labels only, and
each value is `[ts, line, {"structuredMetadata": {…}, "parsed": {…}}]`. Streams are therefore not
split by metadata or parsed values; `detected_level`, for example, arrives as structured metadata.
No other call sends the flag; the volume matrix is the same with or without it.

The plain shape is still accepted. Each stream object may list `stream` and `values` in either
order. A value is `[ts, line]` or `[ts, line, <third>]`: an object third element is read as the
categorised entry (its `structuredMetadata` and `parsed` members must be string maps, each at most
once; other members are skipped), and any other third element is skipped. `ts` must be a decimal
string without a leading zero that fits in int64. Lines, labels, metadata and parsed fields are
redacted; label, metadata and parsed names and values are cut at 4 096 bytes, and stream labels,
metadata and parsed fields count towards the 64 MiB page bound pair by pair, so the decode stops at the pair
that crosses it. Stream objects with the same label set are merged. A page lists only the streams
it delivers, by key ascending.

`LogEntry` carries `Metadata` and `Parsed` (sorted by name, `nil` if none) and its `Level`
(T04 §4.3 `log_lines/1`). The level comes from the stream labels if they have a recognised one,
else from the structured metadata, else from the parsed fields, else `unknown`. Within each set,
`detected_level` comes before `level`. `LogStream.Level` is the level of the stream labels alone.

| Level | Values (ASCII case-insensitive) |
|---|---|
| critical | `critical`, `crit`, `fatal`, `alert`, `emergency` |
| error | `error`, `err` |
| warn | `warn`, `warning` |
| info | `info`, `informational`, `notice` |
| debug | `debug` |
| trace | `trace` |

Any other value, `unknown` included, falls through to the next label, then to the next set.

### Volume

`/api/logs/v1/volume` answers bytes per label at one instant, so it cannot give counts per bucket.
The volume is a matrix query instead: `logs.Plan` wraps the substituted text in a fixed template
([the volume template](#the-volume-template), T07 §0), and `LogVolume` sends that planned text byte
for byte:

```text
sum by (level, detected_level) (count_over_time(<text>
| drop __error__ [<step>s]))
```

The newline ends the text; `| drop __error__` keeps lines that a parser stage in the text fails on from failing the whole query. Each grid point
`t` counts the lines of `(t − step, t]`, so the first and last points can count lines outside
`(from, to]`; the edges are not split. The matrix is folded into one series per level (by the
rules above), point-wise sums, in the order critical, error, warn, info, debug, trace, unknown;
levels without a point are omitted. `LogVolume` returns after the whole matrix was read: it is one
of the buffered cases of [T06-011](../../designs/technical/T06-bff-architecture.md), bounded by the
range limits and holding at most 7 level series of the grid.

`LogVolume` returns PulsusDB's position as an offset into the text it sent; the gateway maps it to
the raw text, with no position inside the template ([LogQL positions](#logql-positions)).

### Errors from PulsusDB on the log routes

Errors are mostly `text/plain` ([text bodies](#errors-t06-52)): a LogQL syntax error is 400 with
`at byte <N>`; 422 is `query too broad: …`. A window wider than PulsusDB's 5-year limit is
PulsusDB's own 400 (`query time range … outside the supported range`), returned with its message
and no position. An error on the second or third request of a page fails the page as a whole.

## LogQL routes

The five log routes run Part A's calls (above) for the browser. Their wire names are snake_case
(`ts_ns`, `width_px`), as on the PromQL routes.

### Range: log pages and metric results

`POST /api/dash/v1/query/logql/range` takes `query` (the raw text, 1 to 131 072 bytes), `from` and
`to` (ms since the epoch), `width_px`, and optionally `vars`, `limit` (1 to 5 000, default 1 000),
`direction` (`backward`, the default, or `forward`), `cursor` (from the previous page) and
`timeout_ms`. The text is planned by `logs.Plan` ([LogQL planning](#logql-planning)) and
`planned.query` is sent. The route deadline covers every upstream request of the page.

A log query answers one **page** of the window `(from, to]`: at most `limit` entries, complete
timestamp groups only ([paging](#paging)). The page is written in one go after its last upstream
response, because it is cut at whole timestamp groups across streams and is known only once the
whole upstream response is decoded (at most 5 000 entries):

```json
{"kind":"streams","planned":{"query":"{app=\"x\"}","expanded":"{app=\"x\"}","bytes":9,"step_ms":5000},
 "start":1767225600000,"end":1767229200000,"step":5000,"direction":"backward",
 "streams":[{"key":"258d6e4033fa2fdb","labels":{"app":"x","pod":"a"},
   "entries":[{"ts_ns":"1767229100000000500","line":"a5","level":"info","metadata":{"detected_level":"info"}}]},…],
 "cursor":"AQBybb…","completeness":{"truncated":false,"warnings":[],"infos":[],"query_id":"…","data_age_ms":200000}}
```

- `planned` is what was planned and sent ([LogQL `planned`](#what-logql-planned-says)).
- `start` and `end` are the request's `from` and `to` (the window), and `step` is the grid step.
- `streams` are the page's streams by key ascending, each with its indexed stream labels; a
  stream's `entries` are in page order (ts in direction, then the group order). The page order
  across streams is ts in direction, then stream key, then line: what the client's merge rebuilds.
- An entry is `ts_ns` (ns since the epoch as a decimal string: a double cannot hold it), `line`,
  `level` (a T04 level name), and `metadata` and `parsed` (string maps) when the entry has any.
- `cursor` continues the page and is omitted when no entry of the window is left.
- `completeness` merges the page's requests: `query_id` is that of its last request (absent when that request returned none); `data_age_ms`
  comes from the newest delivered entry.

A LogQL metric query (a `matrix` answer) is instead streamed series by series on the grid as on
the PromQL range route, with `kind` and `planned` first and no cursor:
`{"kind":"series","planned":{…},"start":…,"end":…,"step":…,"frames":[…],"completeness":…}`. Every
error raised after planning carries `planned` too. The metric query's upstream request
is the first request of a page (on the grid, with `limit + 1` and the direction); only the
`resultType` of the answer tells the two apart.

### Volume

`POST /api/dash/v1/query/logql/volume` takes `query`, `from`, `to`, `width_px`, `timeout_ms` and
`vars`, plans the text with the volume template, and answers `LogqlVolumeResponse`: `planned` first,
then the grid and frames of the [PromQL range body](#json-frames-t04-0-adr-0014-5), one frame per
level that has lines, labelled exactly `{"level": <name>}`, in the order critical, error, warn, info, debug,
trace, unknown ([volume](#volume)). It is written after `LogVolume` has read the whole upstream
matrix, so a failure mid-matrix is a 504 or 502 envelope, never a partial aggregate.

### Completion

`GET /api/dash/v1/logs/labels`, `…/logs/label/{name}/values` and `…/logs/series` answer as their
PromQL counterparts (`PromValuesResponse`, `PromSeriesResponse`), with the same 10 s deadline,
429 and default error responses. `from` and `to` are sent to PulsusDB as `from·10⁶` and `to·10⁶` ns.
The labels routes take an optional `query` (a stream selector), the series route one or more
`match`; the BFF cuts at `limit`.

### Supported time range

The log routes accept times up to `9223372036854` ms (2262-04-11T23:47:16.854Z), the last ms whose
ns value fits in int64 (owner decision Q6). `to` is checked against it before alignment, and on the
range and volume routes the aligned grid end too: with `from` 9223372036000, `to` 9223372036854 and
`width_px` 1 the grid ends at 9223372037000, so the request is refused with
`to is too close to the end of the supported time range for this width`. PulsusDB itself refuses a
window wider than 5 years ([errors](#errors-from-pulsusdb-on-the-log-routes)).

### Cursor

The cursor is opaque, unsigned and 48 characters long: unpadded base64url of 36 bytes, big-endian,
version 1, the direction, xxh3-64 of the planned query text (`planned.query`), the request's `from`
and `to`, and the page cursor `(ts, skip)`. It binds the page to the planned query, direction,
`from` and `to` of the request: another `vars` value is another query (`cursor.mismatch`), while a
text without variables plans to itself, so its cursor is unchanged. The width is not bound, since
it does not change which entries a page holds (a step macro in the text can make another width
another query). It carries no tenant and
authorises nothing, so a forged cursor can only narrow the caller's own window inside its own
tenant; it is not signed.

- A cursor that does not decode (not base64url, not 36 bytes, another version, a direction other
  than 0 or 1, a skip of 5 000 or more), or whose position is not in its own window, is 400
  `/cursor` `cursor.invalid`.
- A valid cursor of another query, direction, `from` or `to` is 400 `/cursor` `cursor.mismatch`.

Paging returns every entry exactly once while fewer than 5 000 entries share one timestamp and the
data does not change; beyond that is the [documented limit](#paging) (owner decision Q5).

The browser keeps the cursor of every page it fetched and re-requests an evicted page with it; a
re-fetch that answers another count, cursor or content is shown as changed data, never spliced in;
see [Log stream](../client/logs.md). The shared fixture `wire/fixtures/json/logql-paging.json` pins
this pager's pages and cursors (`TestPagingFixture`, 10 seeds of edge-group subsets), and the
client's synthetic log API passes the same cases (`unit:log-synth`).

## Configuration

| Key | Default | Rule |
|---|---|---|
| `pulsusdb.tenant_concurrency` (`PULSUS_DASH_PULSUSDB_TENANT_CONCURRENCY`) | `16` | 1 to 1024 (`must be between 1 and 1024`) |

The binding itself (URL, scope, database, credentials reference) lives in Postgres; the
`datasource.*` keys only seed it ([server configuration](README.md#configuration)).

## Limits

| Limit | Value | Over the limit |
|---|---|---|
| request body | 2 MiB | 413 |
| raw PromQL query | 131 072 bytes | 400 `field.range` |
| planned PromQL query | 65 536 bytes | 413 `query.sent_too_large`, with `planned` |
| substituted PromQL query | 2 MiB | 413 `query.too_large_to_plan` |
| `vars` | 64 entries; values 4 096 bytes | 400 |
| raw LogQL query (range and volume) | 131 072 bytes | 400 `field.range` |
| planned LogQL query, the volume template included | 65 536 bytes | 413 `query.sent_too_large`, with `planned` |
| substituted LogQL query | 2 MiB | 413 `query.too_large_to_plan` |
| each `match`, `metric` | 65 536 bytes | 400 `field.range` |
| steps per range | 11 000 | 400 `range.too_long` |
| grid points per response | 5 000 000 | cut, `truncated` with a warning |
| values, series or metrics per completion response | 10 000 | cut, `truncated` |
| range and instant body | 256 MiB | protocol error (a range stream is reset) |
| completion and check body | 32 MiB | 502 `upstream_error` |
| error body | 64 KiB | 502 `upstream_error` |
| error, warning, info, help text | 1 024 bytes; 20 warnings and 20 infos | cut with `…`; `N more … omitted` |
| log entries per upstream response | 5 000 (the upstream's maximum `limit`) | protocol error |
| log line | 65 536 bytes | cut at a UTF-8 boundary with `…`; `truncated` with the warning `pulsus-dash: <n> lines cut at 65536 bytes` |
| log line and label bytes per upstream response | 64 MiB | 422 `too_broad` |
| log result captured before its `resultType` | 96 MiB | 422 `too_broad` |
| GET URL of a log `query_range` or `series` call | 8 KiB | sent as a POST form instead |

## Budgets ([T06 §7](../../designs/technical/T06-bff-architecture.md), T05-006)

| Gate | Where | Fails when |
|---|---|---|
| `bench:cpu-instr` | `.github/workflows/bench.yml`, every pull request and `main`: `make cpu-instr` | the instruction count of workload W1 (a 1 000 × 1 000 matrix decoded, gridded and encoded), W2 (1 000 sequential 60-point range requests through the gateway) or W3 (one 5 000-entry log page through `POST …/logql/range`: 50 streams of 100 entries, 120-byte lines, a tie every 10th entry), minus an empty run, is more than 3 % over `server/testdata/bench/cpu-instr.json`; the Go or valgrind version differs from the baseline's (`rebaseline`); or a workload has no baseline (`no baseline for W3: rebaseline`) |
| `bench:promql-decode` | `REFERENCE_LAB=1 make bench-bff` (reference lab) | W1 takes more than 30 ms per 10⁶ points (median of 5) |
| `bench:bff-overhead` | the same target | W2 with a 2 ms upstream adds more than 5 ms at p50 or 20 ms at p99 |

**Counted boundary.** `cpu-instr.sh` first has the test binary write the W1, W2 and W3 upstream
bodies to files, without valgrind, so building the 10⁶-point input is never counted. Each counted
run reads the W1, the empty and the W3 files, so the reads cancel out; the empty run is served a
0-series answer. W1 minus the empty run is therefore exactly the A.11 boundary: from the first read
of the upstream body to the last byte of the response (decode, grid placement and encode). W3 minus
the empty run is one log page from handler start to the last byte written (decode, paging, sort and
encode; `limit` 4 999, so the main fetch asks for 5 000 and one request makes the page).

The two time budgets skip without `REFERENCE_LAB=1`: time is measured only on the reference
machines, never on shared CI runners (T05-006). The baseline is written by `make cpu-instr-update`,
run in CI, and committed with the change that moves it.

## Contract test

`itest:pulsusdb-contract` (`internal/pulsusdb/contract_itest_test.go`, build tag `itest`) runs the
client against a real PulsusDB, read-only, when `DASH_CONTRACT_PULSUSDB_URL` is set
(`DASH_CONTRACT_PULSUSDB_ORG` and `DASH_CONTRACT_PULSUSDB_CREDENTIALS_REF=env:NAME` are optional).
It is skipped in CI. It checks every method, and compares the client's labels and values with a
generic decode of the same bodies. Two cases pin request shapes the reference clients do not send:
`timeout=<n>ms` on the range and instant routes, and a range whose end lies after now. Never commit
the URL. Its `logql` subtest, which also needs `DASH_CONTRACT_LOGQL_SELECTOR`, checks the LogQL
properties the pager relies on ([testing against PulsusDB](../development/testing-pulsusdb.md#the-logql-contract-subtest)).

## Code layout

| File | Role |
|---|---|
| `internal/core/request.go`, `credential.go` | `RequestCtx`, `DataScope`, `LocalPrincipal`; `WeakPassword` |
| `internal/keyhash` | the series key |
| `internal/pulsusdb/client.go` | options, transport, decoration, attempts, logs |
| `internal/pulsusdb/promql.go` | the seven methods and the completion decoders |
| `internal/pulsusdb/stream.go` | `ResultStream`: range streaming, grid placement point by point (the sources' `seriesSink`), instant results, completeness |
| `internal/pulsusdb/source.go`, `source_json.go` | the decoder seam: `Accept`, the `Content-Type` dispatch, and the JSON source (both member orders, native histograms skipped; logs mode with the capture, `logSource`) |
| `internal/pulsusdb/logql.go` | the five LogQL methods, levels, `nsParam`; `LogVolume` sends the planned volume text |
| `internal/pulsusdb/logpage.go` | the decoded `logResponse`, `streamsResult`, `openLogs` and the pager |
| `internal/pulsusdb/updec.go`, `redact.go`, `guard.go`, `grid.go`, `errors.go`, `budget.go` | the tokenizer, redaction and headers, reserved selectors, the step rule, errors, retry budget and tenant slots |
| `internal/pulsusdb/prom/plan.go`, `substitute.go`, `errors.go` | `Prepare`, `Plan`, Classify, the limits, the substitution and its segment map, `PlanError` |
| `internal/pulsusdb/prom/shape.go`, `types.go` | `ShapeOf` over the upstream parser; metric kinds and `TypesCache` |
| `internal/pulsusdb/logs/plan.go`, `substitute.go`, `selector.go`, `errors.go` | `logs.Prepare`, `Plan`, the limits, the volume template, `RewriteAtByte`; the LogQL substitution, `encodeDQ` and the segment map; the selector reader (`Classify`); `PlanError` |
| `internal/gateway/query.go`, `plan.go`, `frames.go`, `prom.go`, `datasource.go`, `tenant.go` | the routes, planning on the routes (`planFor`, the `planned` member, error positions), the frame encoder, tenant resolution and the error mapping |
| `internal/gateway/logql.go`, `logplan.go`, `logframes.go`, `cursor.go`, `logs.go` | the LogQL range and volume routes, their planning (`logPlanFor`, the LogQL `planned` member, error positions), the log page encoder, the cursor, the log completion routes |
| `internal/pulsusfake`, `cmd/pulsus-fake` | the PulsusDB stand-in ([testing against PulsusDB](../development/testing-pulsusdb.md)) |

## Designs

PRF-030 (transport half), PRF-031 (server half) in
[the performance requirements](../../designs/product/09-performance-contract.md); T06-002, T06-005, T06-006,
T06-008, T06-009, T06-010, T06-011, T06-023 (declaration), T06-024, T06-025, T06-026, T06-028
and T06-029 in [T06](../../designs/technical/T06-bff-architecture.md); T04-001, T04-004, T04-005 and T04-010 in
[T04](../../designs/technical/T04-wire-format-and-data-plane.md) (with §4.3 `log_lines/1` levels and
its JSON image, the §5.2 `log_volume` row, the §5.3 `truncated` row and the §7 cancel budget,
T04-013); the log routes of T06 §5.1; T07-002, T07-020 (v1) and the §0 log volume row in
[T07](../../designs/technical/T07-scene-query-planner.md), with T07-003 and the §4.1 Classify step
(PromQL and LogQL); T09-009 (server half, with LogQL's `at byte N`), T09-010 and T09-015 (server half) in
[T09](../../designs/technical/T09-query-editors.md); T05-006 in
[T05](../../designs/technical/T05-testing-and-performance.md);
[ADR-0006](../../designs/adr/0006-pulsusdb-and-postgres.md),
[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §5,
[ADR-0015](../../designs/adr/0015-go-bff.md),
[ADR-0018](../../designs/adr/0018-query-language-modules.md),
[ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md).
