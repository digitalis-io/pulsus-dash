# Annotations API

Annotations are the events that boards draw as markers on their time panels: deploys,
configuration changes, feature flag changes and notes (INT-031). The server stores them in Postgres
and serves them over REST under `/api/dash/v1/annotations`. A CI pipeline posts a deploy when it
ships; the board reads the annotations of its time window once and draws them on every line, bars
and heatmap panel (see [Charts: event markers](../client/charts.md#event-markers) and
[Boards: event markers](../client/boards.md#event-markers)).

The contract is in `api/openapi.yaml` (tag `annotations`). The three routes have hand-written
handlers (`server/internal/gateway/annotations.go`) and are excluded from the generated server; the
client's TypeScript types are generated from the same document. The design is
[ADR-0023](../../designs/adr/0023-chart-event-markers.md) and
[T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) §5.9 (the entity, the data
scope, the filters and the keyset paging of the Change feed), and the table is
[T11](../../designs/technical/T11-postgres-schema.md) §4.4.

## Scope and actor

Annotations belong to the organisation: every tenant binding of the organisation, and so every
board of every tenant, sees the same annotations. The routes take no `tenant` parameter; the client
checks its tenant as it does for boards and then calls the organisation's route. A tenant column is
a later, expand-only change.

There is no authentication or permission check yet (decision D12 in
[the designs README](../../designs/README.md)). The routes declare `x-permission`
`annotation.read` (list) and `annotation.write` (create, delete) for when permissions arrive. Every
request acts as the fixed local principal with the full data scope, which is the author of every
annotation and the actor of every audit event. The data scope rules below are enforced already and
apply as soon as authentication gives a principal a narrower scope.

## The annotation

```json
{
  "id": "0193b2c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "at": 1767227400000,
  "end_at": null,
  "kind": "deploy",
  "text": "v2.31",
  "tags": ["ci", "checkout"],
  "entity": {
    "id": "bb7487bd-100d-a998-e0f0-3c65f11da1a7",
    "binding": "prod-eu",
    "kind": "service",
    "ident": [null, "checkout"]
  }
}
```

| Field | Type | Rule |
|---|---|---|
| `id` | string | a lower-case UUID (v7), assigned by the server |
| `at` | integer | ms since the Unix epoch, 0 … 253402300799999 (9999-12-31T23:59:59.999Z) |
| `end_at` | integer or null | the end of a ranged event, in ms; `null` for a point. At or after `at`, at most 31 days (2 678 400 000 ms) after it. Boards show it in the tooltip only |
| `kind` | string | `deploy`, `config`, `flag` or `annotation` (a note). Boards draw ◆, ⚙ and ⚑ before the text; a note has no glyph |
| `text` | string | 1 to 500 code points, not only white space, no NUL; stored as sent and drawn as plain text |
| `tags` | array of strings | at most 16, each `^[a-z0-9][a-z0-9_.:/-]{0,63}$`, no repeats; `[]` when none were sent |
| `entity` | object or null | the entity the change is about, or `null` for an organisation-wide change: `id` (its `EntityId`), `binding` (the tenant binding's slug), `kind`, and `ident` (the identifying values in schema order, `null` for an absent optional position). The binding's id and the attribute map are stored but never returned |

`AnnotationList` is

```json
{ "items": [Annotation…], "truncated": false, "applied": {}, "next": null, "orgWideHidden": 0 }
```

(see [List](#list)). An annotation is the JSON image of the `events/1` wire schema ([T04](../../designs/technical/T04-wire-format-and-data-plane.md) §0):
`ts` is `at`, `end` is `end_at`, `title` is `text` and `attrs` is `tags`.

## Routes

| Route | OK | Errors |
|---|---|---|
| `GET /api/dash/v1/annotations?from=<ms>&to=<ms>[&limit=<n>][&kind=…][&tag=…][&entity=…][&orgWide=…][&beforeAt=<ms>&beforeId=<id>]` | 200 `AnnotationList` | 400, 403, 503 |
| `POST /api/dash/v1/annotations` with an `AnnotationCreate` body | 201 `Annotation` | 400, 403, 413, 503 |
| `DELETE /api/dash/v1/annotations/{id}` | 204 | 400, 403, 404, 503 |

### List

`GET` returns the annotations that overlap the window `[from, to]`: `at <= to` and
`coalesce(end_at, at) >= from`, so a range that started before the window and ends inside it is
included. Only the rows inside the caller's [data scope](#data-scope) and the filters are read.
They come newest first (`at`, then `id`, descending), at most `limit` (default and maximum 500).

`from` and `to` are canonical decimal integers (no sign, no leading zeros, at most 15 digits) of at
most 253402300799999, and `from` must be less than `to`. `limit` is an integer 1 … 500.

The filters are optional; a repeated parameter is given once per value
(`kind=deploy&kind=config`):

| Parameter | Values | Meaning |
|---|---|---|
| `kind` | 1–4 kinds, no repeats | any of these kinds |
| `tag` | 1–8 tags, no repeats | all of these tags |
| `entity` | 1–16 lower-case `EntityId`s, no repeats | any of these entities; organisation-wide changes are left out |
| `orgWide` | `true` or `false`, once; only with `entity` | `true` also lists the organisation-wide changes |
| `beforeAt`, `beforeId` | both or neither, once each: an epoch ms and a lower-case UUID | the keyset cursor: only rows with `(at, id) < (beforeAt, beforeId)` |

The answer:

- `items`: the page.
- `next`: `{"at", "id"}` of the page's last row when more rows follow, else `null`. Pass it back
  as `beforeAt` and `beforeId` for the next page. The server reads `limit + 1` rows and trims the
  extra one, so `next` is never set on a last page.
- `truncated`: `true` exactly when `next` is not `null`.
- `applied`: what the server applied, each given parameter as parsed with its values in request
  order (`kinds`, `tags`, `entity`, `orgWide`, `before`), or `{}`. A server before this version
  answers without `applied`; clients treat such an answer as from an old server (T24-038).
- `orgWideHidden`: with full scope, the number of organisation-wide changes in the window that an
  `entity` filter without `orgWide=true` left out (0 without an entity filter); `null` when the
  scope is not full.

The rows, `next` and `orgWideHidden` come from one SQL statement, so they are one snapshot. Across
pages a row appears at most once: one inserted above a passed cursor is not shown until the client
starts again from page 0, one inserted below it appears on a later page, and one deleted before its
page is read never appears (T24-032). Times are stored at millisecond precision, so the cursor is
exact.

A board's event markers read one page of 500 with no filter; with more, the board shows "Showing
the newest 500 events in this time range."

### Create

`POST` takes an `AnnotationCreate`: `at`, `kind` and `text` are required, and `end_at` (null or
absent for a point), `tags` and `entity` are optional. No other key is allowed. The body is at most
16 KiB. The answer is the stored annotation, with its `id`, `end_at` (`null` for a point), `tags`
(`[]` when none were sent) and `entity` (`null` when none was sent). Times are kept at millisecond
precision.

`entity` (absent or `null` for an organisation-wide change) names the entity the change is about:

```json
{"binding": "prod-eu", "kind": "service", "attrs": {"service.name": "checkout"}}
```

`binding` is the slug of one of the organisation's tenant bindings, `kind` a kind of the entity
kind table and `attrs` its identifying attributes, each value a string of 1 to 256 code points. The
server canonicalises it (see [Entity identity](#entity-identity)), stores only the canonical form,
and answers the entity with its `EntityId`.

### Delete

`DELETE` removes one annotation by id. An unknown id, an id of another organisation and an id
outside the caller's data scope are the same 404.

## Entity identity

An entity is identified as in [T12-010](../../designs/technical/T12-entity-catalogue.md#t12-010--stable-identity-64-bit-wire-id),
by the entity kind table of T12 §4.2 (version 8, in `server/internal/entity/kinds.go`). Each kind
has identifying **positions** in schema order; a position lists its alternative attribute names
(`a|b`: the first present is taken), may be optional, and may have a constant used when none is
present. For example `service` is `[service.namespace?, service.name]`, `cluster` is
`[k8s.cluster.uid|k8s.cluster.name]` and `provider` is `[cloud.provider|"on-prem"]`. The 19 kinds
are `environment`, `provider`, `organisation`, `account`, `region`, `zone`, `site`, `rack`,
`cluster`, `node`, `namespace`, `workload`, `pod`, `container`, `host`, `process`, `service`,
`route` and `resource`; any other kind is invalid.

Canonicalisation of a submitted `attrs` map:

- every key must be an alternative of one of the kind's positions;
- every value must be a JSON string of 1 to 256 code points without NUL;
- when several alternatives of one position are present, their values must be equal;
- a position takes its present value, else its constant, else it is absent if optional; a missing
  required position is invalid.

The **canonical map** holds each present position under its first alternative's name:
`{"k8s.cluster.name": "prod-eu-1"}` for a cluster is stored as `{"k8s.cluster.uid": "prod-eu-1"}`,
and `deployment.environment` as `deployment.environment.name`. Only the canonical map is stored and
read.

The `EntityId` is the XXH3-128 (default secret and seed) of the bytes

`enc(binding id's 16 bytes) ‖ enc(kind) ‖` for each position in schema order `enc(value)`, or the
byte `0x00` when an optional position is absent,

where `enc(x)` is `0x01`, then `len(x)` as a uvarint, then `x` (strings as their exact UTF-8
bytes). The 128 bits are written high half first, big-endian, as a lower-case UUID. So
`service {service.name: checkout}` on the binding `00000000-0000-4000-8000-0000000000e1` is the 38
bytes `0110000000000000400080000000000000e1010773657276696365000108636865636b6f7574` and the id
`bb7487bd-100d-a998-e0f0-3c65f11da1a7`. The same entity on another binding has another id. The
vectors are in `wire/fixtures/json/entity-id.json`.

## Data scope

Every request carries a data scope. Until authentication it is always the full scope; the rules
below are what a narrower scope does ([T12-018](../../designs/technical/T12-entity-catalogue.md#t12-018--no-hidden-identifier-in-any-response)).

A scope is a list of clauses, OR-ed; a clause allows some bindings (or any) and, per attribute, a
list of values. The server compiles each clause per kind of the kind table: an attribute maps to the
kind's position through any of its alternatives, under the position's canonical name; attributes on
one position intersect their values; an attribute with no position in a kind drops the clause for
that kind. A clause with an empty binding list allows nothing and is refused (403) before any
statement runs, as is a request with no scope at all.

The compiled scope is a predicate `P` inside each route's one statement: a row passes with full
scope, or when it has an entity and a clause matches its kind, binding and canonical map.
**Organisation-wide changes are visible with full scope only.**

- **List:** rows outside `P` are never read, so they reach no item, cursor or count;
  `orgWideHidden` is `null` when scoped.
- **Create:** the entity must be covered by the scope, else 403 at `/entity` with
  `annotations.entity.scope`; a create without an entity needs full scope, else 403 at `/entity`
  with `annotations.scope`. Nothing is written.
- **Delete:** a row outside `P` is the same 404 as an absent row, and no audit event is written.

Text and tags are free content and are never parsed for entity names. With scopes, don't name other
services in change text: a principal who can see the change sees its text.

## Errors

Errors use the gateway's envelope (`{"error": {"code", "message", "fields"}}`). A validation error
is 400 `invalid`, message "invalid request", with exactly one field: the first rule that fails, in
this order.

| Pointer | `message_key` | Rule |
|---|---|---|
| `/from`, `/to` | `annotations.window.invalid` | absent or not a canonical integer 0 … 253402300799999; `from` not less than `to` is reported on `/to` |
| `/limit` | `annotations.limit.range` | not an integer 1 … 500 |
| `/<key>` | `annotation.unknown` | a body key that is not in `AnnotationCreate` (the first in sorted order; RFC 6901 escaping) |
| `/at` | `annotation.at.range` | absent, or not an integer literal 0 … 253402300799999 |
| `/end_at` | `annotation.end.order` | before `at`, or not an integer literal 0 … 253402300799999 |
| `/end_at` | `annotation.end.span` | more than 31 days after `at` |
| `/kind` | `annotation.kind.invalid` | absent, or not one of the four kinds |
| `/text` | `annotation.text.length` | absent, not a string, only white space (Unicode spaces), containing NUL, or more than 500 code points |
| `/tags` | `annotation.tags.count` | more than 16 tags (`annotation.tags.invalid` when `tags` is not an array) |
| `/tags/<i>` | `annotation.tags.invalid` | the tag at index `i` is not a string matching the pattern |
| `/tags/<i>` | `annotation.tags.duplicate` | the tag at index `i` repeats an earlier one |
| `/entity` | `annotations.entity.invalid` | not an object with exactly `binding`, `kind` and `attrs`; `binding` or `kind` not a string; `attrs` not an object; or the entity does not canonicalise (an unknown kind, an attribute of no position, a non-string, empty, NUL-holding or over-256-code-point value, a conflict, a missing required position) |
| `/entity/binding` | `annotations.entity.binding` | `binding` is not a slug (`^[a-z0-9-]{1,40}$`), or no tenant binding of the organisation has it |
| `/id` | `annotation.id.invalid` | the path id is not a lower-case canonical UUID |

The list's filters are checked after `limit`, in this order, each with one field:

| Pointer | `message_key` | Rule |
|---|---|---|
| `/kind` | `annotations.kind.invalid` | more than 4 values, a value that is not a kind, or a repeat |
| `/tag` | `annotations.tag.invalid` | more than 8 values, a value that does not match the tag pattern, or a repeat |
| `/entity` | `annotations.entity.invalid` | more than 16 values, a value that is not a lower-case UUID (`checkout`, upper case), or a repeat |
| `/orgWide` | `annotations.orgWide.invalid` | given twice, not `true` or `false`, or given without `entity` |
| `/beforeAt` | `annotations.beforeAt.invalid` | given twice, not a canonical integer 0 … 253402300799999, or absent while `beforeId` is given |
| `/beforeId` | `annotations.beforeId.invalid` | given twice, not a lower-case canonical UUID, or absent while `beforeAt` is given |

A missing partner of the cursor is reported on its own pointer: `beforeId` alone is a `/beforeAt`
error.

| Status | When |
|---|---|
| 400 `invalid` "invalid request", no fields | the body is not exactly one JSON object (empty, an array, a string, or an object followed by more data) |
| 413 `invalid` | the body is larger than 16 KiB |
| 403 `scope_denied` "data scope denied", no fields | the request has no data scope, or a scope that allows nothing; no statement runs |
| 403 `scope_denied` "outside your data scope", one field | a create outside the scope (`/entity`, `annotations.entity.scope` or `annotations.scope`) |
| 404 `not_found` "annotation not found" | delete of an id the organisation does not have, or outside the data scope |
| 503 `unavailable` | the server has no Postgres (no annotations service), or a store error; the error is logged with the operation and the request id |

The database repeats every rule as a CHECK (`kind`, text length, tag count, the 31-day range), so a
row that bypasses the API cannot break them either.

## Audit

Each create and each delete appends one event to the organisation's hash-chained audit log in the
same transaction (T11-017). The resource kind is `annotation` and the resource id is the
annotation's id.

| Action | Diff |
|---|---|
| `annotation.create` | `[{"op":"add","path":"","value":A}]` |
| `annotation.delete` | `[{"op":"test","path":"","value":A},{"op":"remove","path":""}]` |

`A` is the annotation as the API returns it, `entity` included. A delete of an absent id, or of a
row outside the data scope, appends nothing.

## Posting from CI

The routes are relative to the server's base URL, which is the address the dashboard is served
from. A deploy step can post one marker like this:

```bash
# PULSUS_DASH_URL is the server's base URL, set by the pipeline.
curl -fsS -X POST "$PULSUS_DASH_URL/api/dash/v1/annotations" \
  -H 'Content-Type: application/json' \
  -d "{\"at\": $(date +%s%3N), \"kind\": \"deploy\", \"text\": \"checkout v2.31\", \"tags\": [\"ci\", \"checkout\"]}"
```

`date +%s%3N` is GNU date's ms since the epoch. A pipeline that posts in a loop is safe for the
boards: they show the newest 500 in a window and gather close markers into `+N` chips.

To attach the change to the service it deployed, add `entity` with the binding the service reports
to:

```bash
curl -fsS -X POST "$PULSUS_DASH_URL/api/dash/v1/annotations" \
  -H 'Content-Type: application/json' \
  -d "{\"at\": $(date +%s%3N), \"kind\": \"deploy\", \"text\": \"checkout v2.31\",
       \"entity\": {\"binding\": \"prod-eu\", \"kind\": \"service\", \"attrs\": {\"service.name\": \"checkout\"}}}"
```

Keep sending `entity` unchanged: a server before this version answers 400 `annotation.unknown` at
`/entity` and records nothing, so the step fails visibly rather than recording the change without
its entity.

## Limits

- At most 500 annotations per page, the newest first; older pages through the cursor.
- At most 4 kinds, 8 tags and 16 entities per filter.
- Ranges are at most 31 days. That bound keeps the list query's index scan exact: it reads
  `at >= from − 31 days`.
- The table is not partitioned; annotations are expected to be few (deploys and changes, not
  telemetry).
- There is no update route; delete and post again.

## Designs

VIZ-053 (the Change feed, server side) and VIZ-027 (`applied`, `next`); T24-030, T24-031, T24-032,
T24-038 and §5.9, §6 in [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md);
T12-010 and T12-018 in [T12](../../designs/technical/T12-entity-catalogue.md); T11-003, T11-012,
T11-013, T11-015, T11-017 and T11-023 in [T11](../../designs/technical/T11-postgres-schema.md);
[ADR-0023](../../designs/adr/0023-chart-event-markers.md),
[ADR-0015](../../designs/adr/0015-go-bff.md).
