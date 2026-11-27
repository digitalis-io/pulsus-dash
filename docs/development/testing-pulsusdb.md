# Testing against PulsusDB

No real PulsusDB runs in CI. Server tests and the dev stack use **pulsus-fake**
(`server/internal/pulsusfake`), which replays recorded transcripts and records every request it
receives, including cancellation. The client and server also share fixtures under `wire/fixtures/`.
What the fake stands in for is described in [the PulsusDB client page](../server/pulsusdb.md).

## Transcripts

A transcript is one JSON file in `server/internal/pulsusfake/testdata/` (embedded with
`//go:embed`; `pulsusfake.Default()` returns them, sorted by file name):

```json
{
  "name": "label-values",
  "provenance": {"captured": "2026-11-20", "pulsusdb": "0.0.11", "route": "/api/v1/label/job/values",
                 "sanitised": "labels, values, timestamps and query id replaced; captured with limit=2"},
  "match": {"method": "GET", "paths": ["/api/v1/label/job/values"]},
  "response": {
    "status": 200,
    "headers": {"Content-Type": "application/json", "X-Pulsus-Query-Id": "fake-label-values-1"},
    "body": {"status":"success","data":["api","db"],"warnings":["results truncated due to limit"]}
  }
}
```

| Field | Meaning |
|---|---|
| `name` | unique; it is what `Recorded.Transcript` and `WaitCancelled` name |
| `provenance` | exactly one of `captured` (with `pulsusdb`, the version, `route` and `sanitised`) or `synthetic` (the reason no capture exists); `Load` refuses a file with neither or both |
| `match.method`, `match.paths` | the request's method and one of the paths |
| `match.query` | optional: the form's `query` byte for byte |
| `match.form` | optional: an object of form keys and values; each key's first value in the request must equal its value (`{"limit": "11", "direction": "backward"}`) |
| `response.status`, `headers` | written as given |
| `response.body` | written byte for byte as it appears in the file |
| `response.body_text` | instead of `body`: a JSON string whose value is written byte for byte, for `text/plain` error bodies such as LogQL's; `Load` refuses a file that sets both |
| `response.delay_ms` | wait before answering (cut short, and recorded as cancelled, if the client goes away) |
| `response.hang` | never answer: block until the client goes away, then record the cancel |

**Captured** transcripts keep the shape, key order and message text of a response taken from a
development PulsusDB, with labels, values, timestamps and query ids replaced. Nothing that
identifies the deployment is kept: no host, URL or tenant. Query ids are `fake-<name>-1`.
**Synthetic** transcripts cover what cannot be captured read-only (a timeout, a stall, the
`truncated` flag, keys in reverse order) and say why in `provenance.synthetic`.

The 18 transcripts cover a counter (with the NaN, ±Inf, −0 and subnormal edge values), a
histogram, a truncated result (warning and flag), reordered keys, a gauge vector, a scalar, two
parse errors (with and without a position), a timeout, a hang, a too-broad selector, labels (the
`GET` capture, and `labels-post`, the synthetic `POST` form the client sends first), label
values, series, metadata and runtime info.

### The log transcripts (`logs-*.json`, #65)

Twenty-two transcripts answer the log routes. Every page request is a `GET` of
`/api/logs/v1/query_range`, and except for the two U+FFFD transcripts its query is `{app="x"}` with
`step` `5000ms`; each page transcript
matches its `start`, `end`, `limit` and `direction` through `match.form`, so a request with
another window or limit is unexpected. Their bodies are in the **categorised** shape that PulsusDB
returns to the page requests (they send `categorize-labels`): `data.encodingFlags`, indexed stream
labels only (`{app, pod}`), and per entry a third element with `structuredMetadata` and, for pods
`b` and `c`, `parsed`. The data is the six entries of the #65 test window: `a5`, `b4`, and the
group at `t0 + 300` (`a3` twice, `b3`, `c3`); the levels come from the metadata and parsed fields
(pod `a` info, `b` warn, `c` error).

