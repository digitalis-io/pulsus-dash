# Explore: metrics

**Explore › Metrics** runs one PromQL query against the tenant's data source and shows the result
as a chart and a series table. The tenant in the address chooses the data source. The time range,
the auto-refresh interval and **Refresh now** in the header apply here as on boards. This page is
for people who explore metrics; how the page is built is in
[Explore: metrics](../client/explore.md).

The page has two cards: **Query**, where you write and run the query, and **Result**, where you
read it.

## Writing a query

The **Query** card has the `PromQL` tag, the **Metric** picker, the Run hint (`Shift+Enter`) and
the **Run** button, then the query editor and a status line.

- **Completion.** Typing in the editor offers metric names (with their type, such as `counter`),
  label names inside `{…}` and label values after `=`. The suggestions come from the data source,
  over the time range shown. Completion pauses while you compose text with an input method, and
  comes back when the composition is committed.
- **Metric picker.** Focus **Metric** (or click it) to open a list of metric names, each with its
  type and help text. Type to filter: names that start with what you typed come first. Choose a
  name with the arrow keys and Enter (Enter alone takes the first match) or a click: it is inserted
  into the query at the caret, and the editor gets the focus back. The list shows at most 100
  names; "keep typing to narrow" says when there are more. While the list is open, the rest of the
  page cannot be used: a click outside only closes the list, and Tab or Shift+Tab closes it and moves
  on.
- **Run keys.** **Shift+Enter**, **Ctrl+Enter** (**⌘+Enter** on macOS) or **Run** run the query.
  Enter alone starts a new line. **Esc** leaves the editor and moves the focus to **Run** (when a
  completion list is open, Esc closes it first). Tab is not taken by the editor.
- **If the editor cannot load**, the query box is plain text with a message to reload. Run and
  Shift+Enter (or Ctrl/⌘+Enter) still run the query. Without query support, queries are drawn over
  time: a single value shows as a flat line, and a text value (a string) cannot be shown and reports
  the server's error.
- **Running the same query again** (Run with the text unchanged) cancels a request still in
  flight and starts it again.
- **Running an empty query** clears the result and shows "Run a query to see a chart".

Run is disabled, with the note "Run is available once the chart has a size.", until the editor and
the chart's width are known. This takes a moment after the page opens.

The server builds the query it sends: it applies the rate, fills in `$__interval`,
`$__rate_interval` and `$__range` (with `$__range_s` and `$__range_ms`, from the time range), and
checks the size.

## Errors

A failed query shows its message in the status line, and the previous result stays drawn under it.

- A **syntax error** from PulsusDB underlines the place it reports in the editor. When PulsusDB
  gives no position, the whole query is underlined and the message ends "(position unknown)".
  Editing the query removes the underline.
- **Too broad** (too many series) and **timed out** errors offer **Narrow the time range**, which
  halves the time range around its centre.
