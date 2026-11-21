# PulsusDB client and the PromQL routes

The BFF reads telemetry from PulsusDB through one package, `server/internal/pulsusdb`
([T06-005](../../designs/technical/T06-bff-architecture.md)). The gateway serves its results to
the browser as JSON frames: the PromQL range and instant routes, the editor-completion routes and
the data-source check. Every call runs for the active tenant binding under the fixed local
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
| `GET /api/dash/v1/datasource/check` | `tenant` | `DatasourceStatus` | 5 s |

The schemas are in `api/openapi.yaml`. Every operation declares `x-permission: query.read`, the
T06-023 declaration that M-UI6 will check, and the required `tenant` parameter
(`^[a-z0-9-]{1,40}$`). The two POST routes are hand-written so that they can stream; the five GET
routes are generated strict handlers. A parameter the generated code cannot bind (missing, or not
an integer) is answered with its field error (`field.required` or `field.type`, `tenant.invalid`
for the tenant) by the gateway's request error handler.

The tenant slug is resolved among the bootstrap organisation's bindings, read under row-level
security through the same call as the bootstrap ([T06-006](../../designs/technical/T06-bff-architecture.md)).
An unknown slug is 404 `not_found` `unknown tenant`; a store failure is 503 `unavailable`
`configuration store unavailable`. Resolution runs under the route's deadline: if the deadline
passes first the answer is 504 `upstream_timeout`, and if the browser went away nothing is
written (the access log records 499).

## Query planning ([ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md))

The two PromQL routes take the text the user wrote and plan it on the server: the browser never
builds the query that is sent (T06-029). `prom.Plan` in `server/internal/pulsusdb/prom` (the PromQL
language module, ADR-0018) is a pure function in two halves: `Prepare` checks the inputs,
substitutes the variables and classifies the result; after the route resolves the step,
`Prepared.Plan` applies the step macros, the rate rewrites and the size limit. The routes call it
today; the alert evaluator will call the same function with a rule's stored step.

### Inputs and limits

