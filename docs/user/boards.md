# Boards

A board is a page of panels laid out on a grid. Boards belong to the **organisation**: everyone
sees the same boards, whichever tenant they are in. The tenant in the address only chooses the data
source the panels query. This page is for people who use and edit boards; the API behind them is
in [Boards API](../server/boards-api.md).

## The board list

**Boards** in the sidebar opens the list of all boards, most recently updated first. The table has
the board's name (a link), when it was last updated (date and time in your time zone), who updated
it, and an **Actions for `<name>`** menu with:

- **Rename**: change the name and **Save**. The rename is saved against the latest version of the
  board, so it never undoes someone else's change. If the board changed while the dialog was open,
  the dialog says so; **Save** again renames the latest version.
- **Delete**: **Delete** removes the board and its versions from the list. If the board changed
  since you opened the dialog, the dialog asks you to confirm; **Delete** again removes it.

**New board** (above the table) asks for a **Name** and **Create**s an empty board, which opens in
Edit mode. A name is required and can be at most 200 characters.

The list shows at most the 1 000 most recently updated boards; when there are more, a note under the
table says so. With no boards, the list shows "No boards yet".

Any dialog keeps what you typed when something fails ("The change could not be saved. Try again."),
and its main button is disabled while the request runs.

## Viewing a board

A board opens in **View** mode. Under the page header:

