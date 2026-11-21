# 04 — Surfaces

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.6-rc · 2026-11-21 |
| **Requirement area** | `SRF` |
| **Source draft** | plans/04-surfaces.md (not tracked) |
| **Depends on** | [01 Vision & principles](01-vision-and-principles.md) · [01a Audiences & perspectives](01a-audiences-and-perspectives.md) · [02 Information architecture](02-information-architecture.md) · [03 Interaction model](03-interaction-model.md) · [05 Visualisation catalogue](05-visualisation-catalogue.md) · [07 Alerting](07-alerting.md) · [08 Visual language](08-visual-language.md) · [09 Performance contract](09-performance-contract.md) · [15 Estate navigation](15-estate-navigation.md) |
| **Technical designs** | [T01 Frontend architecture](../technical/T01-frontend-architecture.md) · [T08 DOM rooms & component kit](../technical/T08-dom-component-kit.md) · [T09 Query editors](../technical/T09-query-editors.md) · [T11 Postgres schema](../technical/T11-postgres-schema.md) |
| **Mockups** | [34-application-layout](../mockups/34-application-layout.svg) · [01-landscape-map](../mockups/01-landscape-map.svg) · [22-topology-3d](../mockups/22-topology-3d.svg) · [05-service-lens](../mockups/05-service-lens.svg) · [06-metrics-workbench](../mockups/06-metrics-workbench.svg) · [07-logs-workbench](../mockups/07-logs-workbench.svg) · [08-traces-workbench](../mockups/08-traces-workbench.svg) · [09-alert-lens](../mockups/09-alert-lens.svg) · [10-alerts-list-timeline](../mockups/10-alerts-list-timeline.svg) · [11-rule-editor-backtest](../mockups/11-rule-editor-backtest.svg) · [12-routing-simulator](../mockups/12-routing-simulator.svg) · [13-investigation](../mockups/13-investigation.svg) · [14-board](../mockups/14-board.svg) · [15-command-palette](../mockups/15-command-palette.svg) · [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg) |

## 1. Purpose & scope

This document specifies every screen ("surface") in the product: the job it serves, its layout
regions, and its key interactions. Section numbers 4.1–4.15 match the source draft because other
documents cite them (e.g. "04 §4.14").

Layouts are given as region tables, so each requirement is unambiguous without a picture. The SVG
mockups illustrate them; where a mockup and a requirement disagree, the requirement wins.
Visual treatment is in [08](08-visual-language.md). The estate experience (Atlas views, zoom ladders,
floors, layers) is specified in [15](15-estate-navigation.md); §4.1 here covers only Atlas encodings
and interactions that are not in 15. Alerting surfaces are specified in [07](07-alerting.md).

Which surface a user lands on, and how each is encoded, depends on their **Perspective**
([01a](01a-audiences-and-perspectives.md)). The role-specific homes (NOC queue, Alert Lens, Platform
Atlas, Release Compare, Journeys) are in 01a; this document describes the shared surfaces.

## 2. Definitions

| Term | Meaning |
|---|---|
| **Surface** | A top-level screen. It is a **space** (content drawn by the chart engine: one GPU scene for the Atlas and a Lens, one canvas per viewport on Boards and workbenches), a **room** (React DOM UI, [ADR-0014](../adr/0014-typescript-react-web-client.md)) or both |
| **Viewport** | One vis instance in a scene ([05](05-visualisation-catalogue.md)) |
| **Context** | Shared filters, time window, comparison and focus ([02](02-information-architecture.md)) |
| **Inspector** | The side panel that shows details and pivots for the current selection ([03](03-interaction-model.md)) |
| **Time range picker** | The Context time window in the page header of every page ([02](02-information-architecture.md) IA-020) |
| **Time Ribbon** | The time overview strip at the bottom of the Atlas and Lens scenes ([02](02-information-architecture.md) IA-028, [03](03-interaction-model.md) §6) |
| **Lens** | An auto-built scene for one entity or a small set (§4.2) |
| **Board** | A curated, saved scene (§4.3) |

## 3. Surface inventory

**Table 4-1 — Surfaces**

| § | Surface | Kind | JTBD ([01](01-vision-and-principles.md) §5) | Milestone | Mockup |
|---|---|---|---|---|---|
| 4.1 | Atlas | Space (3D/2.5D) | Triage, ambient awareness | M-UI3 | [22-topology-3d](../mockups/22-topology-3d.svg) |
| 4.2 | Lens | Space (auto scene) | Triage, root cause, validate change | M-UI2 | [05-service-lens](../mockups/05-service-lens.svg) |
| 4.3 | Boards | Space (curated scene) + room (library/editor) | Build & share, ambient | M-UI5 | [14-board](../mockups/14-board.svg) |
| 4.4 | Metrics workbench | Space | Root cause, build | M-UI1 | [06-metrics-workbench](../mockups/06-metrics-workbench.svg) |
| 4.5 | Logs workbench | Space | Root cause | M-UI2 | [07-logs-workbench](../mockups/07-logs-workbench.svg) |
| 4.6 | Traces workbench | Space | Root cause | M-UI2 | [08-traces-workbench](../mockups/08-traces-workbench.svg) |
| 4.7 | Profiles workbench | Space | Root cause, validate change | M-UI2 | — |
| 4.8 | Correlate (split / stack) | Space | Root cause | M-UI2 (First Light M-UI3) | — |
| 4.9 | Investigation | Room + space | Root cause, collaborate, post-mortem | M-UI4 | [13-investigation](../mockups/13-investigation.svg) |
| 4.10 | Alerts | Room + space | Define alerting, triage | M-UI4 | [09-alert-lens](../mockups/09-alert-lens.svg) · [10-alerts-list-timeline](../mockups/10-alerts-list-timeline.svg) |
| 4.11 | Home | Room | Orientation | M-UI4 | [15-command-palette](../mockups/15-command-palette.svg) |
| 4.12 | Admin & settings | Room | Govern | M-UI1 (enterprise items M-UI6) | — |
| 4.13 | NOC / Wall mode | Space | Ambient | M-UI5 (attention management M-UI6) | [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg) |
| 4.14 | Journeys & customer lookup | Space + room | Business impact, support | M-UI5 | — |
| 4.15 | Release & rollout compare | Space | Validate change | M-UI5 | — |

Every surface is a page of one web application with the layout of
[02](02-information-architecture.md) §3.1 ([mockup](../mockups/34-application-layout.svg)). Boards and the
workbenches are reached from the left navigation sidebar (Boards, Explore); their viewports are chart
frames drawn by the chart engine, and by the interim Canvas 2D renderer until the engine lands
([ADR-0014](../adr/0014-typescript-react-web-client.md) §3–§4).

#### SRF-001 — Every surface uses the application layout
**MUST** · M-UI1 · SRE, Engineer, Platform, NOC, Business, Support

Every surface MUST show the application layout of [02](02-information-architecture.md) IA-016: the
left navigation sidebar and the page header with the surface title (or breadcrumb) on the left and
the ⌘K entry, alert count and AI entry (once they exist), the time range picker, the refresh control
and the user menu on the right. A room whose content does not depend on time (for example Admin) MAY
omit the time range picker and refresh control. The Atlas and Lens also show the Time Ribbon
(IA-028). Wall mode (§4.13) is the only exception.

*Acceptance:* Given each surface of Table 4-1 available at the milestone, when it is opened, then the
sidebar and the page header are present, with the time range picker and refresh control on every
time-dependent surface, and for the Atlas and Lens the Time Ribbon; and in Wall mode none of them is
shown.

---

## 4. Surfaces

### 4.1 Atlas — the estate as a living map

**Purpose:** see the entire estate, where it hurts, and how the hurt propagates. Mockups:
[01-landscape-map](../mockups/01-landscape-map.svg), [22-topology-3d](../mockups/22-topology-3d.svg).

