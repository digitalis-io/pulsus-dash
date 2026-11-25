# Explore: logs

**Explore › Logs** runs one LogQL query against the tenant's data source. A log query shows how many
lines arrived over time, by level, and the lines themselves; a metric query (such as
`sum by (level) (count_over_time({app="checkout"}[1m]))`) shows a line chart. The tenant in the
address chooses the data source. The time range, the auto-refresh interval and **Refresh now** in
the header apply here as on boards and on Explore › Metrics. This page is for people who read logs;
how the page is built is in [Explore: the Logs page](../client/explore.md#logs-page).

The page has a **Query** card, then the result: the **Volume** and **Log lines** cards for a log
query, or the **Result** card for a metric query. Before the first query it says "Run a query to
see log lines".

## Writing a query

The **Query** card has the `LogQL` tag, the Run hint (`Shift+Enter`) and the **Run** button, then
the query editor and a status line.

- **Completion.** Inside `{…}` the editor offers label names, and label values after `=`, `!=`,
  `=~` or `!~`. The suggestions come from the data source over the time range shown. After the
  selector it offers the pipeline stages (`|=`, `|~`, `| json`, `| logfmt`, `| line_format` and the
  rest), the functions of metric queries, and the durations inside `[…]`.
- **Run keys.** **Shift+Enter**, **Ctrl+Enter** (**⌘+Enter** on macOS) or **Run** run the query.
  Enter alone starts a new line. **Esc** leaves the editor and moves the focus to **Run** (when a
  completion list is open, Esc closes it first).
- **If the editor cannot load**, the query box is plain text with a message to reload. Run and
  Shift+Enter (or Ctrl/⌘+Enter) still run the query.
- **Running the same query again** (Run with the text unchanged) cancels the requests still in
  flight and starts the stream and the volume again.
- **Running an empty query** clears the result.

Run is disabled, with the note "Run is available once the chart has a size.", until the editor and
the width of the results are known. This takes a moment after the page opens.

The text is sent as you typed it. The server builds the volume query from it and checks the size.

## Errors

A failed query shows its message in the status line.

- A **syntax error** from PulsusDB underlines the place it reports in the editor (for
  `{app="x"`, the last character, with "expected '}'"). When PulsusDB gives no position, the whole
  query is underlined and the message ends "(position unknown)". Editing the query removes the
  underline.
- **Too broad** (too many streams) and **timed out** errors offer **Narrow the time range**, which
  halves the time range around its centre.
- **Busy**, **unavailable**, a network error and an unknown tenant are shown as such, as on
  Explore › Metrics.
- When only the volume fails, the **Volume** card says "The volume could not be loaded: …" and the
  lines still show. When the lines fail too, only the status line reports it.

## Reading the volume

The **Volume** card is a bar chart of the lines in each time step, stacked by level: critical,
error, warning, info, debug, trace and lines without a level, from the bottom up. Each level has
its own colour, the same as its bar in the log lines. The tooltip under the pointer (or the
keyboard crosshair) names each level with its count, so the colours are never the only clue.

- **Brush** (drag with the right mouse button, or **Alt** and drag) across the bars to set the
  time range of the whole page to that span: the volume and the lines run again for it. It is one
  step in the browser history, so **Back** returns to the previous range.
- **Double-click** zooms out.
- With the keyboard, focus the chart and use the arrow keys to read the values under the
  crosshair.

## The log lines

The **Log lines** card lists the lines, **newest first** by default.

- **Order**: **Newest first** or **Oldest first**. Changing it runs the query again in that order.
- **Wrap lines** wraps long lines onto several rows. It changes nothing that is loaded.
- Each line starts with a coloured bar and a three-letter level glyph, then the time and the
  line. The glyphs are `CRT` (critical), `ERR` (error), `WRN` (warning), `INF` (info), `DBG`
  (debug), `TRC` (trace) and `UNK` (no level). Screen readers announce the level's name, not the
  glyph.
- **Loading more.** The lines arrive in pages of 1 000. Scrolling near the end loads the next page;
  scrolling back past lines that were let go loads them again. **End of results** marks the last
  line of the time range. When a page fails, the list shows **Retry**.
- **Changed lines.** When lines loaded again differ from the first time (the data changed), the list
  says "These lines changed since they were loaded." with **Run again**, which starts the lines
  from the first page (the volume is left as it is).

## Inspect and select

Click a log line (or select a bar in the volume, or a point of a metric query's chart) to open the
**Inspector** over the right of the page, as on [boards](boards.md#inspect-and-select): the line
itself, its level, its exact time in nanoseconds and in your time zone, its stream labels, metadata
and parsed fields, pivots and the query. Selecting text in a line does not open it. The clicked line
is the page's **selection**: matching lines are highlighted with a bar in the gutter, the other
lines of the same stream go grey, and the volume shows the instant as a band.

By keyboard: Tab to the log lines, press **Enter** to focus the first visible line, move with ↑ and
↓, and press **Enter** (or **Space**) to inspect it. **Escape** clears the selection, then closes
the Inspector. **Edit query** (✎) moves the focus to the query editor. The **Logs ±1 min** chip
opens the lines one minute either side of this one, for the same stream labels.

## Metric queries

A metric query (a range aggregation such as `count_over_time`, `rate` or `sum by (…)`) draws a line
chart in the **Result** card, one line per series, and no volume or lines. The first time it runs
the page shows the Volume and Log lines cards until the answer arrives. Running it again keeps the
last chart, with a thin bar along its top while it waits more than 300 ms; when the run fails the
chart stays and the status line shows the error. The status line says how many series came back
and the step.

## Partial data

When PulsusDB returns only part of a result, the card concerned shows the **Partial data** badge
with its message and **Narrow the time range**: the lines (warnings from every page loaded are
merged), the volume and a metric chart each have their own. Warnings on a complete result show
under **Warnings**; other notes under **Notes**.

## Refresh, time changes and the address

- **Refresh now** and the auto-refresh interval run the stream and the volume again. Under a fixed
  time range (two dates, not "Last 1 hour") the list goes back to its first page each time.
- Changing the time range (the picker, a brush on the volume, or the `[` `]` `-` `=` keys outside
  the editor) runs both again; the requests for the old range are cancelled.
- The address keeps the query (`q`), `dir=forward` for **Oldest first** and `wrap=on` for **Wrap
  lines**, with the time range. Reloading or sharing it shows the same view. The scroll position is
  not kept.

## Limits

| Limit | What happens |
|---|---|
| 128 KB of query text (UTF-8) | Completion pauses and a note says so; Run sends nothing and shows the message |
| 1 000 lines per page | The next page loads as you scroll |
| 10⁶ lines held | Lines far from the view are let go and loaded again when you scroll back |

Not built yet: live tail, patterns, detected fields, expanding a line into its fields, links from
a line to its trace, and the minimap of the stream.

Requirements: [SRF-033](../../designs/product/04-surfaces.md#srf-033--log-volume-histogram),
[SRF-036](../../designs/product/04-surfaces.md#srf-036--log-stream) (the stream, without the
minimap), [VIZ-034](../../designs/product/05-visualisation-catalogue.md#viz-034--log-stream),
[VIZ-067](../../designs/product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel),
[PRF-020](../../designs/product/09-performance-contract.md#prf-020--10-log-lines-scrollable),
[PRF-030](../../designs/product/09-performance-contract.md#prf-030--cancel-superseded-requests),
[PRF-031](../../designs/product/09-performance-contract.md#prf-031--truncation-honesty),
[IA-022](../../designs/product/02-information-architecture.md#ia-022--deep-links-reproduce-the-view);
design rules [T09](../../designs/technical/T09-query-editors.md) (query editors) and
[ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md) (the server plans the query).
