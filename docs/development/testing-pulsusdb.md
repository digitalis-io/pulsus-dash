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
| `response.status`, `headers` | written as given |
| `response.body` | written byte for byte as it appears in the file |
| `response.delay_ms` | wait before answering (cut short, and recorded as cancelled, if the client goes away) |
| `response.hang` | never answer: block until the client goes away, then record the cancel |

**Captured** transcripts keep the shape, key order and message text of a response taken from a
development PulsusDB, with labels, values, timestamps and query ids replaced. Nothing that
identifies the deployment is kept: no host, URL or tenant. Query ids are `fake-<name>-1`.
**Synthetic** transcripts cover what cannot be captured read-only (a timeout, a stall, the
`truncated` flag, keys in reverse order) and say why in `provenance.synthetic`.

The 17 transcripts cover a counter (with the NaN, ±Inf, −0 and subnormal edge values), a
histogram, a truncated result (warning and flag), reordered keys, a gauge vector, a scalar, two
parse errors (with and without a position), a timeout, a hang, a too-broad selector, labels, label
values, series, metadata and runtime info.

### Adding a transcript

1. Capture the response of a development PulsusDB, read-only. Keep the capture in a scratch
   directory, never in the repository.
2. Replace every label name and value, sample value, timestamp and query id with synthetic ones.
   Remove anything that names the deployment.
3. Write the file with its `provenance`. Keep the body exactly as PulsusDB wrote it otherwise.
4. Run `make no-pulsusdb-host` (with your `dev/local.env`, so your host is on the forbidden list)
   and `go test ./internal/pulsusfake`.

## Matching

For each request the fake parses the form (query string and body). The first transcript whose
method and path match and whose `match.query` equals the form's `query` wins; otherwise the first
whose method and path match and that has no `match.query`. The request is recorded before it is
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
| `WaitCancelled(ctx, name)` | waits until a request answered by transcript `name` was cancelled; the itests use it with the `hang` transcript |
| `Unexpected()` | the requests no transcript matched |
| `Reset()` | forgets the records |

A stall handler must read the request body (for example `r.ParseForm()`), as PulsusDB does: Go's
HTTP server notices that the client went away only once the body was read.

## In the dev stack: the generator

`cmd/pulsus-fake` (`--listen`, default `localhost:9091`; `--transcripts DIR`, default the embedded
set; `--generate`, default `true`) serves the fake for `make dev-up` ([dev stack](dev-stack.md)).
With the generator on, an unmatched `/api/v1/query_range` or `/api/v1/query` gets one series
`{fake="generated"}` with the value `sin(t / 600)` (t in seconds) on the request's grid or at its
time, and `X-Pulsus-Query-Id: fake-generated`, so any query draws a line. It writes one JSON log
line per request (`method`, `path`, `transcript`, `status`, `cancelled`) and keeps no history.

The image is `dev/pulsus-fake.Dockerfile`, a static binary on `scratch`; its
`dev/pulsus-fake.Dockerfile.dockerignore` sends only `server/` (without `server/build`). The CI gate
`ci:fake-image` builds and runs it and checks that `runtimeinfo` answers with
`X-Pulsus-Query-Id: fake-runtimeinfo-1` within 10 s.

## Shared fixtures (`wire/fixtures/`)

| File | Written by | Read by |
|---|---|---|
| `json/promql-range-counter.json`, `promql-instant-gauge.json`, `promql-instant-scalar.json` | `go test ./internal/gateway -run Golden -update` (the gateway against the fake, at a fixed `Deps.Now`) | `unit:range-golden` (byte for byte) and the client's `unit:decode-frames` and `HttpApi` tests |
| `json/promql-step.json` | by hand (the step cases) | `unit:promql-step` in Go (`PromGrid`) and TypeScript (`promGrid`) |
| `keyhash/labels.json` | `go test ./internal/keyhash -run Corpus -update` (then frozen) | `unit:keyhash-corpus`; the empty set's key is the published XXH3-64 of empty input |

Regenerate a golden file only with a change that means to move it, and review the diff: the first
golden files were checked against an independent writer of the frame format.

`server/internal/pulsusdb/testdata/adversarial/` holds the upstream bodies of
`unit:redact-adversarial`: the binding's secret, Basic token, URL and host planted (as
`@SECRET@`, `@TOKEN@`, `@URL@`, `@HOST@`) in every string field. They are not in `Default()`.

## Gates

| Gate | File |
|---|---|
| `unit:fake-transcripts` | `internal/pulsusfake/fake_test.go` |
| `unit:stream-decode`, `unit:updec`, `unit:decoration`, `unit:retry-budget`, `unit:tenant-limit`, `unit:timeout-budget`, `unit:credential-strength`, `unit:virtual-guard`, `unit:sanitise`, `unit:error-position`, `unit:promql-step` | `internal/pulsusdb/*_test.go` |
| `unit:range-golden`, `unit:range-streams`, `unit:range-abort`, `unit:prom-routes`, `unit:body-validation`, `unit:upstream-errors`, `unit:deadlines`, `unit:body-limits`, `unit:redact-adversarial`, `unit:redact-prop`, `unit:permission-declared` | `internal/gateway/*_test.go` |
| `itest:promql-range`, `itest:promql-errors`, `itest:cancel`, `itest:cancel-mid-stream`, `itest:tenant-header`, `itest:datasource-check` | `cmd/pulsus-dash/query_itest_test.go` (`make itest`) |
| `itest:pulsusdb-contract` | `internal/pulsusdb/contract_itest_test.go`, only with `DASH_CONTRACT_PULSUSDB_URL` |

## Designs

T05-002 and the gate catalogue in [T05](../../designs/technical/T05-testing-and-performance.md)
§7.1; T06-005 and T06-011 in [T06](../../designs/technical/T06-bff-architecture.md); T04-004 in
[T04](../../designs/technical/T04-wire-format-and-data-plane.md).
