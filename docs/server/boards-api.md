# Boards API

The server stores boards as versioned documents in Postgres and serves them over REST under
`/api/dash/v1`. Each save writes an immutable version and one audit event, with optimistic
concurrency through `ETag` and `If-Match`. The same API keeps the starred and recently viewed
boards of the principal. The contract is in `api/openapi.yaml` (tag `boards`), and the client's
TypeScript types are generated from it.

Boards belong to the organisation: every tenant binding of the organisation sees the same boards.
There is no authentication or permission check yet (decision D12 in
[the designs README](../../designs/README.md)). Every request acts as the fixed local principal:
id `00000000-0000-0000-0000-000000000001`, kind `local`, shown as `Local user`. It is the author of
every version, the actor of every audit event, and the owner of the starred and recent lists.

The tables are described in [the database page](database.md#schema-migration-2).

## Board spec v1

A board is a JSON object, called the spec. The server stores it with `schema_version` 1.

```json
{
  "title": "Service overview",
  "time": { "from": "now-6h", "to": "now" },
  "panels": [
    {
      "id": "p-1",
      "title": "Request rate",
      "grid": { "x": 0, "y": 0, "w": 6, "h": 8 },
      "query": { "lang": "promql", "text": "sum(rate(http_requests_total[5m]))" },
      "vis": { "kind": "line" }
    }
  ],
  "sections": [
    { "id": "s-1", "title": "Latency", "collapsed": true, "panels": [] }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `title` | string, required | not empty after trimming; at most 200 characters |
| `time` | object, optional | the saved time range: `from` and `to`, both required (IA-002). Omit the key for none; `null` is refused |
| `time.from`, `time.to` | string | `now`, `now/d`, `now-<n><unit>` (`n` 1–99999, unit `s`, `m`, `h`, `d` or `w`), or an RFC 3339 time with minutes, optional seconds and milliseconds, and `Z` or an offset |
| `panels` | array, required | the ungrouped panels, drawn above the sections |
| `sections` | array, required | at most 50 |
| `sections[].id` | string | `^[a-z0-9-]{1,40}$`, unique in the board |
| `sections[].title` | string | at most 200 characters |
| `sections[].collapsed` | boolean | a collapsed section renders and queries nothing |
| `sections[].panels` | array | the section's panels, in their own grid |
| `panels[].id` | string | `^[a-z0-9-]{1,40}$`, unique in the board (panels and sections share one namespace) |
| `panels[].title` | string | at most 200 characters |
| `panels[].grid` | object | `x` 0–11, `w` 1–12, `x + w` ≤ 12, `y` 0–9999, `h` 1–100, all integers. The grid has 12 columns; two panels of the same grid (the top level, or one section) must not overlap |
| `panels[].query` | object | `lang` `promql` or `logql`; `text` at most 16 384 bytes |
| `panels[].vis` | object | `kind` `auto`, `line`, `bars`, `heatmap`, `stat` or `logs` |

A board has at most 200 panels in total, counting the panels of every section (SRF-019). No string
may contain U+0000. The request body, including the spec, is at most 2 MiB (T06-021).

### Request bodies

Before a create or an update reaches the handler, the server reads the whole body, at most 2 MiB
(413 `request body too large` otherwise, even when the excess follows a complete JSON value), and
checks its envelope with the same shape rules as the spec:

| Route | Envelope |
|---|---|
| `POST /api/dash/v1/boards` | `{"spec": …}`: `spec` required, no other key |
| `PUT /api/dash/v1/boards/{uid}` | `{"spec": …, "message": "…"}`: `spec` required, `message` an optional string, no other key |

Exactly one JSON object, exact keys and case, no repeated key, no `null`, and nothing after the
object. A refused envelope answers 400 `invalid` with message `invalid request` and `fields` whose
pointers are relative to the body, for example
`{"pointer":"/extra","message_key":"board.json.unknownKey"}`, `/spec` `board.json.required` or
`board.json.duplicateKey`, `""` `board.json.invalid` for trailing data. Nothing is written. The
`spec` value is then checked as described next, with pointers relative to the spec.

### Validation

The server decodes the spec strictly before anything is written (`internal/spec`). A refused spec
answers 400 with `error.code` `invalid`, message `invalid board`, and `error.fields`: one entry per
problem, `{"pointer": "<JSON pointer>", "message_key": "<key>"}`. Problems are listed in document
order, at most 50. A key in a pointer is escaped (`~` → `~0`, `/` → `~1`).

The first pass checks the shape, token by token:

| Problem | Pointer | `message_key` |
|---|---|---|
| not JSON, empty, or data after the object | `""` | `board.json.invalid` |
| a key repeated in one object | the key | `board.json.duplicateKey` |
| a key that is not in the table above, including a wrongly cased one (`Title`) | the key | `board.json.unknownKey` |
| a required key absent (reported after the object's last key) | the key | `board.json.required` |
| a `null` value | the key | `board.json.null` |
| a value of the wrong type, including `1.5`, `1e2` or `2147483648` for a grid value | the value | `board.json.type` |

Only a spec with a clean shape goes on to the rules:

| Rule | Pointer | `message_key` |
|---|---|---|
| title empty after trimming | `/title` | `board.title.required` |
| title over 200 characters | `/title` | `board.title.tooLong` |
| a time not in the forms above | `/time/from`, `/time/to` | `board.time.invalid` |
| more than 200 panels in total | `/panels` | `board.panels.tooMany` |
| more than 50 sections | `/sections` | `board.sections.tooMany` |
| an id not matching `^[a-z0-9-]{1,40}$` | `…/id` | `board.id.invalid` |
| an id used earlier in the board | `…/id` of the later one | `board.id.duplicate` |
| a panel or section title over 200 characters | `…/title` | `board.panel.title.tooLong`, `board.section.title.tooLong` |
| a grid out of bounds | `…/grid` | `board.grid.outOfBounds` |
| a grid overlapping an earlier panel of the same grid | `…/grid` of the later one | `board.grid.overlap` |
| `query.lang` not `promql` or `logql` | `…/query/lang` | `board.query.lang.invalid` |
| `query.text` over 16 384 bytes | `…/query/text` | `board.query.text.tooLong` |
| `vis.kind` not one of the six kinds | `…/vis/kind` | `board.vis.kind.invalid` |
| a string containing U+0000 | that string | `board.string.nul` |

`…` is `/panels/<i>`, `/sections/<j>/panels/<i>`, or `/sections/<j>` for a section. The shared
fixtures `api/fixtures/board-spec/` hold a minimal and a full valid board, and `invalid.json` with
one case per problem and its exact `fields`. The server's tests and the client's tests both run
them.

### Canonical JSON and the content hash

The server stores the spec in canonical form: object keys sorted, no insignificant whitespace, no
HTML escaping, numbers as written. The `content_hash` of a version is the SHA-256 of that form. For
example, `{"title":"New board","panels":[],"sections":[]}` is stored as
`{"panels":[],"sections":[],"title":"New board"}` (47 bytes, SHA-256
`f40543b019d375e2e7aa7965bfb4a7fe190d742bcc402550e821a5523725bb37`). Every response returns the
spec in this form.

### Versions and the upcaster

A save of a spec whose canonical form differs from the head writes version `n + 1` and moves the
head (T11-006). A save of an identical spec is a no-op: no version, no audit event, the same ETag,
and `changed: false` in the response. Versions are never updated or deleted.

Every stored spec is read through the upcaster (T11 §4.0, T11-016). Version 1 is the current
version and reads unchanged. A spec stored by a newer server (a rolling upgrade) answers 503
`board saved by a newer server version`, and is never overwritten by the older server.

## Concurrency: `ETag` and `If-Match`

Every board has an `etag`, a counter that starts at 1 and grows on every change, including a delete
(T11-005). `GET`, `POST` and `PUT` return it as the `ETag` header, `"<etag>"` (for example `"3"`),
and in the body as the string `etag` (`"3"`). `PUT` and `DELETE` require the header
`If-Match: "<etag>"` of the board as the client read it:

| `If-Match` | Response |
|---|---|
| absent or empty | 428 `invalid` `If-Match is required` |
| not one strong tag `"<n>"` with `n` ≥ 1 (for example `W/"1"`, `*`, `"1", "2"`, `1`, `"01"`) | 400 `invalid` `If-Match must be an ETag from this API` |
| not the board's current `etag` | 409 `conflict` |
| the board's current `etag` | the write proceeds |

Two saves with the same `If-Match` are serialised by a row lock. The second sees the moved ETag and
gets 409. The 409 body is not the error envelope:

```json
{
  "error": { "code": "conflict", "message": "board changed since it was read" },
  "current": { "uid": "…", "title": "…", "version": 2, "etag": "2", "spec": { … }, … },
  "submitted": { "title": "…", "panels": [], "sections": [] }
}
```

`current` is the board as it is now, and `submitted` is the spec the save sent. A conflicting
delete has no `submitted`. The client can show both, and save again with the new ETag.

## Routes

Every board route answers 503 `unavailable` `configuration store unavailable` when the server has
no store (also when Postgres fails), and 404 `not_found` `board not found` for a uid that does not
match `^[a-z0-9-]{1,40}$`, an unknown or deleted board, or a board of another organisation.

| Route | Request | Success | Errors |
|---|---|---|---|
| `GET /api/dash/v1/boards` | — | 200 `{"items":[BoardSummary…],"truncated":false}`, most recently updated first, at most 1000 (`truncated` is true when there are more) | 503 |
| `POST /api/dash/v1/boards` | `{"spec":{…}}` | 201 `Board`, headers `ETag` and `Location: /api/dash/v1/boards/<uid>` | 400, 413, 503 |
| `GET /api/dash/v1/boards/{uid}` | — | 200 `Board`, header `ETag` | 404, 503 |
| `PUT /api/dash/v1/boards/{uid}` | `If-Match`; `{"spec":{…},"message":"…"}` (`message` optional, at most 500 characters) | 200 `{"board":Board,"changed":true}`, header `ETag` | 400, 404, 409, 413, 428, 503 |
| `DELETE /api/dash/v1/boards/{uid}` | `If-Match` | 204 | 400, 404, 409, 428, 503 |
| `GET /api/dash/v1/me/starred-boards` | — | 200 `{"items":[{"uid","title"}…]}`, by title, at most 200 | 503 |
| `PUT /api/dash/v1/me/starred-boards/{uid}` | — | 204; starring twice is a no-op | 404, 503 |
| `DELETE /api/dash/v1/me/starred-boards/{uid}` | — | 204; also for a board that is not starred, unknown or deleted | 503 |
| `GET /api/dash/v1/me/recent-boards?limit=n` | `limit` 1–50, default 5 (0 or less counts as 1, over 50 as 50) | 200 `{"items":[{"uid","title"}…]}`, most recent first | 503 |
| `PUT /api/dash/v1/me/recent-boards/{uid}?at=ms` | `at` optional: the client's navigation time in ms since the Unix epoch, 0–253402300799999 (else 400 `invalid`, "invalid request"; not an integer: 400) | 204; records a view at `at` clamped to now − 1 day … now + 5 min (absent: now); the greater of the stored and the new time wins | 400, 404, 503 |

`BoardSummary` is `{uid, title, version, updated_at, updated_by}`, and `Board` adds `etag`,
`schema_version` and `spec`. `updated_at` is the time of the head version and `updated_by` its
author, `{"kind":"local","name":"Local user"}`. A board's uid is 14 characters of `[0-9a-z]` from a
cryptographic random source. A new board goes into the organisation's root folder.

### Examples

```bash
B=http://localhost:8080/api/dash/v1

# Create a board.
curl -si -X POST "$B/boards" -H 'Content-Type: application/json' \
  -d '{"spec":{"title":"New board","panels":[],"sections":[]}}'
# HTTP/1.1 201 Created
# Etag: "1"
# Location: /api/dash/v1/boards/k3v9x0q2m7a1zp

# Read it, then save a change with the ETag that was read.
curl -s "$B/boards/k3v9x0q2m7a1zp"
curl -si -X PUT "$B/boards/k3v9x0q2m7a1zp" -H 'If-Match: "1"' -H 'Content-Type: application/json' \
  -d '{"spec":{"title":"Checkout","time":{"from":"now-1h","to":"now"},"panels":[],"sections":[]},"message":"rename"}'

# List, then delete (soft delete) with the current ETag.
curl -s "$B/boards"
curl -si -X DELETE "$B/boards/k3v9x0q2m7a1zp" -H 'If-Match: "2"'

# Star a board, record a view, and list both.
curl -si -X PUT "$B/me/starred-boards/k3v9x0q2m7a1zp"
curl -si -X DELETE "$B/me/starred-boards/k3v9x0q2m7a1zp"
curl -s "$B/me/starred-boards"
curl -si -X PUT "$B/me/recent-boards/k3v9x0q2m7a1zp"
# A view at the client's navigation time (ms since the epoch), as the web client sends it.
curl -si -X PUT "$B/me/recent-boards/k3v9x0q2m7a1zp?at=$(date +%s%3N)"
curl -s "$B/me/recent-boards?limit=10"
```

### Delete

A delete is a soft delete: the board gets `deleted_at` and a new ETag, and its versions and audit
events stay. A deleted board answers 404 and leaves the list, the starred list and the recent list.

### Starred and recent boards

The starred and recent lists belong to the principal, in its organisation. Each view recorded with
`PUT /me/recent-boards/{uid}` stores a view time for the board, and the recent list is ordered by
it, newest first:

- With `at`, the view time is the client's navigation time, clamped to [now − 1 day, now + 5 min]
  (now is the transaction's start, `now()`); without `at`, it is now. A fast client clock can
  therefore not pin a board at the top for more than 5 minutes.
- The greater of the stored and the new time wins, so a view whose request commits late (for
  example after the client gave up waiting) never moves a board above a later view.
- On an equal time, the later write sorts first: a view whose time is within 1 ms of another
  board's is stored 1 µs after it.

**Ordering guarantee:** Recent follows navigation order within one app instance (stamps are
monotonic per app); across browsers or app instances the order is best effort and subject to clock
skew; ties on an equal timestamp are broken by the later write; clamped views use the server
transaction start time (`now()`), best effort.

The server keeps the 200 most recent views per principal and drops older ones; concurrent views of
one principal are serialised by a transaction-scoped advisory lock on the organisation and user, so
the limit and the tie-break also hold under concurrency. A list returns at most 50.

## Audit events

Every create, change and delete writes one row of `audit_events` in the same transaction as the
change, so the two commit or roll back together (T11-006, T06-004):

| `action` | When | `diff` |
|---|---|---|
| `board.create` | `POST` | `[{"op":"add","path":"","value":<spec>}]` |
| `board.update` | a `PUT` that changed the spec | the RFC 6902 JSON Patch from the previous spec to the new one |
| `board.delete` | `DELETE` | none (`NULL`) |

`resource_kind` is `board`, `resource_id` the uid, `actor_kind` `local`, `actor_id` the local
principal's id, and `request_id` the request's `X-Request-Id`. The patch compares the two canonical
specs: objects key by key in sorted order (remove, add, or compare the values), arrays index by
index, then removes from the end and adds at the end; anything else is a `replace`.

The events of an organisation form a hash chain (T11-017):
`hash = SHA-256(prev_hash ‖ canonical event)`, where the event is the JSON object of `action`,
`actor_id`, `actor_kind`, `at` (UTC, microseconds, `2006-01-02T15:04:05.000000Z`), `diff`, `id`,
`org_id`, `request_id`, `resource_id` and `resource_kind`, with `null` for an absent `actor_id`,
`request_id` or `diff`. The first event has no `prev_hash`. Appends are serialised per organisation
by an advisory lock; each event's `at` is strictly after the previous one. The chain head is kept
in `audit_chain_heads`, so the chain continues when older events pass the retention floor. The app
role cannot update or delete audit events (T11-017).

## Errors

| Status | `error.code` | Message | When |
|---|---|---|---|
| 400 | `invalid` | `invalid board` (with `fields`) | the spec is refused ([validation](#validation)) |
| 400 | `invalid` | `invalid request` (with `fields`) | the envelope is refused ([request bodies](#request-bodies)) |
| 400 | `invalid` | `bad request` | the body cannot be read, or a parameter does not parse |
| 400 | `invalid` | `message must be valid text of at most 500 characters` | `message` too long or containing U+0000 |
| 400 | `invalid` | `If-Match must be an ETag from this API` | see [concurrency](#concurrency-etag-and-if-match) |
| 404 | `not_found` | `board not found` | see [routes](#routes) |
| 409 | `conflict` | `board changed since it was read` | stale `If-Match` (body `BoardConflict`) |
| 413 | `invalid` | `request body too large` | a body over 2 MiB |
| 428 | `invalid` | `If-Match is required` | `PUT` or `DELETE` without `If-Match` |
| 503 | `unavailable` | `board saved by a newer server version` | the head was written by a newer schema version; logged at `warn` |
| 503 | `unavailable` | `configuration store unavailable` | no store, or Postgres failed (logged at `error` as `msg=boards` with `op` and `error`), including a save whose month has no audit partition |

A request whose client went away is rolled back and writes nothing.

## Designs

IA-001, IA-002 (the saved time range), IA-003, IA-006, IA-021 (Starred and Recent, the ordering
guarantee) and ENT-022 (subsets) in
[02](../../designs/product/02-information-architecture.md) and
[11](../../designs/product/11-enterprise.md); T06-021 (body limit) and §5.2 (`conflict`) in
[T06](../../designs/technical/T06-bff-architecture.md); T11-005, T11-006, T11-016, T11-017 and §4.3
(`recent_views.viewed_at`) in
[T11](../../designs/technical/T11-postgres-schema.md); gates `unit:board-spec`, `itest:board-crud`
and `itest:board-prefs` in [T05](../../designs/technical/T05-testing-and-performance.md) §7.1;
[ADR-0012](../../designs/adr/0012-derived-state-in-postgres.md),
[ADR-0015](../../designs/adr/0015-go-bff.md).