| Input | Limit | Notes |
|---|---|---|
| `query` | 1 to 131 072 UTF-8 bytes | the raw text; JSON Schema `maxLength` counts characters, the server counts bytes |
| `vars` | at most 64 names, each `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; each value at most 4 096 bytes | names checked in byte order |
| `rate` (range) | boolean, default `true` | the rate chip |
| `step_ms` (instant) | 1 000 to 86 400 000 | the step of `$__interval`, `$__rate_interval` and the rate rewrite; without it an instant query is not rated |
| substituted text | 2 MiB (2 097 152 bytes, the request-body limit) | the processing cap, counted before the text is built |
| planned text | 65 536 bytes | checked on the final planned text only |

The raw text may be up to 128 KB because the planned text, not the raw text, is what has to fit
in 64 KiB: a long comment before a bare counter is sent as `rate(x_total[1m])`. A raw text between
64 and 128 KiB whose plan stays that long is accepted, planned, and then refused with 413. The
processing cap is a deliberate, bounded exception: a substituted text over 2 MiB is refused even
when a rewrite would shrink it.

### The rules, in order

1. **Substitution.** The raw bytes are scanned once, left to right, with a quote state (none,
   `"`, `'`, `` ` ``): outside a string a quote opens one; inside `"…"` or `'…'` a backslash skips
   the next byte and the same quote closes it; inside backticks only a backtick closes. Comments
   are not recognised, so `up # $r` still needs `$r`. A reference is `$NAME` or `${NAME}` with
   `NAME = [A-Za-z_][A-Za-z0-9_]*`:

   | Reference | Becomes |
   |---|---|
   | `$__interval` | the step, as a duration (`30s` at 30 000 ms) |
   | `$__rate_interval` | the rate window of the step (below) |
   | any other `$__…`, or a name longer than 64 | itself, unchanged |
   | a name in `vars` | the value; inside `"…"` or `'…'` each `\` becomes `\\` and that quote `\` + quote; inside backticks and outside strings, verbatim |
   | a name not in `vars` | itself; the plan is refused with `variable.missing` |

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
| a macro in an instant query without `step_ms` | 400 | `/step_ms`, `field.required` | `step_ms is required for $__interval and $__rate_interval` |
| the substituted text over 2 MiB | 413 | `/query`, `query.too_large_to_plan` | `the substituted query is over 2097152 bytes, the most the server processes`; `hint.reason: processing_cap`, no `planned` |
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
| 4b | resolve the step: `FloorStep(base step, floor)` | — |
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
are left to the byte guard. LogQL keeps its byte guard until `logs.Plan` lands (the follow-up
"Move LogQL planning to the Go service").

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

A string member that would be long may be a `Text`: `{"concat": [string | {"repeat": Text, "count": n}, …]}`,
expanded by both runners (the query, `planned.query`, `planned.expanded` and the shape's metric
names). Each case has one shape, the Go parser's; the stub reproduces it with the Lezer tree and
a type check of the parser's rules, with no exemption. To add a case, add a row with its expected
values and run both suites; a case the stub cannot reproduce because of a known limitation of its
type check (regular-expression dialect, string escapes, number lexing, grammar release) is added
with a note on the client page, not exempted.

### The parser boundary

The depguard rule `promql-parser` (`server/.golangci.yml`) allows
`github.com/prometheus/prometheus` only in `internal/pulsusdb/prom`; the self-test fixture
`promql_parser_outside_prom.go.txt` proves it fires. The module is pinned at `v0.316.0`, the release
of the client's `@prometheus-io/lezer-promql` grammar. The package holds one parser created with
zero options (experimental functions, fill modifiers and unquoted UTF-8 names off), and never sets
a package global of the module. The package links the parser's storage dependencies; `make
go-licenses` lists them in `build/THIRD_PARTY_NOTICES.txt`.

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
| anything unexpected (other status, not JSON, wrong `resultType`, off-grid point, a body over its limit) | 502 | `unavailable` | `PulsusDB returned an unexpected response` | `hint.reason: upstream_error` |
| misconfigured binding (kind, credentials) | 503 | `unavailable` | `the datasource is misconfigured` | `hint.reason: datasource_config` |
| data scope not the full tenant | 403 | `scope_denied` | `data scopes are not supported yet` | — |
| reserved selector | 400 | `virtual_unsupported` | `<name> is a reserved Pulsus Dash name and is not supported yet (it may appear only inside a string)` | `fields: [{pointer: "/query", "/match/<i>" or "/metric", message_key: "query.reserved"}]`; `hint.reserved` |

`query_id` is set whenever PulsusDB returned an accepted query id. Other status texts of PulsusDB
(5xx bodies, unknown `errorType`) are never returned.

**Position** ([T09-009](../../designs/technical/T09-query-editors.md)). A message that starts with
`<line>:<column>: ` (1-based, the column in bytes) gives the byte offset of that line's start in
the sent query plus column − 1, kept only when it lies within the text. The PromQL routes map it to
the raw text ([positions](#positions)) and return it as `hint.position.offset`.
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

## Reserved selectors ([T07 §0](../../designs/technical/T07-scene-query-planner.md), T07-020 v1)

Pulsus Dash will serve some series itself. Until it does, a text that names one is refused before
any I/O, tenant resolution included (on the PromQL routes Classify and this guard run on the
substituted text before the tenant is resolved, and the guard runs again on the planned text): `ALERTS_FOR_STATE`, `ALERTS` or `pulsus_anomaly_score` as a whole word (the bytes
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
the tenant slot. A request abandoned before any header is logged with `status=499`. The itests
check that PulsusDB sees the cancel within 100 ms, before headers and mid-stream.

## Logs

Each PulsusDB call writes one record: at `warn` on failure, at `debug` on success (with
`read_cache`):

```text
msg=pulsusdb route=<query_range|query|series|labels|label_values|metadata|runtimeinfo> tenant=<slug>
  kind=<ok|unreachable|timeout|…> status=<n> attempts=<n> duration_ms=<n>
  query_id_present=<bool> query_id_hash=<8 hex> request_id=<id>