- on the left, the time window the panels show ("Showing …"), the same as the time range picker,
  then the [filter bar](#the-filter-bar);
- on the right, **Updated `n` s ago** (since the panels were last refreshed; after an hour, "Updated
  at `HH:mm`"), **Share** and **Edit board**.

Panels sit on a grid of **12 columns** with rows of 40 px and gaps of 16 px.
[Sections](#sections) group panels under a heading, each with its own grid. Each panel has a header with its title and, when the data
has a unit, a subtitle such as "in rps". The panel tools appear when you point at the panel or move
the keyboard focus into it (they are always reachable with Tab):

| Tool | What it does |
|---|---|
| **Open in Explore: `<panel>`** | Opens Metrics (PromQL) or Logs (LogQL) with the same time range and the panel's query (see [Open in Explore](#open-in-explore)) |
| **Full screen: `<panel>`** | Shows the panel over most of the window; **Close** or Escape returns to the board |
| **Panel menu: `<panel>`** | **Edit panel** (opens Edit mode with the panel editor), **Duplicate**, **Remove**, **Open in Explore** and **Copy query** (copies the query to the clipboard) |

**Duplicate** adds a copy of the panel ("`<title>` (copy)") in the first free place of the same
grid, and **Remove** removes it. Both switch the board to Edit mode, because the change needs a
save; focus moves to **Add panel** after a removal. While a save is in flight both are unavailable.

Charts have a keyboard crosshair: focus the chart (**Crosshair: `<panel>`**) and use the arrow keys
to read values ([Charts](../client/charts.md#accessibility-t01-007)).

### Zoom and pan a chart

Point at a chart's plot (the area with the lines or bars) and:

| Do this | What happens |
|---|---|
| Scroll the wheel, or pinch on a trackpad | Zoom the time range in or out around the pointer |
| **Shift** + wheel | Zoom the value (Y) axis around the pointer |
| **Ctrl** + wheel, or **⌘** + wheel | Zoom both axes around the pointer |
| Swipe sideways with two fingers | Move the time range earlier or later |
| Drag (left or middle button) | Move the time range; the chart follows the pointer |
| Right drag, or **Alt** + drag | Zoom into the time span you dragged across |
| Drag on the time axis (below the plot) | Move the time range |
| Drag on the value axis (left of the plot) | Move the value range |
| Double-click the plot | Zoom out: twice the time range, around its centre |
| Double-click the value axis | Return the value axis to automatic |
| **Reset Y axis** (top left of the plot) | Return the value axis to automatic |

- **Time changes apply to the whole board.** When you stop scrolling (after about a third of a
  second) or let go of the mouse, the new time range is set for every panel and the time range
  picker, and it goes into the browser history: **Back** returns to the previous range.
- **The value axis is per chart.** A zoomed or moved value axis stays on that chart until you reset
  it. It is not in the address, so a reload, a shared link, or changing the panel's visualisation
  or unit starts it automatic again (and it stays automatic if you change back). While it is fixed,
  the chart's description ends "Y axis fixed at … to …".
- **The page still scrolls.** The wheel zooms a chart only over its plot. Over the axes, titles, gaps
  between panels and the rest of the page it scrolls the page, and a scroll that is already going
  keeps scrolling when it passes over a chart.
- **No browser menu on a plot.** Right-clicking or right-dragging on a plot opens no browser menu;
  elsewhere right-click works as usual.
- **Short labels while you zoom.** While you work a chart, a value label that would not fit is shown
  in short form (`15µ`, `-1.23k`), and a very long one inside the chart on a small background. On a
  chart too narrow for either form, that label is left out (its gridline stays). The full labels
  return when the pointer leaves the chart.
- A trackpad pinch zooms time only, and **Ctrl** or **⌘** + wheel zooms both axes. A mouse whose
  wheel moves in fractional steps acts like a pinch.

### PromQL panels

A PromQL panel runs its query against the board's time range and draws the result. What it sends,
and what the server makes of it:

- **The query as you wrote it**, with the values of the board variables it uses (see
  [the filter bar](#the-filter-bar)). The server puts the values in, expands the macros and sends
  the result to the data source: `$__interval` is the panel's step (one point per pixel or two of
  its width) and `$__rate_interval` the rate window for that step.
- **A counter is drawn as a rate.** A bare counter such as `http_requests_total` is sent as
  `rate(http_requests_total[<window>])` with the window for the panel's step, and the header reads
  "in /s".
- **Auto-vis.** With the visualisation **Auto**, histogram buckets (`sum by (le) (rate(…_bucket…))`)
  draw as a heatmap, a scalar (for example `scalar(vector(1)) / 0`) as a stat, and everything else
  as a line. A visualisation you choose in the panel editor is saved with the panel and always
  wins; changing it redraws the result without asking the server again.

What a panel shows:

| State | What you see |
|---|---|
| no query | "Add a query" |
| a variable it uses has no value | "Set a value for `$name` to run this panel" (no request is made) |
| waiting for its first result | "Loading" |
| fetching again (new time range, refresh, a resize) | the previous chart stays, and a thin bar moves along the top of the panel after 300 ms |
| an error | "Something went wrong" and the error; a query error adds where it is, "(line 1, column 7)"; when the time range is too wide, **Narrow the time range** halves it around its centre |
| partial data | a **Partial data** badge in the header (or **Warnings** when the result is complete but the data source warned); pressing it lists the notices and, for partial data, offers **Narrow the time range** |
| visualisation **Logs** | "A metric query has no log lines. Choose Auto or a chart." (Logs draws [LogQL panels](#logql-panels)) |
| PromQL support failed to load | "PromQL support could not be loaded. Reload the page." |

**Only panels on screen query.** A panel queries when it scrolls into view, and panels in a
collapsed section do not query at all. A panel that has shown a result for the current time range
shows it again at once when you scroll back to it. When the time range changes, the panels on
screen query again (even for a range they showed before), and the others when they scroll in.

**Refresh.** **Refresh now**, and each auto-refresh tick, reruns every panel on screen: under a
relative range ("Last 1 hour") with the range moved to now, under an absolute range with the same
range. A query still running is cancelled first, so each panel makes one request. Panels off
screen refresh when they scroll in.

In the development build (`npm run dev`) the panels run against the in-app stub, which plans the
query as the server does and answers with seeded synthetic series.

### LogQL panels

A LogQL panel runs its query against the board's time range, as a PromQL panel does: the query as
you wrote it, with the values of the board variables it uses, which the server puts in. What it
draws depends on its **visualisation** and on the answer, a log query (such as
`{app="checkout"} |= "error"`) or a metric query (such as `rate({app="checkout"}[1m])`):

| Visualisation | A log query | A metric query |
|---|---|---|
| **Auto** | the log lines | a line chart, one line per series |
| **Logs** | the log lines | "A metric query has no log lines. Choose Auto or a chart." |
| **Bars** | the log volume: lines per time step, stacked by level | a bar chart of the series |
| **Line**, **Heatmap**, **Stat** | "Line, Heatmap and Stat draw metric queries. Choose Auto, Logs or Bars for log lines." | that chart of the series |

**The log lines** are the list of Explore › Logs ([Explore: logs](explore-logs.md#the-log-lines)),
named "Log lines: `<panel>`", **newest first**:

- **Newest first** and **Oldest first** set the order. A new order loads the lines again.
- **Wrap lines** wraps long lines onto several rows; nothing is loaded again.
- **Paging.** The lines arrive in pages of 1 000. The next page loads when you scroll within 50
  lines of the end, so a board of log panels loads one page each until you read on. **End of
  results** marks the last line. When lines loaded again differ from the first time, the list says
  "These lines changed since they were loaded." with **Run again**.
- The order and wrap belong to the panel on this page: they are not saved with the board and not
  in its address, and the panel starts newest first, unwrapped, each time the board opens.
- **Full screen** shows the same list, larger; the panel says "Shown at full screen" until you
  close it. Nothing is loaded again.

**The log volume** (Bars on a log query) is the bar chart of Explore › Logs' Volume card: critical,
error, warning, info, debug, trace and lines without a level, from the bottom up, in "lines". Its
legend isolates a level as other legends do (see [Legends](#legends)), and its thresholds are drawn
on the stacked value axis. A **brush** across it (drag with the right mouse button, or **Alt** and
drag) sets the board's time range to that span, and every panel runs again for it.

**When it runs.** A log-lines panel loads its first page when it scrolls into view. Scrolled out,
it keeps its lines; when you scroll back with nothing changed, they show at once without a request.
A new time range (the picker, the window keys, a brush, **Narrow the time range**), **Refresh
now** and a change to a variable it uses load the first page again: at once on screen, and when it
scrolls in off screen. A panel with another visualisation asks the server what the query returns
(one line at most) and, for **Bars**, the volume at the same time, so it shows one chart; a new
time range cancels both. A variable the panel does not use changes nothing. While a log-lines
panel's editor is open, the preview loads the lines and the panel behind waits; **Done** loads them
again for the panel. A panel with another visualisation shares the preview's request instead, as a
PromQL panel does: the panel behind shows the same answer, and **Done** asks for nothing new.

The panel's states are those of [PromQL panels](#promql-panels): "Add a query", "Set a value for
`$name` to run this panel", "Loading", the error with "(line 1, column 7)" and **Narrow the time
range**, and the **Partial data** badge (the notices of every page loaded so far). **Open in
Explore** opens Explore › Logs once the panel has its answer (see [Open in Explore](#open-in-explore)).

### Legends

A line or bars panel shows a **legend** under its chart: one row per series, at most 50, in the
order the data source returned them (the footer says "Showing the first 50 of N series" when there
are more).

- **Columns:** a colour swatch and the series name, then **Mean**, **Max** and **Last**, in tabular
  numbers in the panel's unit. Choose a column header to sort by it (descending first; choose it
  again to flip).
- **Click to isolate.** Choose a series name to draw that series alone; choose it again to show all
  of them. The legend is local to the panel: isolating or sorting never makes a new request, and is
  never saved. When a refresh no longer returns the isolated series, all series show again.
- **Threshold highlights.** With [thresholds](#thresholds), a mean, max or last value beyond a
  threshold shows in the threshold's state: its colour, its glyph (◐ Watch, ◉ Degraded, ■ Failing)
  and, for screen readers, its name.
- **Short panels.** Below 240 px of panel body (a panel 5 rows high or less), the legend is
  **compact**: the swatch, name and last value of each series, which isolate as the table rows do,
  and **Legend table**, which opens the full table (sort, isolation and highlights) in a popover.
  Escape closes it.
- **Hidden.** Set **Legend** to **Hidden** in the panel editor to show the chart alone.

### Thresholds

A panel can have up to 8 **thresholds**: absolute values that mark a state, set in the panel editor.

- **Direction.** **Worse when: Above the value** means a value at or above a threshold is in its
  state; **Below the value**, at or below it.
- **Steps.** Each threshold has a value, a state (**Watch**, **Degraded** or **Failing**) and an
  optional label. A value is 0, or a number between 1e-9 and 1e15 in size (for example `1.5e9` or
  `-0.25`); two thresholds cannot have the same value. A value beyond several thresholds takes the
  most severe state it crosses.
- **On line and bars charts**, each threshold is a dashed line in its state's colour across the
  plot, with its label (or `≥ value` / `≤ value` when it has none) after the state glyph. Labels
  that would overlap are stacked, a long label is cut with "…", and labels that do not fit are
  gathered in a "+N" chip; Tab reaches a cut label or the chip, and its tooltip shows the full text.
  The value axis stretches to show every threshold; when you have fixed the axis (zoom), a threshold
  outside it shows only its label, at the edge of the plot. The chart's description lists every
  threshold for screen readers.
- **On stat panels** (see [Stat tiles](#stat-tiles)).
- Thresholds on a heatmap or logs panel are kept but not shown.

### Stat tiles

A stat panel shows one number: the scalar, or the last value of the first series. With a range
query, a **sparkline** of that series runs under the number when the panel is tall enough (104 px
of chart). The sparkline shows the trend: it joins the points across gaps in the data, and a
single point shows as a dot. With thresholds, the tile also shows:

- a **state chip** above the number: the state of the value (OK when it crosses no threshold,
  Unknown when there is no value);
- the **threshold text** under it: the threshold the value crossed, in its state's colour, or else
  the next threshold it would reach, muted.

### Event markers

Deploys, configuration changes, feature flag changes and notes show on a board's time charts as
**event markers**: a thin vertical line at the event's time across the plot, with a label above it
(INT-031). They are the organisation's annotations: a CI pipeline or a script posts them through
the [Annotations API](../server/annotations-api.md), and every board of every tenant shows the ones
in its time range. There is no way to add or edit a note on the board yet.

- **Where.** On line, stacked bars and heatmap panels, in the full screen view and in the panel
  editor's preview. Stat and logs panels show none. A chart reserves the label strip above its plot
  as soon as the board has any marker, in view or not, so zooming and panning never move the plot.
- **Labels.** A label is the kind's glyph and the text: ◆ for a deploy, ⚙ for a config change, ⚑ for
  a feature flag; a note has no glyph. A label that does not fit before the next one is cut with
  "…" or shortened to its glyph; near the right edge it sits to the left of its line. Markers less
  than 24 px apart share one **+N** chip. A marker is never dropped: on a very narrow chart all the
  markers share one target with no text.
- **Reading them.** Tab reaches each label or chip after the chart's crosshair; hover or focus
  shows a tooltip with each event's kind, text and time, and its end time for an event with one,
  for example `Deploy · v2.31 · 00:15:00`. The chart's description ends "Events in view: N." for
  screen readers. Clicking a marker does nothing yet.
- **Time range and refresh.** The markers follow the board's time range, including a zoom or pan
  while you drag; a new range keeps the old markers until the new ones arrive. **Refresh now**
  reads them again.
- **Notices.** Above the panels, "Showing the newest 500 events in this time range." means the range
  holds more than 500 (zoom in to see the rest), and "Events could not be loaded." means the
  server did not answer; the panels still load.

### Open in Explore

**Open in Explore** (the header tool or the panel menu) opens Explore › Metrics with the board's
time range and the panel's query **as the server ran it**: the variables filled in and the
`$__interval` / `$__rate_interval` macros replaced by the panel's values, before the counter rate
is added (Explore adds its own). It is available once the panel has its answer for the current
time range: while the panel is loading, before its first result, or after an error that the server
gave no query for, the tool and the menu item are unavailable. A LogQL panel opens Explore › Logs
the same way: with its query as the server ran it (the variables filled in), once it has an answer.
A PromQL panel's visualisation other than Auto is carried over.

### Saved time range

A board can save a time range (for example the last 6 hours). It applies when you open the board
**from a link in the app** (the board list, the sidebar's Starred and Recent links, or New board),
and when a link has no time range in it (`/t/<tenant>/board/<uid>` alone); a board without a saved
range then opens on the last hour. It does not apply to a shared link, a bookmark or a reload that
carries a time range: those keep the time in the address, so a link always shows what its sender
saw. Panels wait until the board's time is set, so they never query the default range first.

### Sections

A section groups panels under a heading. The heading is a button that collapses or expands the
section (screen readers hear it as expanded or collapsed), and next to it is the number of panels
("No panels", "1 panel", "`n` panels").

- A **collapsed section loads nothing**: its panels are not drawn and their queries do not run
  until you expand it.
- In **View** mode, collapsing or expanding is **not saved** with the board. It is kept in the
  address instead (`collapse=<section>` or `expand=<section>`, only where it differs from the saved
  state), so a reload, Back and a copied link show the same sections. It does not add a step to
  the browser history. Entering Edit mode drops it: Edit always starts from the saved state.
- In **Edit** mode, collapsing or expanding changes the board and is saved with it.

### The filter bar

The filter bar (**Board filters**) sits left of the toolbar, in both modes:

- **One chip per variable.** Each `$name` or `${name}` in the board's queries is a variable (the
  `$__…` macros, such as `$__rate_interval`, are not). Its chip reads "Variable `name`: `value`", or
  "not set". Pressing it opens **Variable `name`** with a **Value** field: **Apply** sets the value
  (an empty value clears it), **Clear** removes it. The value is kept in the address as
  `var-<name>=<value>`. A chip follows the queries as you edit them; a value stays in the address
  when its last reference goes, and returns with the chip.
- **`+ Filter`** opens **Add filter** with a **Label** and a **Value**: **Add** adds the filter
  `label=value` (adding a label that is already there replaces its value), **Cancel** closes. Each
  filter is a chip "Filter `label`: `value`"; pressing it lets you change the value (**Apply**) or
  **Remove filter**. Filters are kept in the address as `f=<label>=<value>`, one per filter.

Labels start with a letter or `_` and contain letters, digits, `_` and `.` ("Use a label name:
letters, digits, _ and ., not starting with a digit"). A value is required ("Enter a value") and
can be at most 200 characters ("Use at most 200 characters"). A board can have at most 20 filters
("A board can have at most 20 filters"). A message shows under its field and the dialog stays open;
closing a dialog changes nothing.

Neither variables nor filters are saved with the board. They are part of the address, so each
change is a step in the browser history (Back undoes it), a reload keeps them, and **Copy link**
carries them. Changing them never asks about unsaved changes. A variable's value goes into the
PromQL panels that use it: changing it reruns only those panels. Filters do not change the queries
yet.

The board's address (path and parameters) is limited to **4 096 bytes**. A value that would make it
longer is refused: "This would make the board link too long. Remove a filter or use a shorter
value." Removing a value is always accepted. Characters outside ASCII take more room in the
address than they look (up to 12 bytes each).

### Share

**Share** opens **Share board** with **Copy link**. The copied link opens this board with the
current time window, its variables and filters, and the sections you collapsed or expanded. By
default relative times are pinned to absolute times (the link shows the same window later); check
**Keep relative** to share "last hour" as it is. If the browser refuses the clipboard, the link
appears in a field to copy by hand. A hand-made link longer than 4 096 bytes is not copied: "This
link is too long to share. Remove filters or shorten values."

## Starred and Recent

The sidebar's **Starred** and **Recent** groups list boards for you:

- **Star board** (☆ next to the board's title) adds the board to Starred; press it again to remove
  it. Starred lists boards by name. If the change fails, "Could not update Starred. Try again."
  shows next to the star, and the star goes back to what it was.
- **Recent** lists the last five boards you opened, the most recent first, in the order you opened
  them in one browser tab's app. Across browsers or tabs, the order follows each one's clock, so it
  is approximate when the clocks differ. If a computer's clock is more than five minutes fast or a
  day slow, its views are ordered by when the server started handling them, which is also
  approximate.

Both are stored for you on the server, so they are the same after a reload, in every browser and
under every tenant. Another tab of the same browser updates at once; another browser updates when
you return to its tab. A list that cannot be loaded says "Could not load starred boards" or "Could
not load recent boards". A deleted board drops out of both lists.

## Editing a board

**Edit board** or **Shift+E** switches to **Edit** mode. The page title shows "(editing)" and the
toolbar becomes:

| Control | What it does |
|---|---|
| **Add panel** | Adds an empty 6 × 8 panel in the first free place (top to bottom, left to right) and opens it in the panel editor |
| **Add section** | Adds an empty, expanded section at the end, named "Untitled section" until you give it a title |
| **Save current time range** | Checked when the board has a saved time range. Checking saves the current one with the board; unchecking removes it |
| **Discard** | Throws away the unsaved changes: reloads the board and returns to View mode. While it reloads, the board cannot be edited or saved |
| **Save** (**⌘S** on macOS, **Ctrl+S** elsewhere) | Saves the changes as a new version. Disabled when there is nothing to save |
| **Done** (or **Shift+E**) | Returns to View mode; with unsaved changes it asks first |

A line under the toolbar says how the save went: "Saving", "Saved", "Could not save. Your changes
are kept." (try **Save** again), "This board was deleted elsewhere. Your changes are not saved.",
"Could not discard: the saved version did not load. Your changes are kept." (**Discard** could not
reload the board; you can keep editing, save, or try again), or "Problems to fix before saving:
`n`" with the problem shown under its field.

### Sections in Edit mode

Each section's heading row adds:

| Control | What it does |
|---|---|
| **Section `n` title** | The section's title, at most 200 characters |
| **Add panel** (**Add panel to `<section>`**) | Adds a 6 × 8 panel in the section's first free place, opens it in the panel editor, and expands the section if it was collapsed |
| **Remove section** (**Remove section `<section>`**) | Removes the section and its panels |

The heading button collapses or expands the section; this is saved with the board. A board can have
at most 50 sections ("A board can have at most 50 sections").

### Moving and resizing panels

- **With a pointer:** drag a panel by its header; resize it with the handle at its bottom-right
  corner.
- **With the keyboard:** each panel has a **Move or resize: `<panel>`** button. With it focused, the
  arrow keys move the panel one cell, and **Shift** with the arrow keys makes it narrower (←),
  wider (→), shorter (↑) or taller (↓). The new position is announced ("Pods: column 7, row 9,
  6 × 10").

Panels never push each other and gaps are kept: a move onto another panel, or off the grid, is
refused and announced ("… blocked at column …"), and the panel stays where it was. A panel is 1 to
12 columns wide and 1 to 100 rows high; its top row is at most 10 000.

### The panel editor

**Edit panel** in a panel's menu, or **Add panel**, opens the **Edit panel** window: a centred
window of fixed size (800 × 720 px, smaller on a smaller screen) over the dimmed board. It cannot
be moved or resized, and Tab stays inside it while it is open.

At the top, a live **Preview** draws the panel as the board will: the same chart, from the same
query and the current time range. Under it are the fields:

| Field | Values |
|---|---|
| **Title** | at most 200 characters; empty shows "Untitled panel" |
| **Query language** | PromQL or LogQL |
| **Query** | the query text, at most 16 384 bytes; the PromQL editor of Explore › Metrics, or the LogQL editor of Explore › Logs (below) |
| **Visualisation** | **Auto (`<vis>`)**, naming what auto-vis picked for the current result (see [PromQL panels](#promql-panels); a LogQL panel's reads **Auto (Logs)** for log lines and **Auto (Line)** for a metric query), Line, Bars, Heatmap, Stat or Logs |
| **Thresholds** | **Add threshold** (up to 8; "Up to 8 thresholds" when full), then per threshold **Value**, **State** and **Label**, and **Remove threshold n**; **Worse when** sets the direction (see [Thresholds](#thresholds)) |
| **Legend** | **Table** (the default) or **Hidden** (see [Legends](#legends)) |

For PromQL the **Query** field is the editor of Explore › Metrics, with highlighting, completion
and the **Metric** picker above it ([Explore: metrics](explore-metrics.md)). What you type goes into
the board draft at once, but the query **runs** only when you ask:

- **Shift+Enter** or **⌘/Ctrl+Enter** in the editor, or **Run query**;
- or when you leave the field (Tab, or a click elsewhere in the window) with a query that has not
  run.

Until then the field says "Press Shift+Enter or Run query to update the preview." A run shows
**Loading** in the preview and on the panel behind until the result arrives (a query you ran
before for the same time range shows at once); running the same query again reruns it, and a newer
run cancels an older one. A query error underlines its place in the editor. **Escape** in the editor
moves to **Run query** (closing the completion list first, if it is open); a second **Escape**
closes the window. If the editor cannot load, the field is a plain text box and says so.

For LogQL the **Query** field is the editor of Explore › Logs, with highlighting and completion of
label names and values, and no Metric picker; it runs the same way. Changing **Query language**
keeps the text and runs it in the new language. Running the same query again on a log-lines panel
loads its first page again.

Every other change applies to the draft at once, and the preview follows it: a title shows at
once, and a visualisation, threshold or legend change redraws the result without a new request.
Changing the visualisation keeps the thresholds and the legend setting. A threshold **Value** that
is not a number shows "Enter a number", and one outside the range shows "Use 0 or a value between
1e-9 and 1e15 in size."; either stops the save until it is fixed. The panel on the board
behind shows the same chart or message.

**Remove panel** removes the panel from the board. **Done**, Escape or a click outside the window
closes it; focus returns to the panel's menu button (to **Add panel** if the panel was removed).
Closing never undoes anything: your changes stay in the board draft until you save or discard.
**⌘S** / **Ctrl+S** saves from inside the editor, and the save status shows at its foot. After a
save with problems, the editor opens on the first panel with one, and each error shows under its
field.

### Unsaved changes

With unsaved changes, leaving the board for another page (a sidebar link, the breadcrumb, Explore)
asks **Discard unsaved changes?**: **Keep editing** stays, **Discard changes** leaves. Changing the
time range or refreshing never asks. Closing or reloading the tab asks through the browser.

### When someone else saved first

Saves are checked against the version you opened. If someone saved the board after you opened it:

- while you are editing, a note says "This board was saved elsewhere (version `n`)". Your changes
  are kept;
- when you save, **This board was changed** asks what to keep: **Save mine as a new version**
  saves your board over theirs (as a newer version; theirs stays in the history), **Discard mine
  and load theirs** loads their version.

A save is never silently lost or overwritten.

If the board cannot be read again while it is open (the connection dropped, or it was deleted
elsewhere), the board and your unsaved changes stay on screen with a note: "Could not reload this
board. Your changes are kept." or "This board was deleted elsewhere. Your changes are kept here
but cannot be saved." Leaving the page still asks first.

## Keys

| Key | Where | What it does |
|---|---|---|
| **Shift+E** | a board, not while typing | Edit mode on; in Edit mode, Done |
| **⌘S** / **Ctrl+S** | a board in Edit mode, anywhere | Save |
| Arrows, **Shift**+arrows | **Move or resize** button | Move, resize |
| **[**, **]**, **-**, **=** | anywhere but text fields and menus | Step the time window back and forward, zoom out and in |
| **Escape** | a chart's crosshair, while dragging on the chart | Cancel the drag: the chart returns to where it was |
| **Shift+Enter**, **⌘/Ctrl+Enter** | the panel editor's PromQL or LogQL query | Run the query |
| **Escape** | the panel editor's PromQL or LogQL query | Move to **Run query**; again: close the panel editor |
| Arrows, then **Space** | a log panel's order options | Move between **Newest first** and **Oldest first**, then choose |

## Limits

- At most 200 panels per board (sections included) and 50 sections; a full board says "Board is
  full: at most 200 panels", and a board with no free 6 × 8 place says "Board is full: no space for
  a 6 × 8 panel".
- 12 columns; rows up to 10 000 (a panel's top row), panels up to 100 rows high.
- At most 20 filters; values up to 200 characters; the board's address up to 4 096 bytes.
- A panel's query text is at most 16 384 bytes when saved, and at most 200 panels have one. A
  query over 128 KB is not sent ("This query is over 128 KB…"); the query the server would send,
  with the variables and macros filled in and any rate applied, is at most 64 KiB, and the server
  refuses a longer one ("The query to send … is over 64 KiB…"), with no request to the data source.
- Recent shows five boards.
- At most 8 thresholds per panel, labels up to 200 characters; a legend shows at most 50 series.
- Log panels: pages of 1 000 lines and 10⁶ lines held per panel (lines far from the view are let go
  and loaded again when you scroll back), as Explore › Logs; the order and wrap are not saved.
- At most the newest 500 event markers in a time range; marker text up to 500 characters.
- Charts: no glide after a flick, no zoom by scrolling over an axis, no value zoom on heatmaps, no
  touch gestures, and other panels follow a zoom only when it ends.
- Not yet: undo and history, moving panels between sections, reordering sections, filters changing
  the queries, variable definitions and value lists, several queries in one panel, log patterns,
  saving a log panel's order and wrap, repeated panels, percentage thresholds, threshold areas,
  list legends and legend placement, adding or editing notes on the board, clicking a marker to
  compare before and after (INT-030), event markers in Explore, the anomaly strip of a
  collapsed section, folders and tags, viewing or restoring old versions, and permissions (everyone
  can edit every board).

## Design references

[02 Information architecture](../../designs/product/02-information-architecture.md) (IA-002, IA-003,
IA-006, IA-020, IA-021, IA-022, IA-023), [04 Surfaces](../../designs/product/04-surfaces.md) §4.3 (SRF-014,
SRF-016, SRF-017, SRF-020, SRF-026; SRF-033 and SRF-036 for LogQL panels),
[08 Visual language](../../designs/product/08-visual-language.md) (VL-003, VL-007, VL-017),
[03 Interaction model](../../designs/product/03-interaction-model.md) §4.1 (INT-001, INT-002,
INT-007, INT-008, INT-025 for 2D charts; INT-031, event markers on board panels,
[ADR-0023](../../designs/adr/0023-chart-event-markers.md)),
[T08 DOM component kit](../../designs/technical/T08-dom-component-kit.md) (T08-008, T08-015, T08-017,
T08-021, T08-024), [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md) (VIZ-011, VIZ-057,
VIZ-034, VIZ-065, VIZ-067, Table 5-13), [T07 Scene and query planner](../../designs/technical/T07-scene-query-planner.md) (T07-012,
T07-013), [T09 Query editors](../../designs/technical/T09-query-editors.md) (T09-001, T09-004,
T09-009, T09-010, T09-014, T09-015), [09 Performance contract](../../designs/product/09-performance-contract.md)
(PRF-030, PRF-031), [ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md) (query planning on the
server), [ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md) (threshold lines
and the stat sparkline).