- **Busy** ("Too many queries are running for this tenant"), **unavailable** ("PulsusDB is
  unavailable: …"), a network error ("The server could not be reached.") and an unknown tenant are
  shown as such. Try again later, or check the data source.
- A query with a variable (`$name` or `${name}`), such as a board panel's query opened in
  Explore, fails with "The query failed: no value for variable $name": Explore has no variables.
  Replace the variable with a value and run it again.

## How the result is drawn

With **Auto** selected, the page picks the chart from the query and its result:

| Query or result | Chart |
|---|---|
| Histogram buckets (series with an `le` label of a histogram metric) | Heatmap |
| A bare counter (`http_requests_total`), with the rate applied | Line of its per-second rate |
| A scalar, or an instant query with one series and one value | Stat |
| Anything else | Line |

The first option of **Visualisation** reads `Auto (Line)`, `Auto (Heatmap)` and so on, to say what
Auto chose. **Line**, **Bars**, **Heatmap** and **Stat** override it; the choice is kept in the
address. A heatmap needs histogram buckets; bars need few enough distinct timestamps; when they
cannot be drawn the chart area says why. A string result (for example `"hello"`) is shown as text
under every option.

### The rate chip

A bare counter or histogram bucket selector is sent with a rate applied:
`http_requests_total` is sent as `rate(http_requests_total[1m])`, and
`http_request_duration_seconds_bucket` as `sum by (le) (rate(…[1m]))`. The **Rate applied** chip
shows when this applies; press it to send the query as typed (and again to apply the rate). When
the query sent differs from the one typed, **Sent query: …** shows it in the result toolbar.

The rate window holds at least four 15 s scrapes: it is `1m` up to a 15 s step and `4 × step`
above (the step depends on the time range and the chart's width). Targets scraped less often than
every 15 s may show gaps. Whether a name is a counter or a histogram comes from the data source's
metric types; when they cannot be read, only names ending in `_total` are rated and a warning says
so under **Warnings**.

## The series table

Under the chart, one row per series shows its name, its last value and its largest value.

- **Series**, **Last** and **Max** sort the table; the same header again reverses the order.
- Choosing a series shows it alone in the chart; the others are dimmed in the table. Choosing it
  again shows all. The choice stays across time changes and refreshes while the result still has
  that series.
- At most 500 rows are listed ("Showing the first 500 of … series").

## Inspect and select

Click a point, a bar segment or a heatmap cell in the chart (or, on a stat, **Inspect Query
result**) to open the **Inspector** over the right of the page: the value, its raw details and
labels, pivots and the query, as on [boards](boards.md#inspect-and-select). By keyboard: focus the
chart's crosshair, move with the arrow keys and press **Enter**. In the series table, the round
**Select `<series>`** toggle before each name selects that series without opening the Inspector.
**Edit query** (✎) moves the focus to the query editor. Explore has no **Explore** chip; the
**Logs ±1 min** chip opens Explore › Logs around the point for the series' service. **Escape**
clears the selection, then closes the Inspector. The Inspector closes when you run another query.

## Partial data and notes

When PulsusDB returns only part of the result, the **Partial data** badge shows with its message
and **Narrow the time range**. Warnings on a complete result show under a **Warnings** badge; other
notes show under **Notes**. At most five of each are listed.

## Waiting, refresh and the address

- A thin bar moving along the top of the chart shows when a request has been running for more than
  300 ms. The previous chart stays meanwhile.
- **Refresh now** and the auto-refresh interval rerun the query, cancelling one still in flight.
- Changing the time range (the picker, a brush on the chart, or the `[` `]` `-` `=` keys outside the
  editor) reruns the query; a request for the old range still running is cancelled.
- The address keeps the query (`q`), the visualisation (`vis`, when not Auto) and `rate=off` when
  the chip is off, with the time range. Reloading or sharing it shows the same view. The sorted
  column and the isolated series are not kept.

## Limits

| Limit | What happens |
|---|---|
| 128 KB of query text (UTF-8) | Completion pauses and a note says so; Run sends nothing and shows the message |
| 64 KiB of query **sent** (with any rate applied) | The server refuses it with the same message: "The query to send, with any rate applied, is over 64 KiB, the most the server accepts. Shorten it." |
| 500 series | The chart and the table show the first 500 |
| 10 000 metric names | Completion and the picker use the first 10 000 names the data source returns |
| 100 picker options | Keep typing to narrow the list |

Requirements: [SRF-027](../../designs/product/04-surfaces.md#srf-027--promql-editor),
[SRF-030](../../designs/product/04-surfaces.md#srf-030--metrics-auto-vis-and-multiple-queries),
[SRF-031](../../designs/product/04-surfaces.md#srf-031--metric-browser-and-series-table),
[VIZ-065](../../designs/product/05-visualisation-catalogue.md#viz-065--auto-vis-rules),
[IA-020](../../designs/product/02-information-architecture.md#ia-020--time-range-in-the-page-header),
[IA-022](../../designs/product/02-information-architecture.md#ia-022--deep-links-reproduce-the-view);
design rules [T09](../../designs/technical/T09-query-editors.md) (query editors) and
[ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md) (the server plans the query).