> **Note:** The full landscape → infrastructure → container design (two zoom ladders, the app/infra
> floors, the six synced views including Explorer, layers for capacity/cost/coverage, the fetch plan)
> is normative in [15](15-estate-navigation.md). The draft's three Atlas layouts map onto 15's views:
> Topology → Topology, Hierarchy ("city") → City, Geography → Map.

**Atlas regions**

| Region | Contents |
|---|---|
| Page header | Breadcrumb, scope (e.g. `prod ▾`), view switcher (Map · Topology · City · Infra · Segments · Explorer, [15](15-estate-navigation.md) §5), ⌘K, alert count ⚠, AI ✦ |
| Layer bar | Active layer ([15](15-estate-navigation.md) §7) and the active find/hide filter (e.g. `team=payments`) |
| Scene | The active view; territories (region / cluster / namespace) drawn as translucent groups |
| Legend | State glyphs and edge encodings for the active layer |
| Minimap | Bottom-right; whole Landscape with a viewport rectangle |
| Time Ribbon | Bottom; scrub replays health and traffic |

**Table 4-2 — Atlas default encodings (Health layer, Topology view)**

| Channel | Default meaning |
|---|---|
| Node colour | Five-state health ([08](08-visual-language.md)) from SLO burn and anomaly vs baseline; unknown / no data is grey and hatched, never green |
| Node size | Throughput (rps) |
| Node ring | Mini RED donut: share of errors; pulsing ring = active alert |
| Edge particles | Request flow; speed/density ∝ calls/s; red particles ("red rain") = failed calls, drawn only on degraded edges |
| Edge thickness | p95 latency (thicker = slower), toggleable |
| Glow / halo | Deviation from baseline (anomaly score); the eye lands here first |
| Badge glyphs | Recent deploy (◆), config change (⚙), firing alert (⚠), open investigation (✚) |

**Data:** PulsusDB `service_graph` (edges with calls, failed, p50/p95/p99) plus per-entity RED/USE
rollups (recording rules or a dedicated entity-health endpoint;
[T01](../technical/T01-frontend-architecture.md) §5). Baselines and anomaly scores are Dash-derived
state in PostgreSQL ([ADR-0012](../adr/0012-derived-state-in-postgres.md)).

#### SRF-002 — Atlas default encodings
**MUST** · M-UI3 · SRE, NOC, Platform

The Atlas Topology view with the Health layer MUST encode entities and edges as in Table 4-2. State
MUST be encoded by colour and by a glyph or ring, never colour alone.

*Acceptance:* Given the storyboard incident ([13](13-core-flow-storyboard.md)), when the Atlas opens on
Topology/Health, then checkout is drawn degraded with a pulsing ring, the ⚙ badge sits on payments,
red particles flow only on degraded edges, and a node with no data is grey-hatched.

#### SRF-003 — Atlas hover, click and dive
**MUST** · M-UI3 · SRE, NOC, Platform, Engineer

Hovering a node MUST highlight its edges and dim non-neighbours, with a tooltip of its RED numbers.
Clicking MUST open the Inspector with RED sparklines and pivot chips. Double-clicking MUST fly the
camera into the entity's Lens.

*Acceptance:* Given the Topology view, when the user hovers checkout, then its edges highlight within
one frame and the tooltip shows rate, errors and duration; click opens the Inspector; double-click
flies into the checkout Lens within the camera-transition budget of [09](09-performance-contract.md)
(≤ 250 ms).

#### SRF-004 — Lasso to compare
**MUST** · M-UI3 · SRE, Platform

Lassoing a set of Atlas nodes MUST select them, and `B` on that selection MUST run Universal Compare
([05](05-visualisation-catalogue.md) §2). Selecting 2–8 nodes MUST also offer a multi-entity Lens
(§4.2).

*Acceptance:* Given five lassoed services, when the user presses `B`, then Compare opens over those
five; and "Open Lens" opens a multi-entity Lens of the five.

#### SRF-005 — Time scrub replays propagation
**MUST** · M-UI3 · SRE, IC, NOC

Scrubbing the Time Ribbon over the Atlas MUST replay node health and edge traffic across the window,
so that incident propagation is visible as colour spreading along edges. Replay MUST come from the
local summary pyramids without new queries ([15](15-estate-navigation.md) §8).

*Acceptance:* Given the storyboard window 12:15–12:30, when the user scrubs forward, then psp-api
changes state first, then payments, then checkout, at ≥ 60 fps and with no network request during
the scrub.

#### SRF-006 — Topology stays readable at scale
**MUST** · M-UI3 · SRE, NOC, Platform

The Topology view MUST provide:
- ownership/segment super-nodes with bundled edges between them;
- fisheye focus + context around the cursor or selection (hold `Alt` while hovering to magnify);
- `X` to show only the anomalous subgraph plus one hop of context, with an animated collapse;
- find/hide expressions in the filter bar (e.g. `p99 > 1s and team = payments`);
- a stable, org-pinned layout ([05](05-visualisation-catalogue.md) VIZ-029).

*Acceptance:* Given 10k services, when the user presses `X` during the storyboard incident, then only
the degraded path and one hop of neighbours remain; and given the expression `p99 > 1s and team =
payments`, then non-matching nodes are hidden.

#### SRF-007 — Atlas scale and truncation
**MUST** · M-UI3 · SRE, NOC, Platform

The Atlas MUST hold the frame targets of [09](09-performance-contract.md) with 10 000 entities and
50 000 edges, collapsing distant groups into aggregate nodes and expanding them as the camera
approaches. If the service graph is truncated, the coverage meter MUST show it.

*Acceptance:* Given a 10k / 50k fixture, when the user zooms from estate to one namespace, then p99
frame rate is ≥ 45 fps on reference hardware (b); and given a `service_graph` response truncated by
PulsusDB, the coverage meter reads "edges truncated" with the count.

> **Note:** Relies on assumption A1 (PulsusDB `service_graph` edge cap raised to ≥ 50 000).

---

### 4.2 Lens — the auto-built view of one entity

**Purpose:** everything about *one* entity (or a small set) on one screen, with zero configuration. A
Lens is what dashboard users spend days building as "the service dashboard", generated for every entity
type from a template. Mockup: [05-service-lens](../mockups/05-service-lens.svg).

**Lens regions (Service template)**

| Region | Contents |
|---|---|
| Header | Breadcrumb (`prod › eu-west-1 › core › checkout ▾`), current version with deploy age and ◆, owner team, firing-alert count |
| Golden-signals strip | Health (state, SLO attainment, burn rate), Rate (with −7d ghost), Errors (onset marker), Duration (p99 + heatmap, 3D toggle); stacked lanes per [05](05-visualisation-catalogue.md) VIZ-017 |
| Dependencies | Upstream / downstream mini-Atlas, degraded edges marked |
| Spans | Duration × time scatter of every span, outliers visible |
| Log patterns | Error + warn patterns with sparkline, count and NEW badge |
| Profile | Top CPU frames with share and change ▲ |
| Instances | Pods as small multiples, sorted by anomaly, "N more" |
| Time Ribbon | With deploy and change markers |

**Table 4-3 — Lens templates**

| Entity type | Template contents |
|---|---|
| Service | RED + dependencies + spans + log patterns + profile + instances |
| Host / Node | USE: CPU, memory, disk and network saturation; processes |
| Pod | USE, restarts, events, containers, logs |
| Database | Query latency, connections, slow queries |
| Queue | Lag, throughput |
| Endpoint | Per-route RED + exemplar traces |
| Cluster | Control-plane health, nodes, pending pods ([15](15-estate-navigation.md) §4.2) |

#### SRF-008 — Lens per entity type with zero configuration
**MUST** · M-UI2 · SRE, Engineer, Platform

Opening any entity of a type in Table 4-3 MUST show a Lens built from that type's template, with no
user configuration, laid out in the regions above.

*Acceptance:* Given a newly discovered service with metrics, logs and traces, when a user opens it
for the first time, then a Lens appears with every listed region populated, and no board or template
was authored for it.

