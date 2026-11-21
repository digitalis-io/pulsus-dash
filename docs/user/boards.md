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
| **Open in Explore: `<panel>`** | Opens Metrics (PromQL) or Logs (LogQL) with the same time range and the panel's query |
| **Full screen: `<panel>`** | Shows the panel over most of the window; **Close** or Escape returns to the board |
| **Panel menu: `<panel>`** | **Edit panel** (opens Edit mode with the panel editor) and **Copy query** (copies the query to the clipboard) |

Charts have a keyboard crosshair: focus the chart (**Crosshair: `<panel>`**) and use the arrow keys
to read values ([Charts](../client/charts.md#accessibility-t01-007)).

### What panels show today

Panel queries run when PromQL and LogQL support reaches the server (#64, #67). Until then:

- against the server, a PromQL panel shows "Runs when PromQL support lands" and a LogQL panel "Runs
  when LogQL support lands";
- panels with the **Logs** visualisation show "The log stream arrives with LogQL panels";
- in the development build (`npm run dev`), panels show seeded synthetic data, the same on every
  load.

### Saved time range

A board can save a time range (for example the last 6 hours). It applies when you open the board
**from a link in the app**: the board list, the sidebar's Starred and Recent links, or New board.
It does not apply to a shared link, a bookmark or a reload: those keep the time in the address, so a
link always shows what its sender saw.

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
carries them. Changing them never asks about unsaved changes. They do not change what the panels
query yet: that comes with PromQL panels (#64).

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
  them. Across browsers, the order follows each browser's clock.

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

**Edit panel** in a panel's menu, or **Add panel**, opens the **Panel editor** at the right of the
grid. It is not a dialog: Tab moves freely between it and the board. Every change shows on the
board at once.

| Field | Values |
|---|---|
| **Title** | at most 200 characters; empty shows "Untitled panel" |
| **Query language** | PromQL or LogQL |
| **Query** | the query text, at most 16 384 bytes |
| **Visualisation** | Auto (a line chart for PromQL, bars for LogQL), Line, Bars, Heatmap, Stat or Logs |

**Remove panel** removes the panel from the board; **Close editor** closes the editor.

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

## Limits

- At most 200 panels per board (sections included) and 50 sections; a full board says "Board is
  full: at most 200 panels", and a board with no free 6 × 8 place says "Board is full: no space for
  a 6 × 8 panel".
- 12 columns; rows up to 10 000 (a panel's top row), panels up to 100 rows high.
- At most 20 filters; values up to 200 characters; the board's address up to 4 096 bytes.
- Recent shows five boards.
- Not yet: undo and history, moving panels between sections, reordering sections, variables and
  filters changing the queries (#64), the anomaly strip of a collapsed section, folders and tags,
  viewing or restoring old versions, and permissions (everyone can edit every board).

## Design references

[02 Information architecture](../../designs/product/02-information-architecture.md) (IA-002, IA-003,
IA-006, IA-021, IA-022, IA-023), [04 Surfaces](../../designs/product/04-surfaces.md) §4.3 (SRF-014,
SRF-016, SRF-017, SRF-020, SRF-026),
[08 Visual language](../../designs/product/08-visual-language.md) (VL-017),
[T08 DOM component kit](../../designs/technical/T08-dom-component-kit.md) (T08-008, T08-015, T08-017,
T08-021, T08-024).
