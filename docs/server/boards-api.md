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

The tables are described in [the database page](database.md#schema-migration-2), and the board
tags cache in [migration 4](database.md#schema-migration-4).

## Board spec v4

A board is a JSON object, called the spec. The server stores it with `schema_version` 4. Version 2
(#64 Part B) adds the optional `vis.thresholds` and `vis.legend` to version 1; version 3 (#173
Part 1) adds the optional `vis.options` and the kinds `barchart` and `pie`; version 4 (#215) adds
the optional `tags`. Each version is otherwise the same as the one before (see
[Versions and the upcaster](#versions-and-the-upcaster)).

```json
{
  "title": "Service overview",
  "time": { "from": "now-6h", "to": "now" },
  "tags": ["team:payments", "prod"],
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
| `tags` | array, optional (v4) | 0 to 16 unique tags, each `^[a-z0-9][a-z0-9_.:/-]{0,63}$` (the `AnnotationTag` of the annotations API). Their order is kept; `[]` is the same as no key (the canonical form drops it); `null` is refused. The list's search and tag filter match them ([listing and search](#listing-and-search)) |
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
| `panels[].vis` | object | `kind` `auto`, `line`, `bars`, `heatmap`, `stat`, `logs`, `barchart` or `pie`. The web client does not draw `barchart` and `pie` yet: such a panel sends no query and says so ([the panel runtime](../client/boards.md#pending-kinds)) |
| `panels[].vis.thresholds` | object, optional | `direction` `above` or `below`, and `steps`: 1 to 8 objects of `value` (a number: 0, or 1e-9 ≤ \|value\| ≤ 1e15; no two equal), `state` (`watch`, `degraded` or `failing`) and `label` (at most 200 characters; `""` shows the value). Valid on every kind; drawn on line, bars and stat |
| `panels[].vis.legend` | object, optional | `mode` `table` or `hidden`; absent means `table` |
| `panels[].vis.options` | object, optional | the kind's options, every key optional (below). `{}` is valid on every kind; `null` is refused |

#### `vis.options` (v3)

Which keys a kind allows, their types and their values (T22 §6.1). Any other key is
`board.json.unknownKey`, whatever its value. The server reads the members of `vis` in any order:
`options` may come before `kind`.

| Key | Type | Values | Kinds |
|---|---|---|---|
| `reducer` | string | `last`, `first`, `mean`, `min`, `max`, `sum`, `count` | auto, barchart, pie, stat |
| `baselineOffset` | string | `1h`, `1d`, `7d`, `28d` | barchart, stat |
| `categoryBy` | string | `""` (use the effective label), or a label name `^[A-Za-z_][A-Za-z0-9_.]{0,99}$` | barchart, pie |
| `sort` | string | `valueDesc`, `valueAsc`, `label`, `none` | barchart, pie, stat |
| `orientation` | string | `horizontal`, `vertical`; on stat also `auto` | barchart, stat |
| `valueLabels` | boolean | | barchart |
| `min`, `max` | number | \|v\| ≤ 1e15; when both are set, `min` < `max` | barchart, stat |
| `donut` | boolean | | pie |
| `labels` | string | `percent`, `value`, `name`, `none` | pie |
| `parts` | boolean | | auto, pie |
| `layout` | string | `single`, `grid` | stat |
| `colourMode` | string | `value`, `background`, `none` | stat |
| `textMode` | string | `auto`, `value`, `valueAndName`, `name`; not `value` with `layout` `grid` | stat |
| `graphMode` | string | `sparkline`, `none` | stat |

`line`, `bars`, `heatmap` and `logs` allow no key. Depth options (`perspective`, `projection`,
`depth`, `tilt`, `shadow`, `3d`) are never allowed (T22-002). The keys are held in one table on
each side (`internal/spec/shape.go`, `client/src/boards/options.ts`), and both suites compare it
with `api/fixtures/board-spec/option-keys.json`.

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
| a key that is not in the table above, including a wrongly cased one (`Title`), and an option key the panel's kind does not allow | the key | `board.json.unknownKey` |
| a required key absent (reported after the object's last key) | the key | `board.json.required` |
| a `null` value | the key | `board.json.null` |
| a value of the wrong type, including `1.5`, `1e2` or `2147483648` for a grid value, and a threshold `value` that is not a number or not a finite one (`"1"`, `1e400`) | the value | `board.json.type` |

`vis.options` is checked after the rest of its `vis` object (its problems follow that object's
own), against the keys of the kind: an unknown key first, its value skipped, then types and
`null`. A `vis.options` that is `null` or not an object is reported in place. When `kind` is not a
string, its type error is the only problem; when it is a string but not a kind, the options are
not checked and the rules report the kind.

Only a spec with a clean shape goes on to the rules:

| Rule | Pointer | `message_key` |
|---|---|---|
| title empty after trimming | `/title` | `board.title.required` |
| title over 200 characters | `/title` | `board.title.tooLong` |
| a time not in the forms above | `/time/from`, `/time/to` | `board.time.invalid` |
| more than 16 tags | `/tags` | `board.tags.invalid` |
| a tag not matching `^[a-z0-9][a-z0-9_.:/-]{0,63}$` (every tag is checked, even past 16) | `/tags/<i>` | `board.tags.invalid` |
| else a tag equal to an earlier one | `/tags/<i>` of the later one | `board.tags.duplicate` |
| more than 200 panels in total | `/panels` | `board.panels.tooMany` |
| more than 50 sections | `/sections` | `board.sections.tooMany` |
| an id not matching `^[a-z0-9-]{1,40}$` | `…/id` | `board.id.invalid` |
| an id used earlier in the board | `…/id` of the later one | `board.id.duplicate` |
| a panel or section title over 200 characters | `…/title` | `board.panel.title.tooLong`, `board.section.title.tooLong` |
| a grid out of bounds | `…/grid` | `board.grid.outOfBounds` |
| a grid overlapping an earlier panel of the same grid | `…/grid` of the later one | `board.grid.overlap` |
| `query.lang` not `promql` or `logql` | `…/query/lang` | `board.query.lang.invalid` |
| `query.text` over 16 384 bytes | `…/query/text` | `board.query.text.tooLong` |
| `vis.kind` not one of the eight kinds | `…/vis/kind` | `board.vis.kind.invalid` |
| `thresholds.direction` not `above` or `below` | `…/vis/thresholds/direction` | `board.thresholds.direction.invalid` |
| no step, or more than 8 | `…/vis/thresholds/steps` | `board.thresholds.steps.count` |
| a step value not 0 and smaller than 1e-9 or larger than 1e15 in size (every step is checked) | `…/vis/thresholds/steps/<k>/value` | `board.thresholds.value.range` |
| else a step value equal to an earlier step's | `…/vis/thresholds/steps/<k>/value` | `board.thresholds.value.duplicate` |
| a step state not `watch`, `degraded` or `failing` | `…/steps/<k>/state` | `board.thresholds.state.invalid` |
| a step label over 200 characters | `…/steps/<k>/label` | `board.thresholds.label.tooLong` |
| `legend.mode` not `table` or `hidden` | `…/vis/legend/mode` | `board.legend.mode.invalid` |
| an option value outside its values (an enum, a `categoryBy` that is neither `""` nor a label name, a `min` or `max` over 1e15 in size, `orientation` `auto` off stat, `textMode` `value` with `layout` `grid`) | `…/vis/options/<key>` | `board.options.<key>.invalid` |
| both bounds set and `min` ≥ `max` (only when `min` itself is valid) | `…/vis/options/max` | `board.options.max.invalid` |
| a string containing U+0000 | that string | `board.string.nul` |

`…` is `/panels/<i>`, `/sections/<j>/panels/<i>`, or `/sections/<j>` for a section. The tag rules
come after the time and before the panels. The threshold
rules come after `vis.kind`, in this order for each step, then the legend, then the options in
the key order of the table above. The value range keeps a threshold far
inside the range where the value-axis ticks are safe (#97). The shared fixtures
`api/fixtures/board-spec/` hold a minimal and a full valid board of each version (`v1-*.json`,
`v2-full.json`, `v2-threshold-bounds.json` with -1e-9, 0 and 1e-9, `v3-full.json` with every
option key of each kind, and `v4-board-tags.json` with two tags), the option table
`option-keys.json`, and `invalid.json` with
one case per problem and its exact `fields`. The server's tests and the client's tests both run
them.

### Canonical JSON and the content hash

The server stores the spec in canonical form: object keys sorted, no insignificant whitespace, no
HTML escaping, numbers as written. A threshold value is written as Go prints a `float64` (the
ECMAScript form `JSON.stringify` gives, for example `1000000000000000` for `1e15` and `1e-9`), so
a board saved by the web client keeps its `content_hash`. The `content_hash` of a version is the
SHA-256 of that form. For
example, `{"title":"New board","panels":[],"sections":[]}` is stored as
`{"panels":[],"sections":[],"title":"New board"}` (47 bytes, SHA-256
`f40543b019d375e2e7aa7965bfb4a7fe190d742bcc402550e821a5523725bb37`). Every response returns the
spec in this form.

### Versions and the upcaster

A save of a spec whose canonical form differs from the head writes version `n + 1` and moves the
head (T11-006). A save of an identical spec is a no-op: no version, no audit event, the same ETag,
and `changed: false` in the response. Versions are never updated or deleted.

Every stored spec is read through the upcaster (T11 §4.0, T11-016). Version 4 is the current
version; a version 1, 2 or 3 spec is a subset of it and reads unchanged (the identity upcast). Every
write stores version 4. The spec itself needs no SQL migration (`schema_version` is an existing
column); migration 4 adds only the tags cache the list reads. A spec stored by a newer server (a
rolling upgrade) answers 503 `board saved by a newer server version`, and is never overwritten by
the older server.

| Server | Reads a v1, v2 or v3 row | Reads a v4 row | Writes |
|---|---|---|---|
| this release | unchanged | parsed | `schema_version` 4 |
| the previous release, during a rolling upgrade | yes | 503 `unavailable` (too new); nothing is written | 3 |

`spec.DecodeBoardUpTo(raw, version, max)` holds the rule (`version > max` is too new);
`DecodeBoard` calls it with `BoardSchemaVersion`. The itest `TestPreviousServerRefusesNewerRow`
reads a real v4 row with `max` 3, as the previous release did, and `TestSaveWritesSchemaV4` checks
what a save stores. `make itest-old-binary` runs the previous release's binary itself beside this
one ([the database page](database.md#old-binaries-and-make-itest-old-binary)).

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
| `GET /api/dash/v1/boards?q=…&tag=…` | `q`, `tag` optional ([listing and search](#listing-and-search)) | 200 `BoardList` `{"items":[BoardSummary…],"truncated":false,"applied":{},"tagsStale":0}`, most recently updated first, at most 1000 (`truncated` is true when more matched) | 400, 503 |
| `POST /api/dash/v1/boards` | `{"spec":{…}}` | 201 `Board`, headers `ETag` and `Location: /api/dash/v1/boards/<uid>` | 400, 413, 503 |
| `GET /api/dash/v1/boards/{uid}` | — | 200 `Board`, header `ETag` | 404, 503 |
| `PUT /api/dash/v1/boards/{uid}` | `If-Match`; `{"spec":{…},"message":"…"}` (`message` optional, at most 500 characters) | 200 `{"board":Board,"changed":true}`, header `ETag` | 400, 404, 409, 413, 428, 503 |
| `DELETE /api/dash/v1/boards/{uid}` | `If-Match` | 204 | 400, 404, 409, 428, 503 |
| `GET /api/dash/v1/me/starred-boards` | — | 200 `{"items":[{"uid","title"}…],"applied":{},"truncated":false}`, by title, at most 200 (`truncated` is true when more are starred) | 503 |
| `PUT /api/dash/v1/me/starred-boards/{uid}` | — | 204; starring twice is a no-op | 404, 503 |
| `DELETE /api/dash/v1/me/starred-boards/{uid}` | — | 204; also for a board that is not starred, unknown or deleted | 503 |
| `GET /api/dash/v1/me/recent-boards?limit=n` | `limit` 1–50, default 5 (0 or less counts as 1, over 50 as 50) | 200 `{"items":[{"uid","title"}…],"applied":{},"truncated":false}`, most recent first (`truncated` is true when more than `limit` were viewed) | 503 |
| `PUT /api/dash/v1/me/recent-boards/{uid}?at=ms` | `at` optional: the client's navigation time in ms since the Unix epoch, 0–253402300799999 (else 400 `invalid`, "invalid request"; not an integer: 400) | 204; records a view at `at` clamped to now − 1 day … now + 5 min (absent: now); the greater of the stored and the new time wins | 400, 404, 503 |

`BoardSummary` is `{uid, title, version, updated_at, updated_by, tags}`, and `Board` adds `etag`,
`schema_version` and `spec` (a `Board` has no `tags` member of its own: they are in `spec`).
`updated_at` is the time of the head version and `updated_by` its author,
`{"kind":"local","name":"Local user"}`. `tags` is the head spec's tags (`[]` when it has none), or
`null` when the server does not know them yet ([listing and search](#listing-and-search)). A
board's uid is 14 characters of `[0-9a-z]` from a cryptographic random source. A new board goes
into the organisation's root folder.

### Listing and search

`GET /api/dash/v1/boards` takes two optional filters (T24-021); both must match when both are
given:

| Parameter | Valid | Matches |
|---|---|---|
| `q` | 1 to 100 characters of UTF-8, no control character (U+0000–001F, U+007F–009F); kept as sent, not trimmed | a board whose title contains `q`, or one of whose known tags equals `q`. Case is folded for ASCII letters only (`checkout` finds `CHECKOUT`, `zürich` does not find `ZÜRICH`); `%` and `_` are literal characters; tags match whole (`fin` does not find `finance`) |
| `tag` | a tag, `^[a-z0-9][a-z0-9_.:/-]{0,63}$` | a board one of whose known tags equals `tag` exactly |

A refused value answers 400 `invalid` `invalid request` before the store is touched, with
`fields` `[{"pointer":"/q","message_key":"boards.q.invalid"}]` or
`[{"pointer":"/tag","message_key":"boards.tag.invalid"}]`; when both are refused, only `/q` is
reported. A repeated `q` or `tag` answers 400 with `field.type` at its pointer. `q=` (empty) is
refused; leave the parameter out to list every board.

The answer:

| Member | Meaning |
|---|---|
| `items` | at most 1000 matching boards, most recently updated first (then by uid) |
| `truncated` | more than 1000 boards matched |
| `applied` | the filters the server applied, echoed: `{}`, `{"q":"…"}`, `{"tag":"…"}` or both. A server without this member predates search and ignored the filters |
| `tagsStale` | how many live boards of the organisation have tags the server does not know yet |

**Tags not yet known.** The list reads tags from a cache in `boards` that every save by this
release keeps current. A board last saved by an older release (or created before migration 4) has
a stale cache row: it is listed with `tags: null`, matches `q` by its title only, never matches
`tag`, and counts in `tagsStale`. Each list first repairs at most 200 stale rows of the
organisation, from their head specs, in a short transaction of its own (2 s statement and 500 ms
lock timeouts, skipping rows a save holds), so the count falls by up to 200 per list. A failed
repair is logged at `warn` (`msg="boards: tag repair failed"`, `op=repair_tags`, `sqlstate`,
`request_id`; never the error text, titles or tags) and does not fail the list. The rows,
`truncated` and `tagsStale` of one answer come from one statement, so they agree with each other.
The repair writes no audit event and does not change any ETag.

```bash
curl -s "$B/boards?q=checkout"
# {"items":[{"uid":"k3v9x0q2m7a1zp","title":"Checkout overview","version":3,
#   "updated_at":"2026-11-26T10:00:00Z","updated_by":{"kind":"local","name":"Local user"},
#   "tags":["team:payments"]}],"truncated":false,"applied":{"q":"checkout"},"tagsStale":0}
curl -s "$B/boards?tag=team:payments&q=overview"
curl -s "$B/boards?q=$(printf 'a%.0s' {1..101})"
# 400 {"error":{"code":"invalid","message":"invalid request",
#   "fields":[{"pointer":"/q","message_key":"boards.q.invalid"}]}}
```

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
  example after the client gave up waiting) never moves a board above a later view of the same
  app instance, as long as both times are inside the window. Clamped views (and views without
  `at`) order by the transaction start, best effort, which is not commit order; views from other
  browsers or app instances order by their clocks, best effort.
- On an equal time, the later write sorts first: when the new time falls in the same millisecond
  as other boards' times, those keep their order a microsecond apart below it and the new view
  takes the millisecond's last microsecond. A tie never moves a view into a later millisecond.

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
| 400 | `invalid` | `invalid request` (with `fields`) | the envelope is refused ([request bodies](#request-bodies)), or a list's `q` (`boards.q.invalid`) or `tag` (`boards.tag.invalid`) is ([listing and search](#listing-and-search)) |
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
[T11](../../designs/technical/T11-postgres-schema.md); gates `unit:board-spec`, `itest:board-crud`,
`itest:board-prefs`, `itest:board-find`, `itest:board-tags`, `itest:board-list-snapshot` and
`itest:board-tags-old-binary` in [T05](../../designs/technical/T05-testing-and-performance.md) §7.1;
board tags and the board search (T24-021, T24-029, §5.5, §5.6, §6; VIZ-053, SRF-026) in
[T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md);
board spec v3 (`vis.options`, T22-002, §6.1; VIZ-031, VIZ-086) in
[T22](../../designs/technical/T22-value-categorical-and-table-panels.md);
[ADR-0012](../../designs/adr/0012-derived-state-in-postgres.md),
[ADR-0015](../../designs/adr/0015-go-bff.md).