#### SRF-009 — Lens first paint and refinement
**MUST** · M-UI2 · SRE, Engineer

Warm navigation to a Lens MUST show first coarse data in < 300 ms and be fully refined in < 1.5 s for
a typical service over 1 h ([09](09-performance-contract.md) §2).

*Acceptance:* Given the CI synthetic Lens load against a seeded PulsusDB, when the Lens is opened
warm, then p75 first coarse paint < 300 ms and p75 full refinement < 1.5 s (same percentiles as PRF-010/PRF-011).

#### SRF-010 — Tiles adapt to signal availability
**MUST** · M-UI2 · Engineer, SRE

When a template tile's signal is not ingested for the entity (e.g. no profiles), the tile MUST be
replaced by the next most useful tile. A Lens MUST NOT show an empty tile for a missing signal type;
the coverage meter MUST list the missing signal.

*Acceptance:* Given a service with no profiles, when its Lens opens, then no profile tile appears,
another tile fills the slot, and the coverage meter reads "no profiles".

#### SRF-011 — Anomaly-first ordering
**MUST** · M-UI2 · SRE, IC

During an incident, Lens tiles MUST reorder with a subtle animation so that the most deviant signal is
top-left. The user MUST be able to lock the ordering.

*Acceptance:* Given checkout's errors deviating most, when the incident starts, then the Errors tile
moves to the top-left slot; and after the user locks ordering, a later change in deviation does not
reorder tiles.

#### SRF-012 — Customise Lens as a team override
**MUST** · M-UI5 · Engineer, Platform

"Edit Lens" MUST let a team add and remove tiles for their services, saved as a Lens template override
scoped to a team or tag. "Save as Board" MUST snapshot the Lens into a regular Board.

*Acceptance:* Given team payments adds a "PSP latency" tile, when another payments service's Lens
opens, then it includes the tile, and a search-team service's Lens does not; and "Save as Board"
creates a Board with the same viewports.

#### SRF-013 — Multi-entity Lens
**MUST** · M-UI3 · SRE, Platform

Selecting 2–8 entities (e.g. by lasso in the Atlas) MUST offer a compare Lens with their series
overlaid on shared axes. Selections of more than 8 MUST offer Universal Compare instead.

*Acceptance:* Given 4 selected services, when "Open Lens" is chosen, then one Lens shows their RED
series overlaid with a legend per entity; and with 12 selected, the action offers Compare.

---

### 4.3 Boards — curated scenes

Boards are the classic-dashboard equivalent: application pages whose viewports are chart frames,
each with its own canvas, all drawn by one shared chart engine with one GPU device per page
(SRF-014; the interim Canvas 2D renderer until the engine lands). Mockup:
[14-board](../mockups/14-board.svg).

**Board edit-mode regions**

| Region | Contents |
|---|---|
| Header | Board name with "(editing)", Undo, History, Discard, Save (`⌘S`) |
| Canvas | Viewports on the layout grid; the selected one shows drag and resize handles; a "+ add" slot |
| Viewport editor (modal window) | **Data:** entity binding (e.g. `{{service}}`), signal, query with language picker; **Vis:** auto or explicit vis ([05](05-visualisation-catalogue.md)); **Axes, thresholds, overlays**; **Links / pivots** |

