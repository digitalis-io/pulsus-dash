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
[ADR-0023](../../designs/adr/0023-chart-event-markers.md), and the table is
[T11](../../designs/technical/T11-postgres-schema.md) §4.4.

## Scope and actor

Annotations belong to the organisation: every tenant binding of the organisation, and so every
board of every tenant, sees the same annotations. The routes take no `tenant` parameter; the client
checks its tenant as it does for boards and then calls the organisation's route. A tenant column is
a later, expand-only change.

There is no authentication or permission check yet (decision D12 in
[the designs README](../../designs/README.md)). The routes declare `x-permission`
`annotation.read` (list) and `annotation.write` (create, delete) for when permissions arrive. Every
request acts as the fixed local principal, which is the author of every annotation and the actor of
every audit event.

## The annotation

```json
{
  "id": "0193b2c4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
  "at": 1767227400000,
  "end_at": null,
  "kind": "deploy",
  "text": "v2.31",
  "tags": ["ci", "checkout"]
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

`AnnotationList` is `{ "items": [Annotation…], "truncated": boolean }`. It is the JSON image of the
`events/1` wire schema ([T04](../../designs/technical/T04-wire-format-and-data-plane.md) §0):
`ts` is `at`, `end` is `end_at`, `title` is `text` and `attrs` is `tags`.

## Routes

| Route | OK | Errors |
|---|---|---|
| `GET /api/dash/v1/annotations?from=<ms>&to=<ms>[&limit=<n>]` | 200 `AnnotationList` | 400, 503 |
| `POST /api/dash/v1/annotations` with an `AnnotationCreate` body | 201 `Annotation` | 400, 413, 503 |
| `DELETE /api/dash/v1/annotations/{id}` | 204 | 400, 404, 503 |

### List

`GET` returns the annotations that overlap the window `[from, to]`: `at <= to` and
`coalesce(end_at, at) >= from`, so a range that started before the window and ends inside it is
included. They come newest first (`at`, then `id`, descending), at most `limit` (default and
maximum 500). `truncated` is `true` when more annotations overlap the window than were returned. The
board then shows "Showing the newest 500 events in this time range."

`from` and `to` are canonical decimal integers (no sign, no leading zeros, at most 15 digits) of at
most 253402300799999, and `from` must be less than `to`. `limit` is an integer 1 … 500.

### Create

`POST` takes an `AnnotationCreate`: `at`, `kind` and `text` are required, and `end_at` (null or
absent for a point) and `tags` are optional. No other key is allowed. The body is at most 16 KiB.
The answer is the stored annotation, with its `id`, `end_at` (`null` for a point) and `tags` (`[]`
when none were sent). Times are kept at millisecond precision.

### Delete

`DELETE` removes one annotation by id. An unknown id, or an id of another organisation, is 404.

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
| `/id` | `annotation.id.invalid` | the path id is not a lower-case canonical UUID |

| Status | When |
|---|---|
| 400 `invalid` "invalid request", no fields | the body is not exactly one JSON object (empty, an array, a string, or an object followed by more data) |
| 413 `invalid` | the body is larger than 16 KiB |
| 404 `not_found` "annotation not found" | delete of an id the organisation does not have |
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

`A` is the annotation as the API returns it. A delete of an absent id appends nothing.

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

## Limits

- At most 500 annotations per list, the newest first.
- Ranges are at most 31 days. That bound keeps the list query's index scan exact: it reads
  `at >= from − 31 days`.
- The table is not partitioned; annotations are expected to be few (deploys and changes, not
  telemetry).
- There is no update route; delete and post again.