| Transcripts | What | Provenance |
|---|---|---|
| `logs-page-backward-1`, `logs-page-forward-1` | a top-`limit` answer whose edge group at `t0 + 300` is a partial subset | captured shape, **synthetic subset**: the API does not document which subset of an edge group a limited answer holds, so these choose one other than the development deployment returned |
| `logs-page-backward-2`, `logs-group-300`, `logs-page-forward-3` | the second backward page, the group fetch `(t0 + 299, t0 + 300]` with `limit` 5000, the last forward page | captured shape |
| `logs-empty`, `logs-metric`, `logs-volume` | an empty page, a LogQL metric matrix, the volume template's matrix (with `| drop __error__`) | captured |
| `logs-parse-error`, `logs-parse-error-nopos`, `logs-volume-parse-error`, `logs-too-broad`, `logs-wide-window` | `text/plain` errors with their messages verbatim (`at byte N`, none, the composed volume text's offset 57, 422, the 5-year window) | captured, 2026-11-21, PulsusDB 0.0.12 |
| `logs-timeout`, `logs-hang`, `logs-hang-page`, `logs-hang-group` | a 504, a stall on the first request, and a page that needs a group fetch which stalls | synthetic: no timeout or stall can be provoked read-only |
| `logs-labels`, `logs-label-values`, `logs-series` | the completion routes | captured |
| `logs-fffd-dq`, `logs-fffd-bq` | an empty streams answer to `{app="x` U+FFFD `y"}` and to the same in `` `…` ``, matched by the query alone: the planner writes U+FFFD as itself (#121) | captured 2026-11-23, PulsusDB 0.0.13, `sanitised`: "synthesised from validated fields: status, resultType, an empty result", written by the `logql-lexer` recorder ([below](#the-logql-lexer-contract-subtest)) |

`logs-hang-group` sorts before `logs-hang-page` but requires `limit` `5000`, so the main request
(`limit` `2`) is answered by `logs-hang-page`. The captured errors carry an `X-Pulsus-Query-Id`,
as the development deployment's 400 and 422 answers do.

**Adding a page transcript.** Work out the exact requests `LogQueryRange` sends for the page
(`start` and `end` as `%019d` ns, the main fetch's `limit` is the request's `limit + 1` up to
5 000, a group fetch is `(T − 1, T]` with `limit` 5000), write one transcript per request with those
values in `match.form`, and keep the categorised shape. A page test with the strict harness then
fails on any request you did not foresee.

### Adding a transcript

1. Capture the response of a development PulsusDB, read-only. Keep the capture in a scratch
   directory, never in the repository.
2. Replace every label name and value, sample value, timestamp and query id with synthetic ones.
   Remove anything that names the deployment.
3. Write the file with its `provenance`. Keep the body exactly as PulsusDB wrote it otherwise.
4. Run `make no-pulsusdb-host` (with your `dev/local.env`, so your host is on the forbidden list)
   and `go test ./internal/pulsusfake`.

## Matching

For each request the fake parses the form: the query string and the body together, so one
transcript serves a GET and its POST fallback alike, given the right `match.method`. A transcript
matches when its method and path match and every `match.form` entry equals the request's first value
for that key. The first matching transcript whose `match.query` equals the form's `query` wins;
otherwise the first matching one that has no `match.query`. The request is recorded before it is
answered.

A request that matches nothing is recorded with `Transcript: ""` and answered 404
`{"status":"error","errorType":"not_found","error":"pulsus-fake: unexpected request"}`.

## In tests: strict mode

Every Go test gets the fake through `fakeharness.Start(t)`, which serves the default transcripts on
an `httptest` server and returns the fake and its URL. When the test ends, every unexpected request
(`fake.Unexpected()`) fails it with its method and path. Tests that need a misbehaving upstream (a
reset, a truncated body, a stall mid-body) use a named `httptest` handler instead.

| Method | Use |
|---|---|
| `Requests()` | a copy of the recorded requests, in arrival order: method, path, form, headers, `ReceivedAt`, `Completed`, `Cancelled`, `CancelledAt` |
| `WaitCancelled(ctx, name)` | waits until a request answered by transcript `name` was cancelled; the itests use it with the `hang`, `logs-hang` and `logs-hang-group` transcripts |
| `Unexpected()` | the requests no transcript matched |
| `Reset()` | forgets the records |

A stall handler must read the request body (for example `r.ParseForm()`), as PulsusDB does: Go's
HTTP server notices that the client went away only once the body was read.

## In the dev stack: the generator

`cmd/pulsus-fake` (`--listen`, default `localhost:9091`; `--transcripts DIR`, default the embedded
set; `--generate`, default `true`; `--control`, default `false`, [below](#in-the-e2e-suite-control-mode)) serves the fake for `make dev-up` ([dev stack](dev-stack.md)).
With the generator on, an unmatched `/api/v1/query_range` or `/api/v1/query` gets one series
`{fake="generated"}` with the value `sin(t / 600)` (t in seconds) on the request's grid or at its
time, and `X-Pulsus-Query-Id: fake-generated`, so any query draws a line. It writes one JSON log
line per request (`method`, `path`, `transcript`, `status`, `cancelled`) and keeps no history.

The image is `dev/pulsus-fake.Dockerfile`, a static binary on `scratch`; its
`dev/pulsus-fake.Dockerfile.dockerignore` sends only `server/` (without `server/build`). The CI gate
`ci:fake-image` builds and runs it and checks that `runtimeinfo` answers with
`X-Pulsus-Query-Id: fake-runtimeinfo-1` within 10 s.

## In the e2e suite: control mode

`tools/e2e/fake.sh PORT` runs `build/e2e-fake/pulsus-fake --listen localhost:PORT --transcripts
client/e2e/transcripts --generate=false --control` (built by `make e2e-build`). The e2e suite
starts it on port 4190 and both e2e BFFs use it as their data source
([end-to-end tests](build-and-ci.md#end-to-end-tests)). `--control` adds two routes and keeps the
records:

| Route | Answer |
|---|---|
| `GET /__fake/requests` | `200 application/json`: every record, in arrival order, `[]` when none |
| `POST /__fake/reset` | `204`; forgets the records (a request in flight at the reset is not listed again) |
| either route with another method | `405`, with `Allow: GET` or `Allow: POST` |
| any other `/__fake/…` path | `404 application/json` `{"error":"pulsus-fake: unknown control route"}` |

Control calls are never recorded. Every other request is served and logged as without
`--control`, but its record is listed from the moment it arrives and is not reset afterwards. A
record has the fields `transcript`, `method`, `path`, `query`, `start`, `end`, `step`, `time` (the
form values, `""` when absent), `state` and `receivedAtMs`:

| `state` | When |
|---|---|
| `inflight` | the request arrived and is not answered yet (a `delay_ms` or `hang` transcript) |
| `completed` | the response was written (also the 404 for an unmatched request, with `transcript` `""`) |
| `cancelled` | the client went away first |

A control-mode fake keeps the newest 1 000 records; the oldest is dropped when a new one arrives
(`Options.MaxRecords`). Without `--control` nothing changes: `/__fake/*` is an unexpected request
and the records are reset after every request.

The e2e browsers run in parallel against the one fake, so a spec filters the records (by query,
window or state) and **never** calls `POST /__fake/reset`, which would clear the records other
workers are waiting for. Reset is for debugging with a single worker only.

### e2e transcripts

`client/e2e/transcripts/` holds the 18 transcripts of the Explore and board e2e suites (#63, #64). Four are byte
copies of `server/internal/pulsusfake/testdata/` (`runtimeinfo`, `histogram`, `scalar`,
`too-broad`); the others are synthetic, with the reason in `provenance.synthetic` and query ids
`fake-<name>-1`. Their range bodies are on the e2e window `2026-01-01T00:00:00Z`–`01:00:00Z` at
points of the 15 s step that a 1 h PromQL panel plans (#303; `histogram` was re-timed from 5 s),
except `slow-final-<browser>`: `e2e:board-cancel`'s final window (each browser's day 2
plus 2 h), matched on its `start` form value ahead of `slow`, so the window the board ends on
answers with a series (7, then 42) that the windows it skipped never do. The same provenance rules apply as above; Prettier does not touch the directory, so the
copies stay byte-equal. `go test ./cmd/pulsus-fake` (`TestE2ETranscripts`) loads the directory,
checks the 18 names and compares the copies byte for byte.

### e2e helpers (`client/e2e/fake.ts`)

| Helper | Use |
|---|---|
| `FAKE` | `http://localhost:4190` |
| `fakeRequests(request, filter)` | `GET /__fake/requests` (expects 200), keeping the records whose every given field equals the filter's |
| `resetFake(request)` | `POST /__fake/reset` (expects 204); single-worker debugging only |
| `sec(ms)` | seconds as the BFF sends `start` and `end`: `String(ms / 1000)` |
| `runShift(info)` | whole minutes to add to a test's windows, from its repeat and retry index, so each run counts only its own records (the fake keeps every request since it started) |

## Shared fixtures (`wire/fixtures/`)

| File | Written by | Read by |
|---|---|---|
| `json/promql-range-counter.json`, `promql-instant-gauge.json`, `promql-instant-scalar.json` | `go test ./internal/gateway -run Golden -update` (the gateway against the fake, at a fixed `Deps.Now`) | `unit:range-golden` (byte for byte) and the client's `unit:decode-frames` and `HttpApi` tests |
| `json/logql-streams-backward-{1,2}.json`, `logql-streams-forward-{1,2,3}.json`, `logql-metric.json`, `logql-volume.json` | `go test ./internal/gateway -run 'TestLogqlGolden$' -args -update` (the log routes against the fake, `Deps.Now` 1767229300000) | `unit:logql-golden` (byte for byte) and the client's `unit:decode-logs` |
| `json/promql-step.json` | by hand (the PromQL step cases, #303) | `unit:promql-step` in Go (`PromGrid`) and TypeScript (`promGrid`) |
| `json/log-step.json` | by hand (the log routes' step cases, the #62 rule) | `unit:log-step` in Go (`LogGrid`) and TypeScript (`logGrid`) |
| `keyhash/labels.json` | `go test ./internal/keyhash -run Corpus -update` (then frozen) | `unit:keyhash-corpus`; the empty set's key is the published XXH3-64 of empty input |

Regenerate a golden file only with a change that means to move it, and review the diff: the first
golden files were checked against an independent writer of the frame format.

`server/internal/pulsusdb/testdata/adversarial/` holds the upstream bodies of
`unit:redact-adversarial`: the binding's secret, Basic token, URL and host planted (as
`@SECRET@`, `@TOKEN@`, `@URL@`, `@HOST@`) in every string field. They are not in `Default()`.

## The logql contract subtest

`itest:pulsusdb-contract` has a subtest `logql` that checks, on a real deployment and read-only,
the properties the log pager depends on. It needs, besides the contract variables of the
[client page](../server/pulsusdb.md#contract-test), a LogQL selector with recent data:

```bash
DASH_CONTRACT_PULSUSDB_URL=<base URL> DASH_CONTRACT_LOGQL_SELECTOR='{service_name="<a service>"}' \
  go -C server test -tags itest -count=1 -run 'TestPulsusDBContract/logql' -v ./internal/pulsusdb/
```

Keep both values in your environment or `dev/local.env`; never commit them.

**Reference window.** The subtest first needs a complete reference: every entry of a window, which
holds while a backward request with `limit` 5 000 returns fewer than 5 000. `reduceRefWindow`
(`internal/pulsusdb/contract_window_test.go`, run without a build tag by `unit:contract-window`)
starts on `(now − 15 min, now − 5 min]` and, while the answer is full, keeps the half that holds
the newest timestamp. It makes at most 20 requests and none on a window under 1 ms. An answer of
more than 5 000 entries, or a request error, fails the subtest. Two outcomes **skip** it, with
these texts:

- `logql contract: no entries for DASH_CONTRACT_LOGQL_SELECTOR in (now-15m, now-5m]; choose a selector with recent data`;
- `logql contract: selector too dense: 5000 entries in a <w> ns window after <n> requests; choose a narrower selector`.

Both are properties of the chosen selector's data, not of PulsusDB. **A skipped `logql` subtest is
not evidence**: run it again with another selector before you refresh the probe evidence.

On the reference it checks the window semantics `(start, end]`; that the `%019d` and the unpadded
timestamps give equal results; property (a), a group fetch `(T − 1, T]` returning exactly the
reference's entries at `T` in both directions (for up to 6 tie groups); property (b), that a
limited answer (`limit` 1, 7 and 50, both directions) holds exactly the reference's entries before
its last timestamp; that LogQL errors are 400 `text/plain` with `at byte N`, and `limit=5001` is 400;
and that `LogQueryRange` with `limit` 5 000 and with `limit` 3 gives the same entries, every page
in page order. Its raw requests send `categorize-labels`, as page requests do; the `categorised`
case asserts that PulsusDB answers with `data.encodingFlags` naming it and an object third element
on every entry, and that the same request without the flag gets the plain shape. It logs, without asserting, whether `resultType` precedes `result`, and whether a
GET with a query over 8 KiB is accepted; the client's POST fallback for such a query must succeed.

## The logql-lexer contract subtest

`itest:pulsusdb-contract` has a second LogQL subtest, `logql-lexer` (#121,
`internal/pulsusdb/lexer_itest_test.go`), that pins what PulsusDB's LogQL lexer does with the
bytes the planner relies on: a `#` outside a string is refused at its own byte (there are no
comments, CR or LF after it changes nothing), and U+FFFD is accepted in `"…"` and `` `…` ``, each
string ending at its own quote. It sends the twelve texts P1 to P12 of `lexerCases`
(`internal/pulsusdb/lexer_record_test.go`) to `GET /api/logs/v1/query_range` over `(now − 5 min,
now]` with `limit` 1, `backward` and the page request's decoration, then reads the build info: 13
sequential read-only requests, each within the 30 s deadline. It needs only the base URL:

```bash
set -a; . dev/local.env; set +a        # the development base URL lives only here
DASH_CONTRACT_PULSUSDB_URL="$PULSUS_DASH_DATASOURCE_URL" DASH_CONTRACT_RECORD_DIR="$(mktemp -d)" \
  go -C server test -tags itest -count=1 -run 'TestPulsusDBContract/logql-lexer$' -v ./internal/pulsusdb/
```

Never commit the URL. Without `DASH_CONTRACT_PULSUSDB_URL` the whole contract test skips. The
subtest has its own client on a clone of the default transport, not the contract test's buffering
`recorder` transport, so a probe body is read only through `io.LimitReader` at 64 KiB + 1: a larger
body is the error `too large`. Every answer must equal its case: a 400 is `text/plain;
charset=utf-8` with the exact message, a 200 is `application/json` with `status` `success`,
`resultType` `streams`, an empty `result`, zero stats and no flag but `categorize-labels`, and
nothing else (unknown members fail). The build info must be a 200 with a plain `x.y.z`
`data.version`.

**Recording.** With `DASH_CONTRACT_RECORD_DIR` set, the recorder writes three files there:
`logs-fffd-dq.json` and `logs-fffd-bq.json` for `internal/pulsusfake/testdata/`, and
`lexer-transcript.txt`, the evidence (a header with the version and date, then one line per case
with its query, status and message or `result=empty streams`). The recorder's rules:

| Rule | What |
|---|---|
| synthesised | every file is built from constants and validated facts (the version, the date, whether `encodingFlags` was present); no received byte is copied |
| leaks | every raw body, every decoded JSON string and every file is checked against the base URL, the URL without its scheme, the host name, the host, `DASH_CONTRACT_PULSUSDB_ORG` and the resolved credential: as is, lowercased, percent-decoded up to three times, with `\uXXXX`, `\xHH` and `&#…;` escapes decoded, and each secret also percent-encoded and in standard and URL base64 |
| all or none | the directory must exist, be empty and lie outside the repository; each file is written as `.<name>.tmp` and renamed once all are written, and any failure removes what was written |
| redacted | a failure prints only `logql-lexer: <id>: <reason>` with a reason code (`status`, `content type`, `message differs`, `unknown field`, `body`, `result not empty`, `stats not zero`, `flag not allowed`, `leak`, `transport`, `too large`, `version withheld`), never a body, header, decoded string or secret |

Copy the two transcripts into `testdata/`, then run `make no-pulsusdb-host` (with `dev/local.env`)
and `go test ./internal/pulsusfake`, and remove the record directory. **A failing row means
PulsusDB's lexer changed**: the planner's model (no comments, row 9b, U+FFFD as itself) must be
planned again in an issue; never edit an expectation to match. `unit:lexer-record`
(`TestLexerRecord`, `TestLexerRunPath`) runs the whole path, recorder included, against an
`httptest` server on every `go test`.

### Probe evidence

`server/internal/pulsusdb/testdata/logs-evidence-2026-11-21.json` records the probes behind the
pager's design (#65): development PulsusDB 0.0.12, `POST /api/logs/v1/query_range` with a form,
four selectors `S1` to `S4`. It is sanitised: selectors replaced, and no labels, lines or
timestamps, only counts and booleans (group fetches complete, one order per group and direction,
limited subsets, property (b) holding). To refresh it, run the probes read-only against a
development PulsusDB, keep the raw output in a scratch directory, write only counts and booleans
with the `captured`, `pulsusdb`, `method` and `sanitised` header, and run the `logql` subtest
(not skipped) on the same deployment.

## Gates

| Gate | File |
|---|---|
| `unit:fake-transcripts` | `internal/pulsusfake/fake_test.go` (with `TestMaxRecords`) |
| `unit:log-paging`, `unit:log-window`, `unit:log-decode` | `internal/pulsusdb/logpage_test.go` |
| `unit:log-member-order` | `internal/pulsusdb/memberorder_test.go`, `updec_test.go` |
| `unit:log-level`, `unit:logql-calls`, `unit:volume-compose`, `unit:volume-buffered` | `internal/pulsusdb/logql_test.go` |
| `unit:log-categorized`, `unit:log-level` (entry level) | `internal/pulsusdb/categorized_test.go` |
| `unit:text-errors` | `internal/pulsusdb/errors_test.go` |
| `unit:query-hash` | `internal/keyhash/keyhash_test.go` |
| `unit:contract-window` | `internal/pulsusdb/contract_window_test.go` |
| `ci:go-test` (control mode, e2e transcripts) | `cmd/pulsus-fake/control_test.go`, `cmd/pulsus-fake/transcripts_test.go` |
| `unit:stream-decode`, `unit:updec`, `unit:decoration`, `unit:retry-budget`, `unit:tenant-limit`, `unit:timeout-budget`, `unit:credential-strength`, `unit:virtual-guard`, `unit:sanitise`, `unit:error-position`, `unit:promql-step` | `internal/pulsusdb/*_test.go` |
| `unit:range-golden`, `unit:range-streams`, `unit:range-abort`, `unit:prom-routes`, `unit:body-validation`, `unit:upstream-errors`, `unit:deadlines`, `unit:body-limits`, `unit:redact-adversarial`, `unit:redact-prop`, `unit:permission-declared` | `internal/gateway/*_test.go` |
| `unit:log-cursor` | `internal/gateway/cursor_test.go` |
| `unit:logql-routes`, `unit:log-time-range`, `unit:logql-golden`, `unit:virtual-guard` (log routes) | `internal/gateway/logql_test.go` |
| `unit:logs-completion`, `unit:log-time-range` (GET routes) | `internal/gateway/logs_test.go` |
| `unit:sanitise` (log lines and text errors), `unit:deadlines` (log routes) | `internal/gateway/redact_test.go`, `deadline_test.go` |
| `itest:promql-range`, `itest:promql-errors`, `itest:cancel`, `itest:cancel-mid-stream`, `itest:tenant-header`, `itest:datasource-check` | `cmd/pulsus-dash/query_itest_test.go` (`make itest`) |
| `itest:logql-streams`, `itest:logql-metric`, `itest:logql-volume`, `itest:logql-errors`, `itest:logql-cancel`, `itest:logql-lexer` | `cmd/pulsus-dash/logql_itest_test.go` (`make itest`) |
| `itest:logql-hash-refused` | `internal/gateway/logplan_test.go` (`TestLogqlHashRefused`) |
| `unit:lexer-record` | `internal/pulsusdb/lexer_record_test.go` (`TestLexerRecord`, `TestLexerRunPath`) |
| `itest:pulsusdb-contract` | `internal/pulsusdb/contract_itest_test.go`, only with `DASH_CONTRACT_PULSUSDB_URL` (the `logql` subtest also with `DASH_CONTRACT_LOGQL_SELECTOR`; `logql-lexer` in `lexer_itest_test.go`) |

## Designs

T05-002 and the gate catalogue in [T05](../../designs/technical/T05-testing-and-performance.md)
§7.1; T06-005 and T06-011 in [T06](../../designs/technical/T06-bff-architecture.md); T04-004 in
[T04](../../designs/technical/T04-wire-format-and-data-plane.md).