*Note (M-UI1, #61 Part B):* the first edit mode has a toolbar under the page header with Add
panel, Save current time range, Discard, Save (`⌘S`/`Ctrl+S`) and Done; the board name shows
"(editing)"; the panel editor is a centred modal window with a live preview at the top and title,
query language, query and visualisation below (#90). Undo
and History stay M-UI5 with the rest of SRF-020.

*Note (M-UI1, #61 Part C):* the toolbar's left side has a chip per variable referenced in the
queries and `+ Filter` (`label=value`), values in the URL only and not applied to queries until #64;
sections are collapsible with a panel count, collapsed sections neither render nor query, the
Edit-mode collapsed state is saved with the board and View-mode toggles are URL overrides
(`collapse`/`expand`), not saved; the anomaly strip stays M-UI5.

#### SRF-014 — Board layout
**MUST** · M-UI5 · Engineer, SRE, NOC

A Board MUST lay out viewports on a responsive 12-column snapping grid by default, and MUST offer a
free-form canvas option (for NOC storytelling boards), which MAY include 3D viewports. Every
viewport MUST be a chart frame with its own canvas, and all of them MUST be drawn by the one shared
chart engine with one GPU device per page ([ADR-0014](../adr/0014-typescript-react-web-client.md) §3).

*Acceptance:* Given a new board, when viewports are dragged, then they snap to 12 columns; when the
board is switched to free-form, then viewports can be placed at any position, including a 3D Atlas
viewport.

#### SRF-015 — Shared cursor and crosshair
**MUST** · M-UI5 · SRE, Engineer

All viewports on a board MUST share the time cursor and crosshair: hovering any time-based viewport
MUST show the value at that instant in every other time-based viewport.

*Acceptance:* Given a board of 20 time-series viewports, when the user hovers one at 12:22, then all
20 show their crosshair at 12:22 in the same frame.

#### SRF-016 — Lazy collapsed sections
**MUST** · M-UI5 · Engineer, SRE

Board rows/sections MUST be collapsible. A collapsed section MUST NOT query; it MUST show a mini
anomaly strip summarising its viewports.

*Acceptance:* Given a board with a collapsed section of 10 viewports, when the board loads, then no
query is issued for them and the section header shows an anomaly strip.

#### SRF-017 — Variables
**MUST** · M-UI5 · Engineer, SRE

Board variables MUST render as a compact filter bar with values seeded from Context. Changing a
variable MUST re-query only the viewports that use it, crossfading old to new data.

*Acceptance:* Given a board of 30 viewports where 5 use `$region`, when `$region` changes, then
exactly 5 viewports re-query and each crossfades.

#### SRF-018 — Board overview zoom
**MUST** · M-UI5 · Engineer, SRE

`Ctrl/⌘+wheel` over the board background (not over a viewport) MUST zoom the board itself out to an
overview of every viewport's thumbnail and back. Over a viewport, `Ctrl/⌘+wheel` keeps its meaning
from [03](03-interaction-model.md) (zoom both axes).

*Acceptance:* Given an 80-viewport board, when the user `Ctrl+wheel`s over the gutter, then the board
zooms out to show all 80 thumbnails; clicking one zooms back framed on it.

#### SRF-019 — Board capacity
**MUST** · M-UI5 · Engineer, NOC

A board MUST support 200 viewports on one page. Off-screen viewports MUST neither render nor query
([09](09-performance-contract.md) §3).

*Acceptance:* Given a 200-viewport board, when only 12 are on screen, then only those 12 have issued
queries and are drawn, and scrolling holds the frame targets.

#### SRF-020 — Edit mode
**MUST** · M-UI5 · Engineer

`Shift+E` (or the Edit button) MUST enter edit mode with the regions above. Every edit MUST be
undoable, and the History control MUST list edits since the last save.

*Acceptance:* Given a board, when the user presses `Shift+E`, moves a viewport and changes its vis,
then `⌘Z` twice restores the original, and History lists both edits.

#### SRF-021 — Build boards by collecting
**MUST** · M-UI5 · Engineer, SRE

A viewport MUST be addable to a board from the command palette, from any Inspector ("Add to board…"),
and by dragging a viewport from a Lens or workbench onto a board tab.

*Acceptance:* Given a Lens viewport, when the user drags it onto a board tab, then the board gains an
identical viewport with its query and Context bindings.

#### SRF-022 — Entity-relative viewports
**MUST** · M-UI5 · Engineer, Platform

A viewport MUST be able to bind to `{{entity}}` (or another entity variable) instead of hard-coded
labels, so that one board works for every entity of a type.

*Acceptance:* Given a board bound to `{{service}}`, when the user switches the service from checkout
to search, then every bound viewport shows search.

#### SRF-023 — Board versions and diff
**MUST** · M-UI5 · Engineer, Admin

Every save MUST create a version. Two versions MUST be comparable as side-by-side scenes and as a JSON
diff, and any version MUST be restorable.

*Acceptance:* Given three saves, when the user diffs v1 and v3, then both scenes render side by side
and the JSON diff highlights the changes; restoring v1 creates v4 equal to v1.

#### SRF-024 — Board schema, Git sync and Terraform
**MUST** · M-UI6 · Engineer, Admin

The Board JSON/YAML MUST be a documented schema. Optional Git sync (board-as-code, YAML) and a
Terraform provider MUST be available ([11](11-enterprise.md)).

*Acceptance:* Given Git sync enabled, when a board is saved in the UI, then a YAML commit appears in
the repo; and a YAML change merged in the repo appears as a new board version.

#### SRF-025 — Legacy dashboard import
**MUST** · M-UI5 · Admin, Engineer

Uploading existing dashboard JSON (common open dashboard formats) MUST create a Board using the parity map of
[05](05-visualisation-catalogue.md) §11, and MUST produce an import report listing every panel that
could not be mapped 1:1.

*Acceptance:* Given an existing dashboard of 40 panels with one unknown plugin, when imported, then 39
panels map to equivalents, the unknown one becomes a Table, and the report lists it.

#### SRF-026 — Board library
**MUST** · M-UI5 · Engineer, SRE, NOC

The board library room MUST provide folders, tags, search, starred, recently viewed and owners, and
MUST rank boards opened in investigations higher ("used during incidents").

*Acceptance:* Given two boards matching a search, when one was opened in three investigations, then
it ranks first and shows the "used during incidents" signal.

---

### 4.4 Metrics workbench

For when you *do* want to write PromQL or browse metric names. Mockup:
[06-metrics-workbench](../mockups/06-metrics-workbench.svg).

**Regions**

| Region | Contents |
|---|---|
| Query editors | Query A, B, … each with language label, run (`⌘⏎`), status line (series count, duration, rollup used), and "⨁" to add a query |
| Metric browser (left) | Search; metric list with type and cardinality; labels for the selection with value counts |
| Result | Vis switcher (line · area · heat · 3D · table) over the result viewport |
| Legend / series table | Sortable by max, last and anomaly ratio |

#### SRF-027 — PromQL editor
**MUST** · M-UI1 · Engineer, SRE

The editor MUST provide syntax highlighting, autocomplete of metric names, labels and values from
PulsusDB metadata APIs, hover docs for functions, and inline errors from PulsusDB's parser when the
query is run, through the BFF ([ADR-0015](../adr/0015-go-bff.md), [T09](../technical/T09-query-editors.md)).
An error MUST be underlined at the position PulsusDB returns, and across the whole query when
PulsusDB returns no position. Positioned diagnostics before the query is run are SRF-078.

*Acceptance:* Given the query `rate(http_server_duration_bucket{service="checkout"[5m])`, when it is
run, then PulsusDB's parse error is shown inline: underlined at the position PulsusDB returns, or
across the whole query if it returns none, and the previous result is kept.

> **Note:** Revised 2026-11-19 (#56) through change control to match ADR-0014 and ADR-0015: the
> previous M-UI1 criterion (the missing `}` underlined at its byte offset *before* run) moved to
> SRF-078, which follows the browser parser. Accepted by the product owner on 2026-11-19
> ([12](12-roadmap.md) D11).

#### SRF-078 — Positioned query diagnostics before run
**MUST** · M-UI2 · Engineer, SRE

The PromQL editor MUST underline parse errors at their byte offset while the query is typed, before
it is run, using PulsusDB's parser crates compiled to WASM in the browser
([ADR-0014](../adr/0014-typescript-react-web-client.md) §2, [T09](../technical/T09-query-editors.md)).

*Acceptance:* Given the query `rate(http_server_duration_bucket{service="checkout"[5m])`, when it is
typed, then the missing `}` is underlined at its byte offset before the query is run.

> **Note:** Split from SRF-027 on 2026-11-19 (#56); M-UI2, the milestone that ships the browser
> parser, accepted by the product owner on 2026-11-19 ([12](12-roadmap.md) D11).

#### SRF-028 — Query explain
**MUST** · M-UI1 · Engineer, SRE

Each query MUST offer an explain view showing the rollup chosen, rows read and time taken, from
PulsusDB `X-Pulsus-Explain`.

*Acceptance:* Given a 7-day query, when the user opens explain, then the rollup resolution, rows read
and server time are shown and match the response headers.

#### SRF-029 — Visual query builder
**MUST** · M-UI1 · Engineer, Platform

A visual builder (metric → filters → operations) MUST be available as a toggle and MUST round-trip
with the text query without loss for any query it can represent.

*Acceptance:* Given a query built visually, when toggled to text and back, then the builder state is
identical; and given a text query the builder cannot represent, the toggle explains why.

#### SRF-030 — Metrics auto-vis and multiple queries
**MUST** · M-UI1 · Engineer, SRE

The result MUST use the auto-vis rules of [05](05-visualisation-catalogue.md) §12 (histograms →
heatmap, counters → rate line, gauges → line, single value → stat). Multiple queries (A, B, …) and
expressions over them MUST be supported, shown overlaid or as small multiples.

*Acceptance:* Given a histogram metric, when run, then a heatmap is shown; and given queries A and B
and expression `A / B`, the three can be shown overlaid or as small multiples.

#### SRF-031 — Metric browser and series table
**MUST** · M-UI1 · Engineer, SRE

The metric browser MUST show each metric's type and series cardinality and the labels for the current
selection with value counts. The legend MUST be a series table sortable by max, last and anomaly
ratio.

*Acceptance:* Given `http_` typed in the browser, then matching metrics list with type and
cardinality; and sorting the series table by anomaly puts the most deviant series first.

#### SRF-032 — Cardinality explorer
**MUST** · M-UI1 · Platform, Engineer

The workbench MUST offer a cardinality explorer: a treemap of series count by label, to find what is
exploding.

*Acceptance:* Given a metric with 3.2k series of which 2.9k come from label `pod`, when the explorer
opens, then `pod` is the largest tile with its count.

### 4.5 Logs workbench

Mockup: [07-logs-workbench](../mockups/07-logs-workbench.svg).

**Regions**

| Region | Contents |
|---|---|
| Query bar | LogQL query, field pickers, run, pause/tail control |
| Volume | Histogram stacked by level, brushable |
| Patterns (left) | Auto patterns with sparkline and count |
| Detected fields (left, below patterns) | Facets with value counts |
| Stream (right) | GPU-rendered virtualised lines; expanded lines show parsed fields and trace links |

#### SRF-033 — Log volume histogram
**MUST** · M-UI1 · SRE, Engineer, Support

The workbench MUST show a volume histogram stacked by level (PulsusDB `/volume` and
`count_over_time`) above the stream; brushing it MUST narrow the time window.

*Acceptance:* Given a 1 h query, when the user brushes 12:20–12:25 on the volume, then Context time
becomes that window and the stream and patterns update.

#### SRF-034 — Patterns as the default for large results
**MUST** · M-UI2 · SRE, Engineer

The patterns panel (PulsusDB `/patterns`) MUST collapse logs into templates with sparklines and
counts; clicking a pattern MUST filter to it or exclude it; patterns absent from the baseline window
MUST carry a NEW badge. When a result exceeds 10 000 lines, patterns MUST be the default view.

*Acceptance:* Given a query returning 250k lines, when it runs, then patterns are shown first with the
stream on demand; and "exclude" on the top pattern removes it from the stream.

#### SRF-035 — Detected fields
**MUST** · M-UI2 · SRE, Engineer, Support

A facet sidebar (PulsusDB `/detected_fields`) MUST show detected fields with value distributions;
clicking a value MUST filter.

*Acceptance:* Given detected field `upstream` with 3 values, when the user clicks `payments`, then the
query gains that filter and the stream updates.

#### SRF-036 — Log stream
**MUST** · M-UI2 · SRE, Engineer, Support

The stream MUST be the Log stream vis of [05](05-visualisation-catalogue.md) §4, with a minimap
scrollbar showing error density.

*Acceptance:* Given 10⁶ loaded lines, when the user drags the minimap to its densest red band, then the
stream jumps to those lines and scrolling holds the frame targets.

#### SRF-037 — Line expand and links
**MUST** · M-UI2 · SRE, Engineer, Support

Expanding a line MUST show its parsed JSON/logfmt tree. `trace_id`/`span_id` values MUST link to the
trace; known entity labels MUST link to the entity's Lens.

*Acceptance:* Given a line with `trace_id=4bf9…`, when expanded, then "Open trace" opens that trace's
waterfall; and `pod=checkout-2xq` links to that pod's Lens.

#### SRF-038 — Live tail
**MUST** · M-UI2 · SRE, Engineer, Support

Live tail MUST stream over WebSocket with rate-limited smooth insertion, ingest-to-screen latency
< 2 s, and, when paused or scrolled away, a pill counting new lines (e.g. "paused, 3 214 new").

*Acceptance:* Given live tail at 5 000 lines/s, when a line is ingested, then it is on screen within
2 s; and when paused, the pill counts new lines and clicking it resumes at the newest.

#### SRF-039 — Log to metric
**MUST** · M-UI2 · Engineer, SRE

Selecting a pattern or filter and choosing "Chart this" MUST create a metric viewport with the query
`sum by (…) (count_over_time(…))`.

*Acceptance:* Given the pattern "timeout calling payments after <*>ms", when "Chart this" is chosen,
then a line of its count over time appears, grouped by the chosen label.

### 4.6 Traces workbench

Mockup: [08-traces-workbench](../mockups/08-traces-workbench.svg).

**Regions**

| Region | Contents |
|---|---|
| Query bar | TraceQL query and run |
| Span scatter (top) | Duration (log Y) × time, every span, coloured by status, brushable |
| Trace list (bottom left) | Traces from the brush, sorted by duration; below it, selection-vs-baseline compare |
| Waterfall (bottom right) | Selected trace with header (id, duration, span and service counts), critical path, span details |

#### SRF-040 — Span scatter is the hero
**MUST** · M-UI2 · SRE, Engineer

The workbench MUST open on a span scatter of every matching span (up to 10⁷), and brushing a region
MUST list the traces in it, sorted by duration.

*Acceptance:* Given 1.4M spans, when the user brushes the outliers above 1 s, then the trace list
shows exactly the traces with spans in the brushed region, slowest first.

#### SRF-041 — Selection vs baseline compare
**MUST** · M-UI2 · SRE, Engineer

The brushed set MUST be compared against the baseline (PulsusDB TraceQL `compare()`), showing which
attribute values are over-represented.

*Acceptance:* Given a brush of slow spans that are all `region=us-east-1, version=2.31`, when compare
runs, then those two values rank top with their over-representation percentages.

#### SRF-042 — Trace waterfall
**MUST** · M-UI2 · SRE, Engineer

The waterfall MUST be the Waterfall vis of [05](05-visualisation-catalogue.md) §4 and MUST show
span-linked logs inline and a `span → profile` pivot.

*Acceptance:* Given a span with 3 linked logs, when expanded, then the logs are listed inline and
"profile" opens the profile for that span's window and instance.

#### SRF-043 — 3D trace view
**SHOULD** · M-UI3 · Engineer

A toggle SHOULD show the waterfall extruded by service on Z (trace skyline), for wide fan-out traces
with thousands of spans. `T` MUST return to the 2D waterfall.

*Acceptance:* Given a 5 000-span trace, when toggled, then it renders as a skyline that can be
orbited, and `T` returns to the waterfall with the same selection.

#### SRF-044 — TraceQL metrics and service graph slice
**MUST** · M-UI2 · SRE, Engineer

TraceQL metrics (`rate()`, `quantile_over_time`, `histogram_over_time`) MUST be chartable directly,
and the workbench MUST show the service-graph slice for the current selection.

*Acceptance:* Given `{ resource.service.name = "checkout" } | quantile_over_time(duration, .99)`, when
run, then a p99 line is shown; and a mini graph of services in the selection is available.

> **Note:** The slice reads PulsusDB's native traces API: TraceQL metrics at
> `/api/traces/v1/metrics/query_range` and the service graph at
> `/api/traces/v1/service_graph?start=<t>&end=<t>` (confirmed 2026-11-19).

#### SRF-045 — Trace diff
**MUST** · M-UI2 · Engineer, SRE

Picking two traces MUST show aligned waterfalls with per-span deltas.

*Acceptance:* Given two traces of the same route, when "diff" is chosen, then matching spans align
and each shows its duration delta.

### 4.7 Profiles workbench

#### SRF-046 — Flame graph, diff and top table
**MUST** · M-UI2 · Engineer, SRE

The workbench MUST show the Flame graph / icicle of [05](05-visualisation-catalogue.md) §4 with a
synchronised top table (self/total, sortable, searchable), a profile-type switcher (cpu, alloc,
inuse, mutex, block…) populated from `/api/profiles/v1/types`, and a diff flame (PulsusDB
`render-diff`) of two windows or versions, red for grew and blue for shrank. Diff colours MUST also
be distinguishable without colour ([05](05-visualisation-catalogue.md) VIZ-067).

*Acceptance:* Given versions 2.30 and 2.31, when diff is chosen, then frames that grew are red and
labelled with "+", shrunk frames blue with "−"; and the type switcher lists the types PulsusDB
reports.

#### SRF-047 — Flame over time
**SHOULD** · M-UI3 · Engineer

The workbench SHOULD offer a flame landscape (x = time, y = stack depth, height = self-time) showing
when a function became hot, with per-function timeline strips as the 2D fallback.

*Acceptance:* Given a function whose self-time rose at 12:20, when the landscape is shown, then its
ridge rises at 12:20; and `T` shows the 2D strips with the same rise.

#### SRF-048 — Span to profile
**MUST** · M-UI2 · Engineer, SRE

From a slow span, the user MUST be able to open the profile samples for that span's window and
instance.

*Acceptance:* Given a 2.8 s span on pod checkout-2xq, when "profile" is chosen, then the flame graph
is restricted to that pod and window.

### 4.8 Correlate — split & stack

#### SRF-049 — Split
**MUST** · M-UI2 · SRE, Engineer

`\` MUST split any viewport into two side by side that share the time cursor and Context.

*Acceptance:* Given a metric viewport, when the user presses `\` and picks logs, then both panes show
the same window and hovering one shows the crosshair in the other.

#### SRF-050 — Stack mode: one column of truth
**MUST** · M-UI2 · SRE, IC, Engineer

Stack mode MUST align metrics, log volume, span scatter, profile timeline and change events vertically
on one shared time axis with a synced cursor. Brushing any lane MUST narrow all lanes.

*Acceptance:* Given the storyboard incident, when stack mode is opened, then five lanes share one X
axis and the deploy ◆ and alert ⚠ markers; brushing 12:20–12:25 on the span lane narrows all lanes.

#### SRF-051 — First Light onset swimlanes
**MUST** · M-UI3 · SRE, IC, Business

When the scene contains a causal path (incident, RCA result or lasso of entities), Correlate MUST offer
First Light: one lane per entity on the path showing its headline signal, sorted by detected onset
(change-point detection per lane), with the gap between onsets labelled (e.g. "+85 s") and change
events (⚙, ◆) marked. Lanes MUST be linked to the Atlas so that scrubbing lights nodes in onset order.

*Acceptance:* Given the storyboard, when First Light opens, then lanes are ordered psp-api, payments,
checkout, gateway, Journey Checkout, with gaps labelled and the ⚙ 12:19 config change marked; and
scrubbing lights those Atlas nodes in the same order.

---

### 4.9 Investigation — the incident workspace

**Purpose:** a shared, durable place where an incident is worked and later written up. Mockup:
[13-investigation](../mockups/13-investigation.svg).

**Regions**

| Region | Contents |
|---|---|
| Header | Investigation id and linked incident (e.g. INV-2041 / INC-2041), title, severity, state, IC, presence count, ● REC indicator |
| Timeline (left) | Time-ordered deploys ◆, alerts ⚠, AI findings ✦ with confidence, pins and notes by participant; "+ note" and "✦ ask AI" |
| Evidence canvas (right top) | Pinned live viewports with frozen Context |
| Hypotheses (right bottom) | Hypotheses with state (✔ supported, ✖ ruled out) and evidence count |
| Footer | Status, root cause, actions (Silence, runbook, Export) |

#### SRF-052 — Open from an alert in one click
**MUST** · M-UI4 · SRE, IC

An Investigation MUST be openable from an alert in one action, pre-populated with the alert's entity,
window and an AI first-pass ([06](06-ai-copilot.md)).

*Acceptance:* Given a firing alert in the Alert Lens, when the user chooses "Investigate", then an
Investigation opens with the entity in Context, the alert window as time, and an AI finding on the
timeline within the RCA Stage 1 budget of [09](09-performance-contract.md) (< 10 s).

#### SRF-053 — Live evidence
**MUST** · M-UI4 · SRE, IC, Engineer

Evidence MUST be pinned viewports (`P`) with frozen Context that remain live and interactive (zoom,
pivot). A pin MAY carry a frozen data snapshot so it outlives telemetry retention.

*Acceptance:* Given a pinned p99 viewport, when a participant zooms it, then it zooms with the frozen
Context intact; and given a snapshotted pin older than the telemetry TTL, it still renders.

#### SRF-054 — Presence and follow
**MUST** · M-UI4 · IC, SRE

An Investigation MUST show participant avatars and live cursors on the timeline, and MUST offer
"follow @user's camera".

*Acceptance:* Given two participants, when one follows the other, then the follower's camera tracks
the leader's within 1 s of each move.

#### SRF-055 — Hypotheses board
**MUST** · M-UI4 · IC, SRE, Engineer

AI and humans MUST be able to add hypotheses, each with supporting and refuting evidence links and a
state (open, supported, ruled out).

*Acceptance:* Given hypothesis "DB saturation", when a participant links the pg CPU 22 % viewport as
refuting and marks it ruled out, then it shows ✖ with that evidence.

#### SRF-056 — Flight recorder
**MUST** · M-UI4 · IC, SRE

Every participant's Context, camera, selections, live hypotheses, AI runs and notes MUST be recorded,
with a visible ● REC indicator. A reviewer MUST be able to scrub the investigation and see what each
responder was looking at, and the moment the eventual root cause first appeared on someone's screen
("time to first correct look"). Retention MUST follow org policy.

*Acceptance:* Given a closed investigation, when a reviewer scrubs to 12:35, then each participant's
view at 12:35 can be replayed, and the summary shows time to first correct look.

#### SRF-057 — Post-mortem export
**MUST** · M-UI4 · IC, SRE

Export MUST produce a post-mortem draft (Markdown or Docs) with the timeline, evidence images, root
cause and actions, linking to flight-recorder moments.

*Acceptance:* Given a resolved investigation, when exported to Markdown, then the file contains the
timeline, one image per evidence pin, the root cause field and the action list, with links that open
the recorder at those moments.

#### SRF-058 — Investigation integrations
**SHOULD** · M-UI4 · IC, SRE

Investigations SHOULD mirror to a Slack or Teams channel, link to a PagerDuty or Opsgenie incident,
and create Jira action items.

*Acceptance:* Given Slack configured, when a note is added, then it appears in the mirrored channel;
and an action item creates a Jira issue linked back.

### 4.10 Alerts

Alerting surfaces are normative in [07](07-alerting.md). Mockups:
[09-alert-lens](../mockups/09-alert-lens.svg),
[10-alerts-list-timeline](../mockups/10-alerts-list-timeline.svg),
[11-rule-editor-backtest](../mockups/11-rule-editor-backtest.svg),
[12-routing-simulator](../mockups/12-routing-simulator.svg).

#### SRF-059 — Alert surfaces exist
**MUST** · M-UI4 · SRE, NOC, Admin

The Alerts room MUST provide: active alerts projected onto the estate views of
[15](15-estate-navigation.md) (map, topology, infra/cluster, segments, list, timeline); the alert list
(firing, pending, silenced, grouped by entity); alert detail (state timeline plus the rule's query
rendered with its threshold); the rule editor (author on a chart with backtest); routing and contact
points; silences; maintenance windows; and history. Alert history is Dash-derived state stored in
PostgreSQL ([ADR-0012](../adr/0012-derived-state-in-postgres.md)).

*Acceptance:* Given M-UI4, when a user navigates the Alerts room, then each listed surface is
reachable, and `Alt+1`…`Alt+7` switch the estate projections as in [15](15-estate-navigation.md) §5.

### 4.11 Home

Not a dashboard of dashboards: a personal briefing.

#### SRF-060 — Home briefing
**MUST** · M-UI4 · SRE, Engineer, Platform

Home MUST show:
- "Your entities" (owned or starred) as a compact health strip; clicking one opens its Lens;
- firing alerts for the user's teams;
- open investigations the user is in;
- recently viewed boards, waypoints and investigations;
- a prominent ⌘K search box ([15-command-palette](../mockups/15-command-palette.svg)).

*Acceptance:* Given a user who owns checkout and is in INV-2041, when they open Home, then checkout is
in the health strip, INV-2041 is listed, and the ⌘K box has focus.

#### SRF-061 — AI daily brief
**SHOULD** · M-UI4 · SRE, Engineer, Platform

Home SHOULD offer an optional AI daily brief (e.g. "Overnight: 2 alerts on checkout auto-resolved;
error budget for payments at 61 %; new log pattern on search since 02:14"), with each claim linked to
its evidence.

*Acceptance:* Given the brief enabled, when Home opens in the morning, then the brief lists overnight
events and each claim opens its evidence.

#### SRF-062 — Choose your home
**MUST** · M-UI5 · SRE, NOC, Platform, Business

A user MUST be able to set a Board or the Atlas as their home instead of the briefing.

*Acceptance:* Given a user who sets the Atlas as home, when they next log in, then the Atlas opens.

### 4.12 Admin & settings (rooms)

#### SRF-063 — Admin rooms
**MUST** · M-UI6 · Admin

Admin MUST be conventional DOM rooms covering: users and teams; roles and permissions; SSO
(OIDC/SAML/SCIM); tenants and data-source bindings to PulsusDB instances; entity schema editor;
label ⇄ attribute mappings; Lens template management; AI settings (provider, data-sharing policy,
redaction rules); audit log viewer; quotas; API tokens and service accounts; licence. Each room lands
in the milestone of the feature it administers; OIDC login and PulsusDB data-source bindings MUST be
present when authentication lands (M-UI6, D12). Enterprise requirements are in [11](11-enterprise.md).

*Acceptance:* Given M-UI6, when an Admin signs in via OIDC, then they can bind a PulsusDB instance;
and at each later milestone, every listed room whose feature has shipped is reachable from Admin.

### 4.13 NOC / Wall mode

Mockup: [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg).

#### SRF-064 — Wall playlist
**MUST** · M-UI5 · NOC

Wall mode MUST be full-screen and chrome-less, auto-cycling a playlist of scenes (Atlas, Boards,
Lenses) with slow camera moves between waypoints. It MUST interrupt the playlist to focus on a new
anomaly ("attract mode").

*Acceptance:* Given a playlist of three scenes, when running, then scenes cycle with camera moves and
no chrome; and when a new anomaly is detected, the wall flies to it within 5 s.

#### SRF-065 — Kiosk tokens
**MUST** · M-UI6 · NOC, Admin

Unattended screens MUST authenticate with kiosk tokens scoped to read-only Wall mode.

*Acceptance:* Given a kiosk token, when used, then Wall mode opens and any attempt to edit, act or
leave Wall mode is refused.

#### SRF-066 — Wall readability
**MUST** · M-UI5 · NOC

Wall mode MUST be designed for 4K at viewing distance, using the Wall density of
[08](08-visual-language.md) (larger type scale, higher contrast).

*Acceptance:* Given the wall reference PC (c) at 3840 × 2160, when a scene renders, then text uses the
Wall type scale and contrast tokens of 08.

#### SRF-067 — Salience ladder
**MUST** · M-UI6 · NOC

New, un-owned problems MUST escalate visually over time: glow, then pulse, then camera auto-focus,
then a full-wall takeover banner with an optional audible cue. Acknowledgement MUST return salience to
calm.

*Acceptance:* Given an un-acknowledged new incident, when time passes, then it escalates through the
four steps at configured intervals; and after `Shift+A`, the wall returns to calm.

#### SRF-068 — Wall ↔ desk link
**MUST** · M-UI6 · NOC, SRE

The console operator's selection MUST appear on the wall (e.g. "NOC is looking at checkout"), and a
desk user MUST be able to throw a view onto the wall; both share one Context.

*Acceptance:* Given a desk user who throws the checkout Lens to the wall, then the wall shows it within
2 s with the desk's Context.

#### SRF-069 — Shift handover replay
**MUST** · M-UI6 · NOC

At shift handover the wall MUST be able to play a 60-second guided replay of the last 12 hours
(incidents, changes, recoveries) ("since you last looked").

*Acceptance:* Given 12 hours with two incidents, when replay is started, then it covers both incidents
and their recoveries in 60 s ± 5 s.

### 4.14 Journeys & customer lookup

The Business and Support entry point (see [01a](01a-audiences-and-perspectives.md) §3.5).

#### SRF-070 — Journey list
**MUST** · M-UI5 · Business, Support

The journey list MUST show for each journey: success %, volume vs baseline, impact (€ or users), SLA
attainment, and linked incident status.

*Acceptance:* Given the storyboard incident, when the list opens, then Checkout shows its reduced
success %, ~€38k/h impact, and a link to INC-2041.

#### SRF-071 — Journey map
**MUST** · M-UI5 · Business, Support, SRE

The journey map MUST be a GPU flow diagram (Sankey-like) of the journey's steps, each mapped to the
services that serve it, with drop-off between steps as edge width; a failing step MUST glow and carry
the ⊕ origin mark when RCA attributes the origin to it.

*Acceptance:* Given Checkout with a failing "pay" step, when the map opens, then the pay step glows,
the edge after it narrows by the drop-off, and ⊕ marks the origin service.

#### SRF-072 — Journey editor
**MUST** · M-UI5 · Engineer

The journey editor MUST let an engineer pick entry routes from a ranked list of top HTTP routes and
root spans, define steps and success criteria, attach a business metric, and preview against the last
7 days.

*Acceptance:* Given the editor, when an engineer defines three steps from ranked routes, then a
7-day preview shows volume and success per step before saving.

#### SRF-073 — Customer lookup
**MUST** · M-UI5 · Support, Business

Searching by customer or tenant id MUST show that customer's request volume, failures, affected
journeys and linked incidents in plain language. Lookup MUST only work on attributes an Admin has
marked as customer identifiers, and every lookup MUST be audited ([11](11-enterprise.md)).

*Acceptance:* Given `tenant.id` marked as a customer identifier, when Support searches a tenant, then
the plain-language summary appears and an audit entry records the lookup; and searching an unmarked
attribute is refused.

### 4.15 Release & rollout compare

The object is a **release** (version transition of an entity, detected from `service.version` or CI
events) or a **rollout in progress** (canary vs baseline by version label, running concurrently).

#### SRF-074 — Release detection
**MUST** · M-UI5 · Engineer, SRE

Dash MUST detect releases from `service.version` changes or CI events, and rollouts in progress from
concurrent version labels.

*Acceptance:* Given pods of checkout reporting 2.30 and 2.31 concurrently, then a rollout-in-progress
object appears; and when all report 2.31, a release object 2.30 → 2.31 exists.

#### SRF-075 — Release compare contents
**MUST** · M-UI5 · Engineer, SRE

Release compare MUST show a table of golden signals per version with deltas and significance
([01a](01a-audiences-and-perspectives.md) §3.4), a per-endpoint delta ranking, new exception types and
log patterns, a flame diff, and trace attribute compare restricted to `service.version`.

*Acceptance:* Given release 2.31, when compare opens, then each listed part is present and the
regressed endpoint ranks first.

#### SRF-076 — Release actions
**MUST** · M-UI5 · Engineer, SRE

Release compare MUST offer pause/rollback via a webhook to the CD system, with explicit confirmation,
plus annotate and open investigation. Pause/rollback MUST be audited.

*Acceptance:* Given a configured CD webhook, when the user chooses rollback, then a confirmation is
required, the webhook is called once, and an audit entry is written.

#### SRF-077 — Release verdict
**MUST** · M-UI5 · Engineer, SRE

Dash MUST post an automatic release verdict (✔ no regression / ⚠ regression in X) a configurable delay
after a deploy, defaulting to 15 minutes, and MUST post it to the team channel if one is configured.

*Acceptance:* Given a deploy at 12:00 and default settings, then at 12:15 the verdict appears on the
release and in the team channel.

## 5. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| SRF-001 | Every surface uses the application layout | MUST | M-UI1 |
| SRF-002 | Atlas default encodings | MUST | M-UI3 |
| SRF-003 | Atlas hover, click and dive | MUST | M-UI3 |
| SRF-004 | Lasso to compare | MUST | M-UI3 |
| SRF-005 | Time scrub replays propagation | MUST | M-UI3 |
| SRF-006 | Topology stays readable at scale | MUST | M-UI3 |
| SRF-007 | Atlas scale and truncation | MUST | M-UI3 |
| SRF-008 | Lens per entity type with zero configuration | MUST | M-UI2 |
| SRF-009 | Lens first paint and refinement | MUST | M-UI2 |
| SRF-010 | Tiles adapt to signal availability | MUST | M-UI2 |
| SRF-011 | Anomaly-first ordering | MUST | M-UI2 |
| SRF-012 | Customise Lens as a team override | MUST | M-UI5 |
| SRF-013 | Multi-entity Lens | MUST | M-UI3 |
| SRF-014 | Board layout | MUST | M-UI5 |
| SRF-015 | Shared cursor and crosshair | MUST | M-UI5 |
| SRF-016 | Lazy collapsed sections | MUST | M-UI5 |
| SRF-017 | Variables | MUST | M-UI5 |
| SRF-018 | Board overview zoom | MUST | M-UI5 |
| SRF-019 | Board capacity | MUST | M-UI5 |
| SRF-020 | Edit mode | MUST | M-UI5 |
| SRF-021 | Build boards by collecting | MUST | M-UI5 |
| SRF-022 | Entity-relative viewports | MUST | M-UI5 |
| SRF-023 | Board versions and diff | MUST | M-UI5 |
| SRF-024 | Board schema, Git sync and Terraform | MUST | M-UI6 |
| SRF-025 | Legacy dashboard import | MUST | M-UI5 |
| SRF-026 | Board library | MUST | M-UI5 |
| SRF-027 | PromQL editor | MUST | M-UI1 |
| SRF-028 | Query explain | MUST | M-UI1 |
| SRF-029 | Visual query builder | MUST | M-UI1 |
| SRF-030 | Metrics auto-vis and multiple queries | MUST | M-UI1 |
| SRF-031 | Metric browser and series table | MUST | M-UI1 |
| SRF-032 | Cardinality explorer | MUST | M-UI1 |
| SRF-033 | Log volume histogram | MUST | M-UI1 |
| SRF-034 | Patterns as the default for large results | MUST | M-UI2 |
| SRF-035 | Detected fields | MUST | M-UI2 |
| SRF-036 | Log stream | MUST | M-UI2 |
| SRF-037 | Line expand and links | MUST | M-UI2 |
| SRF-038 | Live tail | MUST | M-UI2 |
| SRF-039 | Log to metric | MUST | M-UI2 |
| SRF-040 | Span scatter is the hero | MUST | M-UI2 |
| SRF-041 | Selection vs baseline compare | MUST | M-UI2 |
| SRF-042 | Trace waterfall | MUST | M-UI2 |
| SRF-043 | 3D trace view | SHOULD | M-UI3 |
| SRF-044 | TraceQL metrics and service graph slice | MUST | M-UI2 |
| SRF-045 | Trace diff | MUST | M-UI2 |
| SRF-046 | Flame graph, diff and top table | MUST | M-UI2 |
| SRF-047 | Flame over time | SHOULD | M-UI3 |
| SRF-048 | Span to profile | MUST | M-UI2 |
| SRF-049 | Split | MUST | M-UI2 |
| SRF-050 | Stack mode: one column of truth | MUST | M-UI2 |
| SRF-051 | First Light onset swimlanes | MUST | M-UI3 |
| SRF-052 | Open from an alert in one click | MUST | M-UI4 |
| SRF-053 | Live evidence | MUST | M-UI4 |
| SRF-054 | Presence and follow | MUST | M-UI4 |
| SRF-055 | Hypotheses board | MUST | M-UI4 |
| SRF-056 | Flight recorder | MUST | M-UI4 |
| SRF-057 | Post-mortem export | MUST | M-UI4 |
| SRF-058 | Investigation integrations | SHOULD | M-UI4 |
| SRF-059 | Alert surfaces exist | MUST | M-UI4 |
| SRF-060 | Home briefing | MUST | M-UI4 |
| SRF-061 | AI daily brief | SHOULD | M-UI4 |
| SRF-062 | Choose your home | MUST | M-UI5 |
| SRF-063 | Admin rooms | MUST | M-UI6 |
| SRF-064 | Wall playlist | MUST | M-UI5 |
| SRF-065 | Kiosk tokens | MUST | M-UI6 |
| SRF-066 | Wall readability | MUST | M-UI5 |
| SRF-067 | Salience ladder | MUST | M-UI6 |
| SRF-068 | Wall ↔ desk link | MUST | M-UI6 |
| SRF-069 | Shift handover replay | MUST | M-UI6 |
| SRF-070 | Journey list | MUST | M-UI5 |
| SRF-071 | Journey map | MUST | M-UI5 |
| SRF-072 | Journey editor | MUST | M-UI5 |
| SRF-073 | Customer lookup | MUST | M-UI5 |
| SRF-074 | Release detection | MUST | M-UI5 |
| SRF-075 | Release compare contents | MUST | M-UI5 |
| SRF-076 | Release actions | MUST | M-UI5 |
| SRF-077 | Release verdict | MUST | M-UI5 |
| SRF-078 | Positioned query diagnostics before run | MUST | M-UI2 |

## 6. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. ASCII wireframes replaced by region tables and SVG mockups |
| 1.0-rc2 | 2026-11-19 | Roadmap D5 ([12](12-roadmap.md) §2.1): SRF-033 moves M-UI2 → M-UI1 (delivered by #49); SRF-044 note names the native service-graph route |
| 1.1-rc | 2026-11-19 | Decisions D7–D9 (roadmap Q13): definitions (Surface, Time range picker, Time Ribbon) and a layout paragraph under Table 4-1; SRF-001 (application layout), SRF-014 (one canvas per viewport, one shared engine) and SRF-019 (200 viewports on one page) revised in place; Atlas region "Top bar" becomes "Page header"; SRF-027 errors come from the PulsusDB parser through the BFF until the browser parser lands; R15 |
| 1.2-rc | 2026-11-19 | Code review of #56: §4.3 Boards introduction describes per-viewport canvases and one shared engine (was "a single GPU scene"); SRF-027 revised to errors from PulsusDB on run, positioned where PulsusDB returns a position; the pre-run byte-offset criterion split out as new SRF-078 (M-UI2), accepted by the owner (12 D11) |
| 1.3-rc | 2026-11-20 | Decision D12 (authentication deferred): SRF-063 Admin rooms moves M-UI1 → M-UI6 (its OIDC login and data-source binding clause and acceptance follow authentication); SRF-065 Kiosk tokens moves M-UI5 → M-UI6 with ENT-015 and ENT-016; R10 updated |
| 1.4-rc | 2026-11-20 | #61 Part B: §4.3 note on the M-UI1 edit-mode regions (toolbar with Add panel, Save current time range, Discard, Save and Done; panel editor at the right); Undo and History stay M-UI5 (SRF-020) |
| 1.5-rc | 2026-11-21 | #61 Part C: §4.3 note on the M-UI1 filter bar (variable chips and `+ Filter`, URL only) and collapsible sections (no render, no query; Edit state saved, View toggles as URL overrides); the anomaly strip stays M-UI5 (SRF-016) |
| 1.6-rc | 2026-11-21 | #90: §4.3 the M-UI1 panel editor is a centred modal window with a live preview (owner decision 2026-11-21); the region table's viewport editor is a modal window |

## Resolved during formalisation

| # | Issue in draft | Resolution |
|---|---|---|
| R1 | Atlas had three layouts (Topology, Hierarchy, Geography) here but six views in 15 | 15 is normative; mapped Topology → Topology, Hierarchy → City, Geography → Map |
| R2 | Atlas layer list here (Health, Traffic, Errors, Deploys, Saturation, Cost) differed from 15 §7 | 15 §7 is normative. Errors fold into Health, Deploys into Change, Saturation into Capacity |
| R3 | "Topology is the default layout" conflicted with 15 (Map for multi-region Landscape; per-Perspective defaults) and with roadmap Q4 | 15 §2 and §10 govern the default view |
| R4 | Node colour was a green → amber → red ramp; elsewhere health is the five-state scale and unknown is never green | Five-state scale from 08; no-data grey-hatched (Table 4-2) |
| R5 | Split was `⌘\` here but `\` in 03 and 15 | `\` |
| R6 | Board edit mode `E` collides with `Q`/`E` rotate in 03, and boards can hold 3D viewports | Edit mode is `Shift+E` (or the Edit button) |
| R7 | Board overview `Ctrl+wheel` collides with 03's `Ctrl/⌘+wheel` = zoom both axes | Board zoom applies only over the board background; over a viewport the 03 meaning stands |
| R8 | Log stream said "SDF glyph atlas"; 05 says MSDF | MSDF |
| R9 | Wall mode mixed a basic playlist with the attention-managed wall, but the roadmap only puts the latter in M-UI6 | Playlist, kiosk and readability at M-UI5 (with Boards); salience ladder, wall ↔ desk and handover replay at M-UI6 |
| R10 | Home and Admin had no milestone | Home M-UI4 (needs alerts and investigations); Admin per feature, with OIDC and data-source binding at M-UI6 (D12) |
| R11 | Release verdict was "~15 min" | Configurable delay, default 15 min |
| R12 | Customer lookup and release rollback had no audit requirement in the acceptance | Both are audited actions ([11](11-enterprise.md)) |
| R13 | Diff flame used red/blue only | Added a non-colour cue (+/−) per 05 VIZ-067 |
| R14 | Alert history storage was unstated | Dash-derived; PostgreSQL per D2 / ADR-0012 |
| R15 | 1.1-rc: the top bar, the Time Ribbon on every space and "one GPU scene per board" assumed the previous shell (roadmap Q13) | SRF-001 uses the application layout of D9; SRF-014 and SRF-019 use one canvas per viewport drawn by one shared engine and GPU device (D7) |