```

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
| each `match`, `metric` | 65 536 bytes | 400 `field.range` |
| steps per range | 11 000 | 400 `range.too_long` |
| grid points per response | 5 000 000 | cut, `truncated` with a warning |
| values, series or metrics per completion response | 10 000 | cut, `truncated` |
| range and instant body | 256 MiB | protocol error (a range stream is reset) |
| completion and check body | 32 MiB | 502 `upstream_error` |
| error body | 64 KiB | 502 `upstream_error` |
| error, warning, info, help text | 1 024 bytes; 20 warnings and 20 infos | cut with `…`; `N more … omitted` |

## Budgets ([T06 §7](../../designs/technical/T06-bff-architecture.md), T05-006)

| Gate | Where | Fails when |
|---|---|---|
| `bench:cpu-instr` | `.github/workflows/bench.yml`, every pull request and `main`: `make cpu-instr` | the instruction count of workload W1 (a 1 000 × 1 000 matrix decoded, gridded and encoded) or W2 (1 000 sequential 60-point range requests through the gateway), minus an empty run, is more than 3 % over `server/testdata/bench/cpu-instr.json`, or the Go or valgrind version differs from the baseline's (`rebaseline`) |
| `bench:promql-decode` | `REFERENCE_LAB=1 make bench-bff` (reference lab) | W1 takes more than 30 ms per 10⁶ points (median of 5) |
| `bench:bff-overhead` | the same target | W2 with a 2 ms upstream adds more than 5 ms at p50 or 20 ms at p99 |

**Counted boundary.** `cpu-instr.sh` first has the test binary write the W1 and W2 upstream bodies
to files, without valgrind, so building the 10⁶-point input is never counted. Each counted run
reads its body from those files; the empty run reads the same W1 file but is served a 0-series
answer. W1 minus the empty run is therefore exactly the A.11 boundary: from the first read of the
upstream body to the last byte of the response (decode, grid placement and encode).

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
the URL.

## Code layout

| File | Role |
|---|---|
| `internal/core/request.go`, `credential.go` | `RequestCtx`, `DataScope`, `LocalPrincipal`; `WeakPassword` |
| `internal/keyhash` | the series key |
| `internal/pulsusdb/client.go` | options, transport, decoration, attempts, logs |
| `internal/pulsusdb/promql.go` | the seven methods and the completion decoders |
| `internal/pulsusdb/stream.go` | `ResultStream`: range streaming, grid placement point by point (the sources' `seriesSink`), instant results, completeness |
| `internal/pulsusdb/source.go`, `source_json.go` | the decoder seam: `Accept`, the `Content-Type` dispatch, and the JSON source (both member orders, native histograms skipped) |
| `internal/pulsusdb/updec.go`, `redact.go`, `guard.go`, `grid.go`, `errors.go`, `budget.go` | the tokenizer, redaction and headers, reserved selectors, the step rule, errors, retry budget and tenant slots |
| `internal/pulsusdb/prom/plan.go`, `substitute.go`, `errors.go` | `Prepare`, `Plan`, Classify, the limits, the substitution and its segment map, `PlanError` |
| `internal/pulsusdb/prom/shape.go`, `types.go` | `ShapeOf` over the upstream parser; metric kinds and `TypesCache` |
| `internal/gateway/query.go`, `plan.go`, `frames.go`, `prom.go`, `datasource.go`, `tenant.go` | the routes, planning on the routes (`planFor`, the `planned` member, error positions), the frame encoder, tenant resolution and the error mapping |
| `internal/pulsusfake`, `cmd/pulsus-fake` | the PulsusDB stand-in ([testing against PulsusDB](../development/testing-pulsusdb.md)) |

## Designs

PRF-030 (transport half), PRF-031 (server half) in
[the performance requirements](../../designs/product/09-performance-contract.md); T06-002, T06-005, T06-006,
T06-008, T06-009, T06-010, T06-011, T06-023 (declaration), T06-024, T06-025, T06-026, T06-028
and T06-029 in [T06](../../designs/technical/T06-bff-architecture.md); T04-001, T04-004, T04-005 and T04-010 in
[T04](../../designs/technical/T04-wire-format-and-data-plane.md); T07-002 and T07-020 (v1) in
[T07](../../designs/technical/T07-scene-query-planner.md), with T07-003 and the §4.1 Classify step
(PromQL); T09-009 (server half), T09-010 and T09-015 (server half) in
[T09](../../designs/technical/T09-query-editors.md); T05-006 in
[T05](../../designs/technical/T05-testing-and-performance.md);
[ADR-0006](../../designs/adr/0006-pulsusdb-and-postgres.md),
[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §5,
[ADR-0015](../../designs/adr/0015-go-bff.md),
[ADR-0018](../../designs/adr/0018-query-language-modules.md),
[ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md).
