# T24 — Geo, schematic and widget panels

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.23-rc · 2026-11-27 |
| **Milestone** | M-UI1 (sanitiser, links) → M-UI3 (geomap 2D core) → M-UI5 (widgets) |
| **Related ADRs** | [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md), [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md), [ADR-0016](../adr/0016-asset-integrity-verified-by-bff.md), [ADR-0019](../adr/0019-chart-frame-drawn-event-and-frame-id.md), [ADR-0020](../adr/0020-chart-camera-commit-and-value-range.md), [ADR-0023](../adr/0023-chart-event-markers.md), [ADR-0024](../adr/0024-markdown-runtime-dependencies.md), [ADR-0025](../adr/0025-chart-frame-selection.md), [ADR-0027](../adr/0027-geomap-frame-seam.md) |
| **Source draft** | plans/153, plans/181, plans/184 (not tracked) |

This document is the board **widgets**, the **geomap** and the **schematic**. It is written in parts
(§2): part A, here, defines the shared widget rules, the **Text / Markdown** widget with the one
Markdown renderer every vis and widget uses, and the **Clock / time zones** widget (rules T24-001 to
T24-018). Part B1 adds the **Board list** widget, the list-widget rules that every list widget shares,
board tags and the board search of the BFF (rules T24-020 to T24-029). Part B2 adds the **Change feed**
widget, canonical scoped entity ids on annotations, the `change` Inspector target and the log panel
gap record (rules T24-030 to T24-039). Part E step 1a adds the geomap's data layer: location
resolution, the bundled basemap and gazetteer assets and their loading (rules T24-080 to T24-087).
Part E step 1b adds the geomap frame: rows and their statuses, group identity, the camera, picking,
selection and the Inspector, the keyboard mark list, the table, CSV and facts, and the states (rules
T24-088 to T24-095, [ADR-0027](../adr/0027-geomap-frame-seam.md)). Part E step 2 adds the map's URL
state and camera history, view sync, the map area filter, auto-vis row 8 and the import of the
standard geomap panel (rules T24-096 to T24-099). Parts C–K add their rules in their own ID blocks.

## 1. Context & problem

[VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) asks for the Table 5-9
widgets on boards. Text renders Markdown with `{{entity}}` and Context variables, and Clock is a
multi-zone NOC clock with a countdown to a maintenance window.
[VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised)
asks that any Markdown or HTML a vis or widget renders is sanitised, and
[VIZ-056](../product/05-visualisation-catalogue.md#viz-056--no-arbitrary-iframes) that no iframe is
embedded: an imported iframe becomes a link that opens in a new tab, and the import report notes it.
[T18-013](T18-security.md#t18-013--markdown-renders-to-nodes-never-to-html-strings) needs a CommonMark
parser that yields a tree, and
[T08-011](T08-dom-component-kit.md#t08-011--markdown-cannot-produce-html) drops every HTML node.

The approach: widgets are DOM, with no query and no 3D form. Markdown is parsed by `commonmark` into a
tree and rendered to React elements per a `board` or `ai` policy, with URLs parsed and classified and
removals recorded without content. Import only appends links. Clock uses one due-time scheduler.

**Part B1.** VIZ-053's Board list row asks for a list of boards on a board: starred, recently viewed,
found by a search or by a tag. [SRF-026](../product/04-surfaces.md#srf-026--board-library) asks the
board library for tags, search, starred and recently viewed, and to rank boards used during
incidents. The Board list is a DOM list widget, honestly 2D (T24-001), that reads only BFF config
routes. Its list rules (T24-020, T24-024 to T24-027) are shared with the list widgets of later parts.
The BFF gains one migration: a `boards.tags` cache with a `tags_version` stamp, repaired on read.
`/boards` gains `q` and `tag`, and the list answers gain `applied` and `truncated`.

**Part B2.** VIZ-053's Change feed row asks for deploys, config changes, flags and annotations on a
board, filtered by the entity in Context, and VIZ-060 imports the Annotations list into it. Today
`/annotations` ([ADR-0023](../adr/0023-chart-event-markers.md), [T11](T11-postgres-schema.md) §4.4)
serves the board's event markers: one page of at most 500 rows, with no entity and no filter. The
approach: the **Change feed** is a list widget (T24-020) over the same board-owned query that the
markers read (T24-030). Annotations gain a canonical, binding-scoped `EntityId`
([T12-010](T12-entity-catalogue.md#t12-010--stable-identity-64-bit-wire-id), amended), so the Context
entity set (`e=`, IA-026) filters them. `/annotations` gains kind, tag and entity filters, keyset
paging over the overlap set, `applied` and `orgWideHidden`. The data scope
([T12-018](T12-entity-catalogue.md#t12-018--no-hidden-identifier-in-any-response)) is enforced inside
the one SQL statement of each path, fail closed. A row opens the Inspector on a new `change` target
([T25-002](T25-inspector-and-pivots.md#t25-002--envelope-and-union)). The log panel's gaps against
VIZ-034 and VIZ-035 are recorded (§4.9) and filed as follow-ups. Rejected: `kind:name` entity keys,
stripping `entity` for old servers, and paging by moving `to` (§12).

**Part E, step 1a.** [VIZ-045](../product/05-visualisation-catalogue.md#viz-045--location-sources)
asks the geomap to place a series from its labels: coordinates, a geohash, or a lookup of an ISO
country or region code, an IATA airport code or a cloud region id.
[VIZ-046](../product/05-visualisation-catalogue.md#viz-046--own-basemap-renderer-offline-basemap) asks
for a low-detail basemap bundled for air-gapped installs. Step 1a is the data layer only. `locate()`
maps a series' labels to one `LocationResult` by one ladder (T24-081); a clash is `ambiguous` with its
candidates and never guessed. A deterministic build script that uses only the Python standard
library makes two same-origin JSON assets, `basemap.json` and `gazetteer.json`, from pinned
public-domain sources and a curated cloud-region file (§5.13). Natural Earth is already split at
±180°, so the build **asserts** that and **clamps** latitudes to the Web Mercator limit: there is no
clipper and the topology is unchanged (T24-086). Any validation failure rejects the whole asset
(T24-087). Rejected: a polygon clipper, a binary asset format, the raw Natural Earth ISO fields (the
`_EH` fields are used, T24-085), and downloading the sources in CI (the download location would put
a host name in the repository).

**Part E, step 1b.** [VIZ-044](../product/05-visualisation-catalogue.md#viz-044--geospatial-layers)
asks for markers whose size and colour come from fields, with labels and clustering at low zoom;
VIZ-046 for the basemap drawn by Dash's own renderer; and INT-002 to INT-004 for a cursor-anchored,
inertial camera with eased programmatic moves. The approach: a `geomap` kind draws step 1a's
`LocationResult`s through `ChartFrame` in one Web Mercator world that never repeats
([ADR-0027](../adr/0027-geomap-frame-seam.md)). A row has three independent statuses (location,
value and drawing), and only usable values become marks; every other row is still in the table, the
CSV and the meter (T24-089). Groups carry colour and pattern, never colour alone (VIZ-067, T24-090),
and the engine owns the camera, the clusters and the pick (T24-091). Selection and the Inspector reuse
T25 with four `geo` target kinds and an in-request navigation stack, so an aggregate's group and a
group's marker open without a new request (T24-092). A hidden mark list gives every in-view mark a
keyboard stop (T24-093), the table and CSV list every row (T24-094), and every state has a focus
target and an announcement (T24-095). Rejected: a neutral marker colour, rings as the only state cue,
spreading coincident marks apart, a repeated world, nested member lists, inspecting an ordinary group
from its legend, `aria-activedescendant`, and a host request per navigation step (§12).

**Part E, step 2.** [VIZ-047](../product/05-visualisation-catalogue.md#viz-047--maps-share-the-camera-and-context)
asks maps to sync their view and to write the visible bounds into Context as a filter;
[INT-006](../product/03-interaction-model.md#int-006--camera-history) asks for camera history;
[VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) row 8 picks a geomap for
geo fields; and [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11)
imports the standard geomap panel. The approach: map state is board URL state written from
`geoCommit` ([ADR-0027](../adr/0027-geomap-frame-seam.md): one per gesture, view and bounds):
`map=` holds the view of a scope (the sync group `*` or a panel) and, for a writer, `geo=` holds the
map area, a filter like `f=`. One serialised store writes the board URL. Followers move by `setSpec`,
which emits no `geoCommit`, so sync cannot loop. The area is applied in the client to the returned
series: it only removes and counts them
([T12-018](T12-entity-catalogue.md#t12-018--no-hidden-identifier-in-any-response)). Row 8 is a
synchronous label test (no gazetteer, so the choice never flips when assets arrive), placed after
rows 5–7. Stored boards keep their choice: the map-sync spec version's upcaster (§5.0) marks every stored `auto`
panel `legacyAuto`, which skips row 8 until the panel is edited and saved. Import is one pure
function from the source JSON to map-sync geomap options plus ordered notes; every output passes the map-sync
validator. Rejected: label-matcher rewrites, an in-memory camera, a board variable, wrapped bounds,
a gazetteer-based row 8, a board-level version gate and hidden unmapped options (§12).

## 2. Goals / non-goals

Goals (part A): the T24 skeleton and its part map; the shared widget rules; the Text / Markdown widget
and its renderer, URL rule and removal log; the import conversion of iframes into links; the Clock
widget with zones, 12/24 h, a countdown and day and night cues without colour; the widgets spec version (§5.0).

Non-goals (part A):
- parts B–K;
- opt-in basic HTML (T18-013);
- the image proxy (T18-014, A3 in §11);
- GFM tables and syntax highlighting;
- Text `renderMode: perRow` rendering;
- any 3D form.

Goals (part B1): the shared list-widget rules (snapshot, meter, keyboard, table, CSV, facts, states
and look); the Board list widget with its starred, recent, search and tag modes; board tags in the
board spec and their cache in Postgres; the `/boards` search and tag filter, `applied` and
`truncated`; the Dashboard list import; the tags and board-list spec versions (§5.0).

Non-goals (part B1):
- part B2 (the Change feed widget, the `change` target and the log panel gaps);
- the "used during incidents" ranking (I3 in §11; SRF-026 is staged);
- star toggles on list rows;
- the board library page;
- the headless renderer.

Goals (part B2): the Change feed widget (source, entity filter, paging, snapshot and meter, rows,
selection and Inspector, keys, table, CSV and facts, compatibility, import); the canonical scoped
`EntityId` on annotations; data-scope enforcement on every annotations path; the `/annotations`
filters, keyset paging and `applied`; migration 5; the change-feed spec version (§5.0); the `change` Inspector target; the
log panel gap record.

Non-goals (part B2):
- the T12 `/changes` route and derived changes ([T12](T12-entity-catalogue.md) §4.13);
- [AUD-012](../product/01a-audiences-and-perspectives.md#aud-012--changes-ranked-and-shown-in-three-places)
  (ranked changes);
- an entity picker on the widget;
- a UI to write notes;
- the log panel follow-ups L1–L4 (§4.9, §11).

Goals (part E, step 1a): the location resolver (label input, the ladder, coordinates, geohash and
gazetteer lookups); the gazetteer and basemap builds from pinned sources; the two asset formats,
their delivery and whole-asset validation; the build tool, the curated cloud-region file and the
source pins; the notices for the bundled data.

Non-goals (part E, step 1a):
- the geomap frame and drawing: markers, camera, bounds filter and states (step 1b, T24-088–095);
- part E step 2 (T24-096–099);
- tiles and pluggable basemap sources (part F, #185);
- wrapping the map across ±180°;
- the government and China partitions of the cloud region lists.

Goals (part E, step 1b): the `geomap` kind and its seam (ADR-0027); the host and plan; rows with
their value, location and draw statuses; group identity, legend and sizes; the basemap drawing, the
camera, clusters and picking; selection, the four Inspector target kinds and the in-request
navigation stack (T25); the mark list and keys; the table, CSV (with the `csvCell` numeric
exemption) and facts; every state; the geomap spec version (§5.0).

Non-goals (part E, step 1b):
- part E step 2 (T24-096–099): view sync, the bounds filter, auto-vis and import;
- symbol and rotation from fields (part G, #186);
- spiderfying clusters and legend filters;
- wrapping across ±180° (ADR-0027);
- drawing with the wgpu renderer (#68).

Goals (part E, step 2): the board URL store; the `map=` and `geo=` codecs and the URL budget; the
map's input view, its camera history and `Alt+←`/`Alt+→`; view sync; the map area filter, its
writers, its effective area and its consumers; the pivot disclosure of the area; the map-sync spec version (§5.0);
auto-vis row 8 and `legacyAuto`; the import of the standard geomap panel.

Non-goals (part E, step 2):
- maps in Explore (Explore never picks row 8);
- the map area on log lines, traces and profiles;
- server-side area filters;
- polygon areas;
- layers other than markers (part G) and field-driven symbols and rotation.

**Part map.** Each part is designed under its own issue and adds its rules in its block.

| Part | Scope | Issue | Rules | Requirement ID if needed |
|---|---|---|---|---|
| A | Text / Markdown and Clock widgets, sanitiser and link rule (this revision) | #153 | T24-001–019 | VIZ-125 (reserved, unused) |
| B1 | Board list widget, shared list-widget rules, board tags and the `/boards` search (this revision) | #181 (step 1) | T24-020–029 | — |
| B2 | Change feed widget, the `change` target and log panel gaps (this revision) | #181 (step 2) | T24-030–039 | VIZ-126 (reserved, unused) |
| C | Alert / incident list widget | #182 | T24-040–059 | VIZ-127 |
| D | Feed widget fetched by the BFF | #183 | T24-060–079 | VIZ-128 |
| E | Geomap 2D core: location sources, markers, offline basemap, camera and bounds filter; step 1a, the data; step 1b, the frame; step 2, URL state, sync, the map area, auto-vis and import (this revision) | #184 | T24-080–099 (1a T24-080–087, 1b T24-088–095, 2 T24-096–099) | VIZ-129 (reserved, unused) |
| F | Geomap basemap pipeline and routes layer | #185 | T24-100–119 | VIZ-130 |
| G | Geomap M-UI5 layers: heatmap / hexbin, choropleth, network, day/night, track | #186 | T24-120–139 | VIZ-131 |
| H | Geomap true 3D: globe and extruded regions | #187 | T24-140–159 | VIZ-132–133 |
| I | Schematic model, viewer, data binding and audited actions | #188 | T24-160–179 | VIZ-134 |
| J | Schematic editor | #189 | T24-180–199 | — |
| K | Schematic import and auto-schematic | #190 | T24-200–219 | — |

Part A defines T24-001 to T24-018; T24-019 and VIZ-125 stay unused. Part B1 defines T24-020 to
T24-029. Part B2 defines T24-030 to T24-039; VIZ-126 stays unused. Part E step 1a defines T24-080 to
T24-087, step 1b T24-088 to T24-095, and step 2 T24-096 to T24-099; VIZ-129 stays unused.

**Part E step 1b starts from** these decisions (#184, coordinator, round 1):
- out-of-domain and infinite values are excluded from the marks and disclosed;
- the marker radius is r ∝ √(|v| / max |v|), within [min, max]; all values zero → min; negative
  values are sized by |v|, with the sign in the label and the table;
- zMin = min(computed, 14); the fit inset is min(48 px, 10 % of the smaller side); below a minimum
  plot size the panel shows "too small"; the anchor is exact unless containment moves it;
- non-colour identity per series group through `CATEGORY_PATTERNS`, with the overflow in one
  [T22-004](T22-value-categorical-and-table-panels.md#t22-004--colour-and-identity) "other (n)"
  aggregate;
- coincident marks stay reachable; one ordering and one hit-test rule;
- every consumer is defined per state; statuses are independent;
- `aria-setsize` per T24-025; a full ADR for the ±180° seam; `csvCell` in every CSV;
- a null basemap → "Map data unavailable" (T24-087).

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [VIZ-031](../product/05-visualisation-catalogue.md#viz-031--3d-only-when-it-encodes-a-dimension), [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only) | §4.1 (T24-001, T24-003) | `unit:board-spec-widgets`; `golden:widget-gallery` |
| [VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) (Text and Clock rows) | §4.1 (T24-002, T24-008 to T24-012, T24-014), §5.1, §5.2a | `e2e:widget-text`; `e2e:widget-clock` |
| [VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised) | §4.1 (T24-004, T24-006, T24-007, T24-018), §4.2 | `unit:markdown-nodes`; `fuzz:markdown-nodes`; `e2e:widget-text-xss`; `unit:xss-e2e-cases` |
| [VIZ-056](../product/05-visualisation-catalogue.md#viz-056--no-arbitrary-iframes) | §4.1 (T24-005, T24-006, T24-016), §5.4 | `unit:markdown-iframe`; `unit:find-iframes`; `unit:import-text-iframe`; `fuzz:markdown-nodes`; `e2e:widget-text-xss`; `unit:xss-e2e-cases` |
| [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity) | §4.1 (T24-003), §5.1 | `unit:board-spec-widgets` |
| [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) (Text and Clock rows) | §4.4 (T24-016), §5.4 | `unit:import-text-iframe`; `unit:import-size-error` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | §4.1 (T24-002: never auto-picked) | `e2e:widget-text` (no query) |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis), [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) | §4.1 (T24-002, T24-009, T24-017) | `e2e:widget-a11y` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel), [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) | §4.1 (T24-013, T24-015), §10 | `golden:widget-gallery`; `unit:widget-gallery-route` |
| [VL-012](../product/08-visual-language.md#vl-012--numbers-for-humans) | §4.1 (T24-012) | `unit:clock-countdown`; `unit:countdown-due` |
| [VL-014](../product/08-visual-language.md#vl-014--purposeful-motion-only), [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) | §4.1 (T24-015) | `e2e:widget-clock` |
| [T08-009](T08-dom-component-kit.md#t08-009--no-iframes), [T08-011](T08-dom-component-kit.md#t08-011--markdown-cannot-produce-html) (refined) | §4.1 (T24-004, T24-006) | `unit:markdown-nodes`; `unit:markdown-iframe` |
| [T18-011](T18-security.md#t18-011--url-scheme-allowlist) (refined) | §4.1 (T24-005, T24-008) | `unit:classify-url`; `unit:markdown-links`; `unit:markdown-interpolate` |
| [T18-013](T18-security.md#t18-013--markdown-renders-to-nodes-never-to-html-strings) (refined) | §4.1 (T24-004), §5.2 | `unit:markdown-nodes`; `fuzz:markdown-nodes` |
| [T18-014](T18-security.md#t18-014--external-images-only-through-a-signed-proxy) (amended: interim) | §4.1 (T24-018) | `unit:markdown-images` |
| [VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) (Board list row; part B1) | §4.1 (T24-020 to T24-023), §5.5 | `unit:board-list-source`; `unit:board-list-rows`; `e2e:widget-board-list` |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) (part B1) | §4.1 (T24-024, T24-029), §4.5 | `unit:list-coverage`; `unit:board-list-states`; `unit:board-list-key`; `unit:board-list-mixed`; `itest:board-list-snapshot` |
| [VIZ-031](../product/05-visualisation-catalogue.md#viz-031--3d-only-when-it-encodes-a-dimension), [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only) (part B1) | §4.1 (T24-020), §5.5 | `unit:board-spec-board-list` |
| [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) (Dashboard list row) | §4.1 (T24-028), §4.6 | `unit:import-board-list` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) (part B1) | §4.1 (T24-002, T24-020: no query, never auto-picked) | `unit:board-spec-board-list` |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis), [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) (part B1) | §4.1 (T24-025, T24-026) | `unit:list-table-csv`; `unit:list-keyboard`; `e2e:widget-lists-a11y` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel), [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) (part B1) | §4.1 (T24-027), §10 | `golden:widget-gallery` |
| [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) (part B1) | §4.1 (T24-027) | `e2e:widget-lists-a11y` |
| [SRF-026](../product/04-surfaces.md#srf-026--board-library) (staged: starred, recent, search and tags; the ranking is I3, §11) | §4.1 (T24-021, T24-023, T24-029), §5.6, §6 | `itest:board-find`; `itest:board-tags`; `unit:board-list-rows` |
| [VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) (Change feed row; part B2) | §4.1 (T24-030 to T24-035), §5.8 to §5.10, §6 | `unit:change-source`; `unit:change-rows`; `itest:annotations-entity`; `e2e:widget-change-feed` |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) (part B2) | §4.1 (T24-032, T24-033, T24-038), §4.7 | `unit:change-pager`; `unit:change-snapshot`; `unit:change-mixed`; `itest:annotations-keyset` |
| [VIZ-031](../product/05-visualisation-catalogue.md#viz-031--3d-only-when-it-encodes-a-dimension), [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only) (part B2) | §4.1 (T24-020), §5.8 | `unit:board-spec-change-feed` |
| [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity), [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) (part B2) | §4.1 (T24-037: no field options, never auto-picked), §5.8 | `unit:board-spec-change-feed` |
| [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) (Annotations list row) | §4.1 (T24-039), §4.8 | `unit:import-change-feed` |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis), [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) (part B2) | §4.1 (T24-036, T24-037) | `unit:change-table-csv`; `unit:change-selection`; `e2e:widget-lists-a11y` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel), [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) (part B2) | §4.1 (T24-034, T24-035), §10.2 | `unit:change-rows`; `golden:widget-gallery` |
| [VL-012](../product/08-visual-language.md#vl-012--numbers-for-humans), [VL-020](../product/08-visual-language.md#vl-020--fixed-glyph-language) (part B2) | §4.1 (T24-034: span floor, kind glyphs) | `unit:change-rows` |
| [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) (part B2) | §4.1 (T24-027, T24-034) | `e2e:widget-lists-a11y` |
| [INT-034](../product/03-interaction-model.md#int-034--click-selects-and-opens-the-inspector) (`change` target) | §4.1 (T24-035), [T25](T25-inspector-and-pivots.md) §5 | `unit:change-inspect`; `unit:change-selection`; `e2e:widget-change-feed` |
| [IA-026](../product/02-information-architecture.md#ia-026--context-propagation) (entity set `e=`) | §4.1 (T24-031), §5.10 | `unit:change-entity`; `e2e:widget-change-feed` |
| [VIZ-045](../product/05-visualisation-catalogue.md#viz-045--location-sources) (part E step 1a) | §4.1 (T24-080 to T24-085), §4.10, §5.11, §5.12 | `unit:geo-locate`; `unit:geo-geohash`; `unit:geo-gazetteer-build`; `unit:geo-assets` |
| [VIZ-046](../product/05-visualisation-catalogue.md#viz-046--own-basemap-renderer-offline-basemap) (staged: step 1a bundles the offline data; drawing in step 1b) | §4.1 (T24-086, T24-087), §5.12, §5.13, §6 | `unit:geo-build`; `unit:geo-decode`; `unit:geo-load`; `unit:geo-assets`; `ci:geo-data`; `ci:bundle-size` |
| [VIZ-044](../product/05-visualisation-catalogue.md#viz-044--geospatial-layers) (staged: the Markers row in part E step 1b; symbol and rotation from fields in part G) | §4.1 (T24-089 to T24-091), §4.11, §5.14, §5.15 | `unit:geo-marks`; `unit:geo-radius-project`; `unit:geo-rows`; `golden:gallery` |
| [VIZ-046](../product/05-visualisation-catalogue.md#viz-046--own-basemap-renderer-offline-basemap) (part E step 1b: the drawing) | §4.1 (T24-091) | `unit:geo-basemap-draw`; `e2e:geomap-offline` |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) (part E step 1b) | §4.1 (T24-089, T24-095), §4.11, §4.12 | `unit:geo-coverage`; `unit:geo-states` |
| [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity) (part E step 1b) | §5.15 (the geomap spec version) | `unit:board-spec-geomap` |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis) (part E step 1b) | §4.1 (T24-094), §4.14 | `unit:geo-table-csv`; `unit:list-table-csv`; `e2e:geomap` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel) (amended), [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) (part E step 1b) | §4.1 (T24-090), §10.4 | `unit:geo-identity`; `golden:gallery` |
| [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) (part E step 1b) | §4.1 (T24-093 to T24-095) | `unit:geo-facts`; `unit:geo-list`; `e2e:geomap-a11y` |
| [INT-002](../product/03-interaction-model.md#int-002--cursor-anchored-zoom), [INT-004](../product/03-interaction-model.md#int-004--smooth-programmatic-transitions) (part E step 1b) | §4.1 (T24-091) | `unit:geo-camera`; `unit:geo-ownership`; `unit:geo-keys-engine` |
| [INT-003](../product/03-interaction-model.md#int-003--inertia) (part E step 1b) | §4.1 (T24-091: a drag pans with the shared T02 camera inertia) | `unit:geo-inertia`; `unit:camera-controller` (shared) |
| [INT-034](../product/03-interaction-model.md#int-034--click-selects-and-opens-the-inspector) (`geo` targets) | §4.1 (T24-092), §4.13, [T25](T25-inspector-and-pivots.md) §4.8, §4.9 | `unit:geo-select-hover`; `unit:geo-targets`; `unit:geo-nav`; `unit:geo-inspect`; `e2e:geomap` |
| [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) (part E step 1b) | §4.1 (T24-091, T24-095) | `unit:inspector-viewkey`; `e2e:geomap-a11y` |
| [VIZ-047](../product/05-visualisation-catalogue.md#viz-047--maps-share-the-camera-and-context) (part E step 2) | §4.1 (T24-096 to T24-098), §4.15 to §4.18, §5.17 | `unit:geo-sync`; `unit:geo-sync-save`; `unit:geo-writers`; `unit:geo-area-consumers`; `e2e:geomap-sync` |
| [INT-006](../product/03-interaction-model.md#int-006--camera-history) (maps; part E step 2) | §4.1 (T24-096), §4.18, §5.17 | `unit:geo-history`; `unit:map-params`; `unit:board-url-store`; `unit:board-url-queue`; `unit:url-budget`; `unit:url-echo`; `unit:url-time-init`; `unit:url-atomic`; `e2e:geomap-sync` |
| [IA-026](../product/02-information-architecture.md#ia-026--context-propagation) (the map area `geo=`) | §4.1 (T24-098), §4.15, [T25-010](T25-inspector-and-pivots.md#t25-010--pivot-context) | `unit:geo-writers`; `unit:geo-area-consumers`; `unit:pivot-context` |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) (the map area; part E step 2) | §4.1 (T24-098), §4.15, [T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal) (`Coverage.area`) | `unit:geo-area`; `unit:geo-area-results` |
| [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity) (part E step 2) | §5.15 (the map-sync spec version) | `unit:board-spec-geomap-v8` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) (row 8; part E step 2) | §4.1 (T24-099), §5.17 | `unit:autovis-table`; `unit:autovis-legacy`; `unit:autovis-logql`; `unit:autovis-explore`; `unit:editor-preview-legacy` |
| [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) (Geomap row) | §4.1 (T24-099), §4.19, §5.17 | `unit:import-geomap`; `unit:import-geomap-fuzz` |
| [T12-018](T12-entity-catalogue.md#t12-018--no-hidden-identifier-in-any-response) (the map area; part E step 2) | §4.1 (T24-098), §8 | `unit:geo-area-scope` |

## 4. Design

### 4.1 Design rules

#### T24-001 — True 3D or honest 2D
**MUST** — (VIZ-086.) 3D is a real engine scene (depth, orbit/pan/dolly, occlusion,
[VL-023](../product/08-visual-language.md#vl-023--one-key-light-and-ambient) light), and its third axis
is a real dimension (VIZ-031). 2D never fakes depth (bevels, extrusions, shadows, isometric, tilts,
shading). Text and Clock are 2D.

#### T24-002 — Widgets are furniture
**MUST** — A **content** widget (Text, Clock) has no query, `ChartFrame`, selection, `InspectorTarget`,
`SummaryFacts`, table or CSV; its DOM text is the content. A **list** widget follows T24-020. No widget
is auto-picked.

#### T24-003 — Widget spec
**MUST** — Widgets omit `query` (`board.panel.query.forbidden`), and data panels need it
(`board.panel.query.required`). Keys not in §5.1 (e.g. `depth`) → `board.json.unknownKey`.

#### T24-004 — One Markdown renderer
**MUST** — `renderMarkdown` (§5.2) walks the `commonmark` tree into §4.2 elements only, with no HTML
string sink. Table cells, feeds, tooltips and AI output reuse it.

#### T24-005 — URL classification
**MUST** — Link, image and import-iframe URLs pass `classifyUrl` after interpolation:
- a match of `URL_FORBIDDEN` → rejected;
- `/`-leading → `new URL(raw, appOrigin)`, `local` iff it is same-origin and its pathname is not `//…`;
- absolute → `http(s):` without credentials (`external`) or `mailto:` (links only);
- anything else is rejected.

A kept link renders as `<a target="_blank" rel="noopener noreferrer nofollow">` with a glyph and a
hidden "(opens in a new tab)". A rejected one renders as text and records `linkScheme`.

#### T24-006 — Iframes never render
**MUST** — Every HTML node is dropped (T08-011), with one removal per `html_block` and one per leaf
block's inline HTML (joined as in §5.4): `iframe` if `findIframes` finds one ("Embedded page not shown
(line n): add a link"), else `html`. Import (§5.4) turns iframes into links (VIZ-056).

#### T24-007 — Removal log carries no content
**MUST** — A `Removal` is `{kind, line}`, never text, URLs or values; `kind` is `html`, `iframe`,
`linkScheme`, `image`, `unresolved` or `depth` (a block shown as its source lines, §4.2). The editor
lists one i18n line per removal (`removalMessage`); `logRemovals` does one
`console.debug({panelId, removals})` per distinct non-empty result.

#### T24-008 — Interpolation on the tree
**MUST** — `$name`/`${name}` (`VARIABLE_REF`) and `{{entity}}` are replaced after parsing, in `text`
nodes and destinations only (destinations: `encodeURIComponent`, then T24-005). Code and `__` macros
stay literal. Unresolved references stay literal and log `unresolved`. `{{entity}}` is
`useContextEntity()` (`null` for now). A Markdown-mode Text's references join the board's variables
after the data panels' (in panel order, without duplicates), so the filter bar offers them; code
mode and the other widgets add none. The renderer gets only the set variables the content
references, so another variable's change renders no Text.

#### T24-009 — Structure
**MUST** — Heading n → `<h{min(n+3,6)}>`. The body is `role="region"` labelled by the title, with
`tabIndex=0` if it overflows.

#### T24-010 — Zones
**MUST** — A zone row shows the time, the label (else the IANA city), the date (if `date`), the UTC
offset and the day difference (§4.3). `tz: ''` is the Context zone. A zone the browser rejects shows
"Unknown time zone ‹tz›" in its row.

#### T24-011 — One scheduler
**MUST** — One `wallClock` (§5.3) sets one timeout at the earliest `due`, notifies those due, and
re-arms. While the page is hidden there is no timer; when it becomes visible it notifies all and
re-arms. It runs on wall time.

#### T24-012 — Countdown
**MUST** — `r = to − now`. The text floors `r`: `in ‹d› d ‹h› h` / `‹h› h ‹m› min` / `‹m› min` /
`‹s› s` for r ≥ 1 d / h / min / s, else `now`. For r ≤ 0: `countUp` shows `since HH:MM (‹elapsed›)`
(VL-012), or `hide` hides the row.

`countdownDue` is the first ms at which the text changes: `now + (r mod u) + 1`, with u = 1 h / 1 min /
1 s for r ≥ 1 d / 1 min / 1 s; `now + r` below 1 s; after `to`, with e = −r, `now + u − (e mod u)`,
with u = 1 s / 1 min.

A polite announcement is made when the text first reads 15, 5 or 1 min, or `since … (0 s)`, not on
first render, and once on resume after a crossing while hidden.

#### T24-013 — Day/night without colour
**MUST** — An hour in [06, 18) shows `sun` and "day", else `moon` and "night", with a neutral tint
only.

#### T24-014 — Widget states
**MUST** — An empty Text shows "This text panel is empty" (view) or "Write Markdown" (edit). Invalid
options never render: the view validates first with the save's own rules (`widgetVisErrors`, §5.2a)
and then neither renders nor loads the renderer. On a board it says "This text can't be shown:
‹reason›"; the editor's preview says "Preview unavailable: ‹reason›" in a status that describes the
region, and the field shows the same reason.

#### T24-015 — Look
**MUST** — Inter 14/22 (Compact 13/20; the Text widget uses the Compact metrics until VL-013 sets the
density), code in JetBrains Mono; clock tabular figures at 32/24/18 px
(1 / 2–4 / more zones); a 4 px grid, 16 px padding and hairline rows. The only motion is a 150 ms
crossfade, cut under reduced motion.

#### T24-016 — Import
**MUST** — Import follows §4.4. `convertImportedText` (§5.4) only inserts: removing `inserted` gives
the input. Report entries carry at most a host.

#### T24-017 — Keyboard and SR
**MUST** — Tab reaches the region (if it overflows), then the links. A zone row is `role="group"`
labelled "‹label›, ‹time›, ‹date›, ‹day/night›, ‹offset›". The clock text is not live.

#### T24-018 — Render policy
**MUST** — `board`: a `local` image → `<img>`, except that a path of `/api` or `/auth` (or under them)
counts as external, because the server routes on the decoded path: decoded at the byte level for up
to three rounds, and a path that still changes or is not valid UTF-8 counts as one too; an `external`
one → a new-tab link (alt text or host; inside a kept link, the alt text; T18-014 interim); anything
else → alt text. An image not rendered as `<img>` logs `image`. `ai` ([T18](T18-security.md)
§4.10): no `<img>` or other auto-loading element; images → alt text and `image`; only `local` links
are anchors, and `external` and `mailto` links are their text plus ` (‹host›)` or ` (‹address›)`,
with no removal, until the T18 §4.10 interstitial replaces this.

#### T24-020 — List widgets
**MUST** — A list widget (`boardList`, `changeFeed`) has no `query` (T24-003), is never
auto-picked (VIZ-065), is DOM with no 3D form, reads only BFF config routes and writes nothing. It has
a snapshot (T24-024), a coverage meter, a table, CSV and facts (T24-026), and keys (T24-025). Board rows
have no selection and no Inspector: a board is neither a series key nor an interval
([T25-006](T25-inspector-and-pivots.md#t25-006--shared-selection)). Change feed rows select and
inspect (T24-035).

#### T24-021 — Board list sources
**MUST** — Each mode reads one route under one react-query key:
- `starred`: `listStarred`, key `['starred', tenant]` (the sidebar's key), in title order;
- `recent`: `listRecent(tenant, signal, 50)`, key `['recent', tenant, 50]`;
- `search`: `listBoards(tenant, signal, {q})` (`''` → no `q`), and `tag`: `listBoards(tenant, signal,
  {tag})`; key `['boards', tenant, 'find', q, tag]`, in `updated` descending order.

`q` is the trimmed search field, committed 250 ms after the last key; Esc's clear (below) commits
`''` at once. There is no `placeholderData`;
the focus refetch is `'always'`. The field holds at most 100 characters and starts at the `query`
option. A Cc character shows the inline "Search text cannot contain control characters" and commits
nothing. The field is marked `data-escape-ladder` and registers the
[T25-007](T25-inspector-and-pivots.md#t25-007--one-esc-ladder) pre step "clear the field". Case
folding is ASCII-only.

In the widget editor (§5.7, Part 2b) the Search text refuses the same Cc characters, and more than
100 code points, locally: the text stays shown with its error, nothing is written to the draft,
Done is disabled and Save is refused until it is fixed; closing the editor drops it. The editor's
preview reads the stored query through the fixed list (no field, no Esc step), so the board's own
field keeps its pre step.

#### T24-022 — Board rows
**MUST** — A row is one `<a>` to `/t/<tenant>/board/<uid>` + `contextSearchString(time)`, with
`BOARD_LINK_STATE`, as in `SidebarBoards`. Loaded rows with equal titles show `‹title› · ‹uid›` (the
uid in mono, muted). The board that holds the widget has `aria-current="page"` and "this board". Search
and tag rows show at most 3 tag chips and `+k`, or a muted "tags unknown" when `tags` is null, and
`updated d MMM HH:mm`.

#### T24-023 — Board limit, ranking
**MUST** — The list shows `limit` rows. "Show more" adds `limit` rows (up to the loaded rows) and moves
focus to the first new row. A refresh keeps the shown count, clamped to the loaded rows: the clamp is
kept, so each later answer of the key sets the count to min(count, loaded) (an empty answer starts
again at `limit`), and only Show more grows it.
`sort: 'incidents'` while `CAPABILITIES.investigations` is false gives the default order and the
caption "Ranking by use during incidents is available with investigations (M-UI4)".

#### T24-024 — List snapshot and meter
**MUST** — A `ListSnapshot` is keyed by (tenant, source, effective filter), which is the query key.
Consumers read only the current key's snapshot (§4.5). A key change hides the old snapshot at once:
the widget is pending, then ok, or an error with no rows. Within a key, a refetch replaces the snapshot
atomically, and a failed refetch keeps it with `staleAtMs`.

The meter is [T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal)
`coverageText` over `Coverage`: `total` = the loaded rows, `drawn` = the shown rows,
`query.truncated` from the answer, `query.warnings` `[]`, and nothing kept, so the cap text is
`showing X of N`. The T22-006 list members add a leading part, `coverage unknown` (`unknown` with
reason `oldServer`) or `tags not yet known for k board(s)` (reason `tagsStale`), and a trailing
`stale (HH:mm:ss)` (`staleAtMs`). Each suppresses `100 %`. The order is unknown, truncated, cap, stale. With no snapshot the meter reads
`loading` or `unavailable`. The meter's Narrow focuses the search field (search mode only).

#### T24-025 — List keyboard, SR, focus repair
**MUST** — Tab order: the search field → the list → "Show more" → the meter. The list is a `<ul>` with
one roving tab stop: ↑/↓, Home/End, PageUp/PageDown (±10 rows); Enter follows the link.
- The active row is kept by key. If its row is gone, the row at its old index (clamped) becomes
  active, and focus follows only if it was in the list.
- An empty list moves the active element to the empty text `<p tabIndex=-1>`; an error to Retry.
- A new search makes the first row active, and focus stays in the field.
- Accessible names are `‹display›[, this board]`. `aria-setsize` is the loaded count, or −1 when the
  answer is truncated or its coverage is unknown.
- Polite announcements ([T08-018](T08-dom-component-kit.md#t08-018--announcements-are-rate-limited)):
  `‹n› boards` or the empty text, once per settled search the user committed (not for the `query`
  option's first answer); on a refresh only "‹display› is no longer listed".
- A search or tag row's chips and `updated` time are the link's description (`aria-describedby`).

#### T24-026 — Table, CSV, facts
**MUST** — Shift+T shows the snapshot's rows in the kit table (#173,
[T22-013](T22-value-categorical-and-table-panels.md#t22-013--table-view-and-csv)). The CSV is RFC 4180
with the header `title,uid,tags,updated_at`: tags `;`-joined, `unknown` when `tags` is null, empty when
there are none; `updated_at` in ISO 8601 UTC. A cell that starts with `=`, `+`, `-`, `@`, TAB or CR
gets a leading `'` first (`csvCell`), unless it is a number: the whole cell matches
`^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|Infinity)$` (a JavaScript regular expression without the
`m` flag) and holds no line terminator (LF, CR, U+0085, U+2028, U+2029), so `-6.25`, `+1`, `1e5` and
`-Infinity` stay as they are and `-1+2` and `-1` followed by LF are guarded (amended by #184 step 1b, T24-094).
Facts: `current` = `{text: '‹N›[+] boards'` plus
` (coverage unknown)`, ` (stale)` or both (` (coverage unknown, stale)`), `series: ‹mode label›}`, and
the other members are null; `+` when the answer is truncated, and "coverage unknown" whenever the
coverage has `unknown`. With no snapshot the facts are null. The facts are the list's description:
an sr-only `‹mode›: ‹text›` the `<ul>` names with `aria-describedby`. The table's caption is
`‹n› boards · ‹d› shown` (loaded, shown), its way back "Show list (Shift+T)".

#### T24-027 — List states, look
**MUST** — States and texts follow §4.5. "Loading…" shows after 300 ms (`useDelayedFlag`). Rows are
36 px, with the T24-015 type and grid, hairlines, hover `surface-2`, a 2 px `focus` ring and 20 px
chips, and no state colour. Only rows new on a refresh fade in (150 ms), cut under reduced motion.

#### T24-028 — Board list import
**MUST** — Import follows §4.6 exactly, with one report note per absent-but-meaningful, malformed,
dropped, cut or clamped option.

#### T24-029 — Board tags and compatibility
**MUST** — `BoardSpec.tags` holds 0–16 unique `AnnotationTag`s (`board.tags.invalid`,
`board.tags.duplicate`). `boards.tags` caches the head spec's tags and is fresh iff
`tags_version = head_version`; every head move by this binary sets both. A list first repairs at most
200 stale rows in its own committed transaction (a failure leaves them stale), then reads the rows,
the truncation and `tagsStale` in one statement (§6). A stale row is returned with `tags: null`
("tags unknown") and never matches by tag. `tagsStale` counts every live stale row of the org, and
`tagsStale > 0` sets `unknown`.

**Old server** (no `applied` in the answer): `unknown`; `truncated` is not trusted; search filters the
titles client-side; tag mode shows "Filtering by tag needs a newer server", with no rows and no chips.
Old binaries cannot move a head saved at the tags version or later (`ErrSchemaTooNew`). A 400 `board.json.unknownKey` at `/tags` on a
save shows "This server does not accept board tags yet", on the status line and in the tags field.

**The tags field** (Edit mode, Part 2b). A "Tags" button after Add section, named by its visible
text ("Tags", "Tags (n)"), opens a popover dialog "Board tags": the tags as muted 20 px chips, each
with a × ("Remove tag ‹tag›"), and an "Add a tag" input. Return, a comma or white space adds the
typed or pasted pieces in order, lower-cased; a piece that is not a valid tag, is already present or
would be the 17th stops the run and stays in the input with its text. Backspace in the empty input
removes the last tag; at 16 tags the input is disabled. `setTags` writes `draft.tags`, and deletes the
key when the result is empty and the head had none, so removing the tags again leaves the draft
clean.

#### T24-030 — Feed source
**MUST** — The board owns one annotations query, `boardAnnotationsQuery(api, tenant, w)` (§5.10): key
`['data', 'events', tenant, fromMs, toMs]`, `staleTime: Infinity`, no refetch on focus, one page of
`limit` 500 with no filter. The event markers
([ADR-0023](../adr/0023-chart-event-markers.md), with `keepPreviousData`) and every Change feed with
no effective filter (all kinds, no tags, no entity) observe it, so one board window makes one request.
A feed with an effective filter has its own key `['data', 'changes', tenant, fromMs, toMs, kinds,
tags, ents, orgWide]`. The board's Refresh refetches each key once. On a new window the markers keep
the previous events until the answer arrives, and the feed hides the old rows (T24-024). In every
answer `truncated ⇔ next ≠ null`.

#### T24-031 — Entity filter
**MUST** — `entityMode: 'context'` filters by the Context entity set `e` (0–16 `EntityId`s,
[IA-026](../product/02-information-architecture.md#ia-026--context-propagation); any-of); `'all'`
applies no entity filter. If an entry of `e` is not a lower-case UUID (for example `checkout`), the
feed is unfiltered and shows "Entity filter unavailable for this context".
- **Organisation-wide changes.** With full scope (`orgWideHidden` ≠ null) and an effective entity
  filter, the toggle "Include organisation-wide" sets `orgWide`, which is part of the key and starts at
  the `orgWide` option. While they are excluded, the line "‹k› organisation-wide change(s) not shown"
  shows k = `orgWideHidden` ("1 organisation-wide change not shown", "3 organisation-wide changes not
  shown"); it is hidden when k is 0 or null. A scoped answer (`orgWideHidden` null) shows neither the
  toggle nor the line.
- **Subtitle:** the entity labels (T24-034) of the ids in `e`, else an id's first 8 hex digits, or
  "All entities" with no entity filter.

#### T24-032 — Paging
**MUST** — A page is taken from the **overlap set** of the window (`at ≤ toMs ∧ coalesce(end_at, at)
≥ fromMs`), after the data scope and the filters, in (`at` desc, `id` desc) order; an older page takes
the rows with `(at, id) < before`, where `before` is the previous page's `next`. `olderPage` appends
and keeps at most 2 000 rows. The snapshot is:
- **capped** iff the trim discarded rows, or `next ≠ null` with 2 000 rows loaded;
- **complete** iff `next = null` and nothing was discarded;
- otherwise it has **more**.

Between page 0 and the last page of one key: a row that persists appears exactly once; a row inserted
above a passed cursor is not shown (until a refresh), and one inserted below it appears on a later
page; a row deleted before its page is read never appears.

#### T24-033 — Snapshot and meter
**MUST** — Each key has one T24-024 `ListSnapshot` (`ChangeSnapshot`, §5.10), holding the rows and
the number of pages loaded. A new page 0 (a refresh or Retry) replaces the snapshot alone: the older
pages are dropped and older-page requests in flight are aborted. Consumers follow §4.7. The meter is
`listCoverage(loaded, loaded, more ≠ 'none', staleAtMs, unknown)`
([T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal)):
- one complete page → `100 %`;
- complete after k ≥ 2 pages → `unknown: {reason: 'paged', pages: k}`, which reads "all k pages
  loaded · may have changed while loading", with Refresh;
- more → `truncated`, with Load older;
- capped → `truncated` and "Limit of 2,000 changes reached: narrow the time range", with no Load
  older;
- an old server (T24-038) → `coverage unknown`.

#### T24-034 — Rows
**MUST** — A row has two lines and optional chips, with no state colour (T24-027):
- **Line 1** (12/16, `text-muted`): the kind glyph (◆ deploy, ⚙ config, ⚑ flag; a note has none,
  [VL-020](../product/08-visual-language.md#vl-020--fixed-glyph-language), ADR-0023) and the word
  (Deploy, Config change, Feature flag, Note), then, joined by ` · `: the time `HH:mm:ss` in the
  page's zone, with `EEE d MMM` first when the row is on another date than the window's end; for a
  range, `‹from›–‹to› · ‹span›` instead, with the span floored as T24-012 (`17 min`) and `< 1 s`
  below one second; then the entity, `‹kind› ‹ident values joined ' / '›` (absent optional positions
  are skipped), with ` · ‹binding slug›` added when loaded rows with different ids have the same
  label, or "organisation-wide".
- **Line 2** (13/20): the text exactly as authored, plain text, never parsed for entity names (the
  [T12-018](T12-entity-catalogue.md#t12-018--no-hidden-identifier-in-any-response) note).
- **Chips** when `showTags`: at most 3 tag chips, then `+k`.

#### T24-035 — Selection, Inspector
**MUST** — Click, Enter or Space on a row calls `inspect` with the origin `{surface: 'board',
panelId, title, query: null, window, unit: null}`, the target `change` (`changeTarget`,
[T25](T25-inspector-and-pivots.md) §5) and the selection `{keys: ['change:' + id], fromMs: at, toMs:
(end_at ?? at) + 1}`. Time panels draw the interval band and dim nothing, because the key is not in
their data ([T25-006](T25-inspector-and-pivots.md#t25-006--shared-selection)). The feed reads
`useSelection()` through `changeRelevance`, relative to its **loaded ids**:
- the keys hold `change:‹id›` of loaded rows → those rows are selected (`selection` background, a 2 px
  `focus` bar, the hidden text "selected") and the others muted;
- the keys are `[]` and there is an interval → the rows overlapping it (`at < toMs ∧ coalesce(end_at,
  at) ≥ fromMs`) are selected and the others muted;
- anything else (null, only foreign keys, foreign keys with an interval) → no effect.

#### T24-036 — Keyboard, SR
**MUST** — T24-025 applies, with rows as buttons; Enter or Space inspects, and a keyboard open
focuses the Inspector heading ([T25-008](T25-inspector-and-pivots.md#t25-008--focus-and-sr)). Tab
order: the "Include organisation-wide" toggle → the list → Load older or Refresh → the meter. A row's
accessible name is `‹word›, ‹text›, ‹time›[ to ‹end›, ‹span›][, ‹entity›][, tags ‹t1›, ‹t2›…]`.
`aria-setsize` is the loaded count only for a complete single page with known coverage, else −1. When
a page loads, one polite announcement reads "‹n› changes loaded", n being the rows it added.

#### T24-037 — Table, CSV, facts, fields
**MUST** — Shift+T shows the snapshot in the kit table (#173, T24-026). The CSV header is
`at,end_at,kind,entity_id,entity,text,tags,id`: times in ISO 8601 UTC with milliseconds (`end_at`
empty for a point); `entity_id` the `EntityId` and `entity` the T24-034 entity label, both empty when
organisation-wide; tags `;`-joined; every cell through `csvCell`. Facts: `current` = `{text:
'‹N›[+] changes'` (`+` with more or capped) plus ` (coverage unknown)` or ` (stale)`, `series`: the
newest row as `'‹word›: ‹text› at HH:mm:ss'`, or `''` when empty`}`; the other members are null, and
with no snapshot the facts are null.
[VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity): the Change
feed has no field options (`fieldConfig`, `thresholds` → `board.json.unknownKey`).
[VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules): it is never auto-picked.

#### T24-038 — Compatibility
**MUST** — An answer without `applied` comes from an **old server** (before I5): the meter reads
`coverage unknown`, there is no Load older, and kinds and tags are filtered client-side over its one
page; an effective entity filter shows "Filtering by entity needs a newer server" and no rows. A
create with `entity` is never stripped: an old server's 400 shows "This server cannot record the
entity yet", with no retry. Migration 5 ships after #215's migration 4 (§6).

#### T24-039 — Change feed import
**MUST** — Import follows §4.8 exactly, with one report note per dropped (a duplicate included),
malformed or unmapped option.

#### T24-080 — Label input
**MUST** — `locate` (§5.11) reads a series' labels. A key is compared in its normal form: ASCII
letters lower-cased and `.` read as `_` (`cloud.region` is `cloud_region`); other characters are
kept. An empty value is the same as an absent key. A **collision** is two raw keys with one normal
form and different values (`Site=LHR` and `site=SIN`); raw keys with equal values merge (L9).
`locate` is pure, total and deterministic: it never throws, reads only its arguments, and returns the
same result for the same input.

#### T24-081 — Resolution ladder
**MUST** — The first outcome wins:
- **(a) Collisions** count only among the keys that the deciding rule or mode reads: its aliases,
  and `cloud_provider` for the cloud rules (3 and 7 of §4.10). A collision there →
  `ambiguous: keyCollision`; a collision on any other key is ignored (C1).
- **(b) Explicit modes** read only their fields: none present → `noLocation`; one coordinate of the
  two → `invalid: incompleteCoords`; then T24-082 or T24-083 → `invalid`; a lookup as in (c).
- **(c) Auto** tries the §4.10 rules in order. The first rule with a present key decides, with no
  fallback to a later rule (C5, C8).
  - Coordinates: an axis with no present alias → `invalid: incompleteCoords`; the first invalid
    alias in precedence order → `invalid: coords` with its key; aliases with different values →
    `ambiguous: aliasConflict`. A geohash likewise (`invalid: geohash`).
  - Lookups: no gazetteer → `gazetteerUnavailable`. Each present alias is looked up in precedence
    order (unknown → hint → ambiguity → row, T24-084), and the first result that is not `placed`
    wins (C2, C9). Aliases that place different rows → `ambiguous: aliasConflict`.
- **(d) Hint.** `cloud_provider`, lower-cased, filters the cloud rows after the id resolved: no row
  left → `providerMismatch` with all the id's rows as candidates; no row for the id → `unknownCode`.

`place.key` is the raw key of the first present alias (for coordinates, the latitude's).

#### T24-082 — Coordinates
**MUST** — A coordinate is a whole string that matches `^-?\d{1,3}(\.\d{1,12})?$` (a JavaScript
regular expression without the `m` flag, so `1.5\n` does not match, L13), with |lat| ≤ 90 and |lon| ≤
180. (0, 0) is placed, and `-0` is placed as `lat` 0 (L10, L32). Two aliases have different values
when their numbers differ (`10` and `10.0` agree, L16).

#### T24-083 — Geohash
**MUST** — The lower-cased value matches `^[0-9b-hjkmnp-z]{1,12}$`, else `invalid: geohash` (`U4PA`
lower-cases to `u4pa`, which holds `a`). It is placed at its cell's centre, with `cell` = (dLat, dLon),
the cell's height and width in degrees, and `code` = the lower-cased hash. `decodeGeohash` returns
null for any other string (`''`, 13 characters, `u4pa`).

#### T24-084 — Lookups
**MUST** — Against the gazetteer (§5.12):
- **Country:** a 2-letter value is an alpha-2 code and a 3-letter value an alpha-3 code
  (upper-cased); any other value is an English name, compared after NFC normalisation and
  `toLowerCase`. Several rows → `ambiguous: sharedCode` for a code, `name` for a name.
- **Region** and **IATA:** upper-cased. In lookup mode with `country`, a region value without `-` is
  prefixed `‹country›-` (`CA` → `US-CA`, E6). Several rows → `sharedCode`.
- **Cloud:** the id is lower-cased; after the hint (T24-081 (d)), several rows → `providers`.
- **Rule 7** (`region`): the hint-filtered cloud rows ∪ the region rows; rows of both kinds →
  `regionOrCloud`.
- No row → `unknownCode` with the rule's source (rule 7 reports `cloud`) and the value as written.

A place has `lat` = y / 100 and `lon` = x / 100 of its row, the canonical `code` (the alpha-2 code for
a country), `provider` (cloud only) and `name` (the row's name or place). Candidates are sorted by
UTF-16 code units: country `‹a2› ‹name›`; region and IATA `‹code› ‹name›`; cloud `‹provider› ‹id›`;
`keyCollision` and `aliasConflict` `‹raw key›=‹value›`.

#### T24-085 — Gazetteer build
**MUST** — `tools/geo/build.py` (§5.13) builds `gazetteer.json` from the §5.13 sources:
- **ISO 3166-1** from Natural Earth 10m Admin 0: `ISO_A2_EH`, `ISO_A3_EH`, `NAME_EN` and
  `LABEL_X`/`LABEL_Y`; a feature with `-99` in a code is dropped. Several features with one alpha-2
  code → the one whose `ADM0_A3` equals its alpha-3 code if exactly one does, else all of them.
- **ISO 3166-2** from Natural Earth 10m Admin 1: `iso_3166_2`; the name `name_en`, else `name`, else
  the code; `longitude`/`latitude`. Codes that do not match §5.12 are dropped; repeated codes are
  kept.
- **IATA** from OurAirports `airports.csv`: `type` `large_airport` or `medium_airport`,
  `scheduled_service` `yes` and `iata_code` matching `^[A-Z]{3}$`; the place `municipality`, else
  `name`, else the code; repeated codes are kept.
- **Cloud:** each record of `tools/geo/cloud-regions.csv` joined on `ne_id` with Natural Earth 10m
  Populated Places for its latitude and longitude. A missing `ne_id`, or an `iso_a2` other than the
  place's, fails the build.

#### T24-086 — Basemap build
**MUST** — The build makes `basemap.json` from Natural Earth 110m Admin 0 (`ISO_A2_EH`, `ISO_A3_EH`,
`NAME_EN`). Shapefile outer rings are clockwise; a hole joins the outer that holds its first vertex.
- **Assertions** (each fails the build naming the feature, `‹a3›: …`): no edge spans more than 180° of
  longitude unless both its ends are at |lat| ≥ 85.0511, a polar closure ("edge spans more than 180
  degrees of longitude"); vertices at |lat| ≥ 85.0511 occur only in `polarFeatures`, `["ATA"]`
  ("vertex at |lat| >= 85.0511 outside polarFeatures").
- **Then** latitudes are clamped to ±85.0511 and quantised (§5.12), and consecutive duplicate points
  are removed cyclically. A ring with fewer than 3 distinct points or zero area is dropped and the drop
  written to `report.txt`, except that a collapsing outer fails the build if it is its feature's
  largest polygon by source area ("largest polygon collapses under quantisation") or has a source area
  ≥ 10⁻⁴ deg² ("polygon of ‹area› sq deg collapses"). Every feature so keeps at least one polygon;
  there is no exceptions list. Rings are then oriented and rotated (§5.12), and the T24-087 hole check
  runs ("hole not strictly inside its outer ring").
- **Strokes:** an edge with both ends on y = ±8505, or on x = ±18000 in a feature with vertices on
  both the ±18000 lines (the Natural Earth seams), is *artificial* and never stroked. An undirected
  edge in two or more rings is *border* and emitted once, in the first ring in file order. Every other
  edge is *coast*. Walking each ring from its start, the maximal runs of one class form the polylines;
  a run that wraps past the start joins the first run.

#### T24-087 — Delivery, validation
**MUST** — The client imports both assets with `?url` and `loadGeoData` fetches them from the same
origin, once per page (`cache: 'force-cache'`); they are listed in the signed asset manifest
([ADR-0016](../adr/0016-asset-integrity-verified-by-bff.md)). An asset that fails any check below is
null; there is no partial asset:
- exactly the §5.12 top-level keys; integer `v` 1 and `q` 100; every field's type and pattern (§5.12);
  exact gazetteer row lengths;
- integers only, with |x| ≤ 18000 and |y| ≤ 8505 (basemap) or 9000 (gazetteer);
- even delta-array lengths; every ring ≥ 3 distinct points, with no consecutive repeat (the closing
  edge included); outer area > 0, hole area < 0; non-empty polygon lists;
- **holes**, exact on the integers: each hole vertex strictly inside its outer (even-odd, with cross
  products; a point on the boundary fails); no hole edge shares a point with an outer or another
  hole's edge (orientation tests, collinear overlap and touching included); no hole inside another.
  The cost per polygon is hole edges × (outer + other hole edges) + hole vertices × outer edges (the
  real asset: 1 hole, 880 pair tests);
- ring edges |Δx| ≤ 18000, except polar closures on y = ±8505; polylines ≥ 2 points, with no
  consecutive repeat and |Δx| ≤ 18000.

A null asset logs one `console.debug` line naming the file. Step 1b: a null basemap shows "Map data
unavailable" and still lists the rows; a null gazetteer gives `gazetteerUnavailable` (T24-081).

#### T24-088 — Host and plan
**MUST** — The geomap is honest 2D (T24-001) with one spec
([T21-002](T21-time-and-distribution-panels.md#t21-002--one-spec-per-kind)). `panelView` routes a
`geomap` panel, after the blocked rows, to `{ kind: 'geomap' }` (`notMetric` for a LogQL log answer;
the host renders loading and errors itself), and `framePlan('geomap')` is `{spec: null, data: null,
notice: 'geomap'}`; `PanelFrame` renders `GeoMapBody` (§5.14), the lazy `GeoMapFrame`, which calls
`planGeo(p, size, view, {seq, motion})` (§5.14; `seq` +1 per new row set, `motion` `cut` under
reduced motion) and renders `<ChartFrame surface="geo" onFrame>`
([ADR-0027](../adr/0027-geomap-frame-seam.md)). `PanelRun` gains `placeholder` (the outcome is the
previous key's, TanStack `isPlaceholderData`) and `retry()` (its `refetch()`).
- **Plan order** (the first that holds): a pending run (no answer and no error, or a placeholder
  while fetching) → `loading`; a failed run with no answer of its own → `error`; a `string` result
  (`{code: 'kind'}`) or
  a failing `validateGeoRows` → `invalid`, "Invalid map data (‹detail›)"; a null basemap →
  `mapDataUnavailable` (the rows, no frame); plot W < 160 or H < 120 CSS px → `tooSmall`; 0 rows →
  `empty`; 0 `shown` rows → `noneShown`; else `ok`. Only `empty`, `noneShown` and `ok` build a frame.
  `tooSmall` follows `invalid`, so its rows are always validated (`rows: GeoRowSet`, never null).
- **Events.** `ChartFrame` owns `select` and `hover` (`targetOf` for `geo` items, §5.14).
  `GeoMapFrame` subscribes to exactly `geoCommit`, `geoBrush` and `geoMarks` of each engine frame,
  and disposes those subscriptions with it.
- **View.** The host keeps `lastView` (the latest commit) and `applied` (the last applied
  `options.view`). If `options.view` differs from `applied` by value (null included): `spec.view =
  options.view`, `lastView` = null and `applied` = it (null → refit). Otherwise `spec.view =
  lastView ?? options.view`. A new engine frame (an engine swap) starts at that view. From part E
  step 2, a non-local map's input view in place of `options.view` here is T24-096's (its URL entry).
- The mark list's active mark is passed to `setFocusMark` (T24-093).

#### T24-089 — Rows
**MUST** — `geoRowSet` (§5.15) makes one `GeoRow` per series. **Value:** an instant result gives the
one value of each series; a range result reduces by `reducer`
([T22-003](T22-value-categorical-and-table-panels.md#t22-003--one-reduction-path); duplicate series
combined, the max on a conflict). `valueStatus` follows
[T21-012](T21-time-and-distribution-panels.md#t21-012--values) (`ok`, `noValue`, `infinite`,
`outOfRange`). **Location:** the 1a `locate` (T24-081). **Draw status** (zoom-independent), the
first that holds:
1. `notPlaced`: the location is not `placed`;
2. `outsideMap`: \|lat\| > 85.0511;
3. `excluded`: the value is not `ok` (the row is in the table and the meter only);
4. `capped`: the row is left out by `capMarks`
   ([T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal)) above 5 000
   drawable rows, with (c) in key order;
5. `shown`.

The three statuses are independent: a row can be placed with no usable value, or have a value and
no place. `geoFrame.shown` holds the indices of the `shown` rows.

**`validateGeoRows`** checks a row set (the first failure wins, its detail named):
- `order`: keys non-empty and strictly increasing (UTF-16 code units, §4.11);
- `value`: each `valueStatus` is the T21-012 status of its value (`ok` exactly for a usable value);
- `state`: all null without thresholds; with thresholds, a non-`ok` value has `unknown` and an `ok`
  value its threshold state;
- `draw`: each draw status is the one derived above;
- `group`: 0 ≤ group < groups.length ≤ 8; patterns and colours per T24-090; the `{other}` group
  exists iff there are ≥ 8 group ids, and its members are the distinct ids of its rows in
  first-appearance order; every other row's `groupId` is its group's id; no row has the id
  `{other}`;
- `coverage`: every count equals a recount.

#### T24-090 — Identity
**MUST** — **Groups.** A group's identity is its tagged `GroupId`, never its label: `{series: key}`
(no `groupBy`), `{present: true, value}` or `{present: false}` (the `groupBy` label is absent);
`{other: true}` is the aggregate's alone. Group j is numbered by first appearance in key order.
- **Labels** (injective): a series group → the series name; absent → `‹L› absent`; the aggregate →
  `other (n)`. A present value is shown plain unless it starts with `"`, equals `other` or
  `‹L› absent`, ends with ` (‹digits›)` or holds a control character; then it is
  `JSON.stringify(value)`.
  Plain labels never start with `"` and quoted ones always do, JSON quoting is injective and the
  reserved forms are never plain, so `groupBy` labels never collide. This amends
  [T22-004](T22-value-categorical-and-table-panels.md#t22-004--colour-and-identity)'s unescaped
  quoting.
- **Final pass** over every legend label: T22-004's disambiguation (the shortest key set,
  ` · k="v"` / ` · k absent`); a label still shared gets ` (n)`, n from 1 in key order, skipping
  labels in use; the aggregate is never suffixed.
- **Colour:** `seriesColourIndex` (T22-004) when `groupBy` is null, else j mod 8
  ([T21-003](T21-time-and-distribution-panels.md#t21-003--encoded-twice)).
- **One group** → the `solid` pattern and no legend. **Several:** j ≤ 6 → `CATEGORY_PATTERNS[j]`;
  j ≥ 7 → one aggregate **other (n)** (`OTHER_PATTERN`, `category-other`, `members` = the ids).
  Legend: each group (swatch, label, and "(not shown)" if none of its rows is shown), and `other
  (n): ‹first 8 member labels›, +k more`.
- **State** (with thresholds): `colour: 'group'` (the default) keeps the group fill and pattern and
  adds a 2 px state outline and the state glyph (inside the marker at r ≥ 8, else at its upper
  right); `colour: 'state'` uses the state fill and glyph with the pattern over it (`pattern-ink`).
  A cluster shows a chip of its worst state.
- **Grouped marks** ([T22-004](T22-value-categorical-and-table-panels.md#t22-004--colour-and-identity),
  amended): with `groupBy`, colour and pattern are the group's; its series differ in the tooltip, the
  table and the Inspector; state stays on every marker.
- **Overflow** (T22-004 and [T22-007](T22-value-categorical-and-table-panels.md#t22-007--click-selects-inspects-filters),
  amended): the aggregate's members keep their positions and marks; the aggregate is the legend
  entry and the target `other:geo` (T24-092); a click on a member's mark targets that member.
- **Sizes:** with a pattern, min′ = max(min, 8) and max′ = max(max, min′); with one group, min′ =
  min and max′ = max. M = the max \|v\| over the `shown` rows. `size.by: 'value'` → r =
  max(min′, max′·√(\|v\|/M)), and M = 0 → min′; `'fixed'` → max′. Negative values are sized by \|v\|,
  with the sign in the labels.

#### T24-091 — Camera and picking
**MUST** — The engine owns the camera ([ADR-0027](../adr/0027-geomap-frame-seam.md)).
- **One world:** a row's longitude → [−180, 180) by `((lon+180) mod 360 + 360) mod 360 − 180`; u =
  (lon+180)/360, v = ½ − ln((1+sin φ)/(1−sin φ))/(4π); inverse lon = 360u − 180, lat =
  atan(sinh(π(1−2v))); the world is 256·2^z CSS px; basemap x as stored; no repeat; everything is
  clipped to the plot.
- **Tokens** (`design/tokens.toml`): `map-water` (the plot and the holes) dark `#0E1620`, light
  `#E6EDF4`; `map-land` dark `#1C232C`, light `#F8F9FB`; `map-coast` dark `#FFFFFF33`, light
  `#0B0D103D`; `map-border` dark `#FFFFFF1F`, light `#0B0D1029` (the light strokes in the hairline
  ink, so no light colour is the dark one inverted). Every series colour keeps ≥ 3:1 on `map-land`
  and `map-water`.
- **Basemap:** one path per polygon (the outer and its holes), filled `map-land` with the `nonzero`
  rule by the asset's orientations, so holes stay water; strokes only from `coast` (1 px) and `border`
  (0.5 px, `map-border`), each once, never ring outlines (so no artificial edge is drawn).
- **Zoom range:** zMin = clamp(log2(max(W, H)/256), 0, 14), zMax = 14; the inset p = min(48, 10 % of
  min(W, H)) CSS px. A view below zMin is raised to zMin.
- **Contain:** per axis inside the world, else centred and letterboxed (the world is 4 194 304 px
  wide at zoom 14); never across ±180°; bounds never wrap.
- **Fit** (view null): the box of the `shown` rows with inset p, z = clamp(fitted, zMin, max(6,
  zMin)); no shown row → (20, 0, zMin); then contained.
- **Wheel** (over the plot only; `wheelZoom: false` → the page scrolls): Δz = −log2(factor); a
  `panX` wheel pans by its fraction × the width (contained); a `null` wheel is ignored. A drag pans
  ([INT-003](../product/03-interaction-model.md#int-003--inertia)) and a release faster than 0.3 px/ms
  continues with the T02-022 spring, its initial velocity the release velocity v (the displacement
  over the last 80 ms of moves): offset(t) = D − (D + (ωD − v)t)e^(−ωt), ω = 0.0194 ms⁻¹, D = 2v/ω
  (no overshoot; 2 % of D is left at t ≈ 267 ms, where it lands on D); a right drag box-fits;
  Alt+drag emits `geoBrush`; a double-click zooms ×2, or fits a cluster's members when on a cluster.
- **Anchor** ([INT-002](../product/03-interaction-model.md#int-002--cursor-anchored-zoom)): the
  lat/lon under the pointer stays under it unless containment shifts the view (the drift equals the
  shift).
- **Keys** (`cameraKey`, called by the focused surface and by the mark list, T24-093): `+`/`=` zoom
  ×2 (`in`), `-` ÷2 (`out`), about the `setFocusMark` mark if it is in view, else the centre; `0`
  fits; Shift+arrows pan 25 % of the plot. Each key commits once; programmatic moves ease in ≤ 250
  ms ([INT-004](../product/03-interaction-model.md#int-004--smooth-programmatic-transitions)).
- **Ownership:** `setSpec` moves the camera only when `spec.view` changes (by more than 1e−9) and
  differs from the camera; non-null → null refits at once; a null view refits on `setData` until the
  next commit.
- **Clusters:** at Z = ⌊zoom⌋, seeds (seed order, §4.11) take the unassigned `shown` rows within 40
  world px; ≥ 2 rows → a cluster `cluster:` + seed key, drawn at the seed. `cluster: false` still
  joins identical positions. A cluster is a `surface-2` disc of r 14, 16, 18 or 20 (n < 10, < 100, <
  1 000, more) with its count and, at worst rank ≥ 2, the worst-state chip. Level changes crossfade
  in 150 ms, and only the new marks are pickable; reduced motion
  ([VL-016](../product/08-visual-language.md#vl-016--reduced-motion)) cuts every ease and fade.
- **Pick:** the last-drawn mark (draw order, §4.11) whose disc of radius max(r + 4, 12) holds the
  pointer.
- **Labels** `auto`: the names are drawn when there are ≤ 50 marks (greedy, in seed order).

#### T24-092 — Selection and Inspector
**MUST** — Targets are snapshots built by `geoTarget` (§5.16); a refetch never changes an open one.
- **Entry:** a marker click or Enter → a `marker` target, `select([key])`; a cluster → a `cluster`
  target with its keys and no filter (T22-007). With ≥ 2 groups, an ordinary legend entry →
  `select(group keys, member)` only; `other (n)` → its rows' keys and an `aggregate` target; an
  Inspector member entry → `push` ([T25](T25-inspector-and-pivots.md) §4.8); `geoBrush` →
  `select(keys, brush)` (`[]` → no change); an empty click → `select(null)`; a table toggle
  ([T25-016](T25-inspector-and-pivots.md#t25-016--table-row-source)) → `select([key], tableRow)` or
  `select(null)`; a table row's Inspect → a `marker` target (any row, drawn or not).
- **Read** ([ADR-0025](../adr/0025-chart-frame-selection.md)): the selection is relevant iff one of
  its keys is among the keys of all loaded rows (shown or not). Then the shown marks that do not match
  are `dimmed` and a match gets the 2 px `focus` ring (a cluster also "‹k› selected"); a selected
  undrawn row is highlighted in the table ("Not placed"). Only foreign keys → nothing dims.
- **Lifetime** ([T25-012](T25-inspector-and-pivots.md#t25-012--lifetime)): kept through refreshes
  and window changes; closed (with its `nav`) by panel removal, a query or vis change and a route
  change (focus: `returnFocus`).

#### T24-093 — Mark list and keys
**MUST** — A hidden `<ul aria-label="‹title›: map marks">` of `<button>`s holds the in-view marks in
keyboard order (§4.11) with one roving tab stop (T24-025).
- **Names:** a marker `‹name›, ‹formatValue›[, ‹state›], ‹geoPlace›[, selected]`; a cluster `Cluster
  of ‹n›, near ‹seed place›[, worst ‹state›][, ‹k› selected]`. `aria-posinset` = index + 1;
  `aria-setsize` = the count iff `complete` (the meter reads `100 %`) and every mark is in view, else
  −1.
- **Keys** (handled keys are prevented and stopped): unmodified ↑/← and ↓/→, Home/End,
  PageUp/PageDown (±10, clamped); Enter/Space inspect (a keyboard open focuses the Inspector
  heading); Shift+arrows → `cameraKey(pan…)`; `+`/`=` → `in`, `-` → `out`, `0` → `fit`. Other keys,
  Esc included ([T25-007](T25-inspector-and-pivots.md#t25-007--one-esc-ladder)), propagate. The
  active mark → `setFocusMark(id)`; focus leaving both the list and the surface →
  `setFocusMark(null)`.
- **None in view** (`ok`): one item "No marks in view · Fit" (no posinset or setsize); Enter/Space →
  `cameraKey('fit')`. While it is focused it stays when marks return; ↓/→/Home then go to the first
  mark and ↑/←/End to the last.
- **Repair** on `geoMarks`: the same id, else the mark holding the old seed or key, else the old
  index clamped, else the placeholder. Focus moves only if it was inside the list. A refetch that
  drops the active mark announces "‹old name› is no longer shown".
- **Legend** (≥ 2 groups): a button per entry. Tab order: surface → list → legend → meter.

#### T24-094 — Table, CSV and facts
**MUST** — **Table** (Shift+T,
[T22-013](T22-value-categorical-and-table-panels.md#t22-013--table-view-and-csv)): every row,
ordered by name then key (UTF-16), with the §4.14 columns (values unguarded), a T25-016 toggle and
Inspect per row; selected rows have the `selection` background and the hidden text "selected".
**CSV:** the same columns, order and header, RFC 4180; every cell through `csvCell` (T24-026, with
its numeric exemption). **Facts**
([T22-014](T22-value-categorical-and-table-panels.md#t22-014--summary-facts), unchanged): the marks
are the rows with an `ok` value (before the cap, any draw status); the focus mark is the worst state
(with thresholds), then the higher value, then the lower key; `current` = {`formatValue`, the series
name}; `change` (range results) = the focus series' largest \|Δ\| between consecutive finite samples,
the first on ties, {from, to, atMs of the later}; `extent` = the min and max of the marks;
`baselineRatio` null. #160 renders them
([VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport)).

#### T24-095 — States
**MUST** — Every consumer follows §4.12 in each T24-088 state. A `role="status"` region
(`tabIndex=-1`) exists at once in the states other than `ok`, with `aria-busy` while loading and its
text after 300 ms. On a state change focus moves to the new state's target only if it was inside the
panel (the surface, the list, the legend, the status, Show table or Retry), then a polite announcement
follows ([T08-018](T08-dom-component-kit.md#t08-018--announcements-are-rate-limited)). A state change
never changes the selection.

#### T24-096 — View state and history
**MUST** — A map's view and the map area are board URL state (§4.18, §5.17): `map=` holds the view
of a scope (`*` for the synced maps, else the panel id) and `geo=` the map area (T24-098).
`mapRoles` (§5.17) gives each geomap its role and scope.
- **Input view** (amends T24-088): a `local` map uses T24-088 only (no URL or history; on reload and
  back it shows `options.view`). Any other map takes the URL entry of its scope; synced maps with no
  `*` entry use their own `options.view`. An entry equal to `encodeView(scope, lastView)` passes
  `lastView` (exact, no snap).
- **Writes:** every `geoCommit` of a non-local frame in `empty`, `noneShown` or `ok` (§4.16) → one
  `update(push)` with `withMap(scope, view)` (and `withArea(scope, bounds)` for a writer, T24-098);
  keyboard commits too ([INT-006](../product/03-interaction-model.md#int-006--camera-history)). A
  writer's view and area are written together or not at all (`kind: 'map'`). `'url.tooLong'` → both
  stay local (`lastView`; consumers keep the URL's area) with the notice "Link too long — map changes
  not saved in the link" until a write lands; an evicted map likewise, until its next write or an
  applied location.
- **History** (INT-006 as implemented,
  [T03-016](T03-browser-runtime.md#t03-016--browser-history-is-camera-history)): one entry per
  distinct encoded state; a commit whose encoding equals the URL (below URL precision, ≤ 0.28 px at
  zoom 14) writes nothing. No write on the first draw, a refit, a follow or a popstate.
- **Reads:** the URL is read in full and never rewritten by the map feature; entries of unknown,
  non-geomap, local or other-scope panels are ignored. On every applied location (§4.18) each map
  takes its entry (absent → `options.view`, `lastView` cleared) with its `motion` (reduced motion: a
  cut). A URL change is no route change ([T25-012](T25-inspector-and-pivots.md#t25-012--lifetime):
  the pathname).
- **Keys:** the shell binds `Alt+←`/`Alt+→` (no other modifier; not in editable targets;
  `preventDefault`,
  [T03-013](T03-browser-runtime.md#t03-013--preventdefault-is-decided-synchronously)) to
  `history.back()`/`forward()`; the mouse back and forward buttons are the browser's.

#### T24-097 — Sync
**MUST** — Synced maps share the `*` entry (§4.17; `*` always wins for synced maps). Followers in a
frame-building state (§4.16) move by `setSpec` (with their own containment); the others start at `*`
when their frame builds. Unsynced maps ignore `*`. There is no loop: `setSpec` emits no `geoCommit`
([ADR-0027](../adr/0027-geomap-frame-seam.md) §4), and only `geoCommit` writes.

#### T24-098 — Map area
**MUST** — **Writers** (`mapRoles`): a commit writes `geo=` = `encodeArea(scope, commit.bounds)`;
the last commit wins; writers never apply the area. A `local` map is no writer; with `boundsFilter`
on it shows "Map area filter off: more than 8 unsynced maps on this board".
- **Effective area** (provenance): the URL's `geo=` applies only while its scope is a current writer
  scope (`*` iff a synced map has `boundsFilter`; a panel id iff that unsynced, non-local map has
  it); otherwise it is inactive: no chip, no filtering and no pivot disclosure (and no rewrite). An
  old entry's area applies only while its writer is one.
- **Cleanup:** when a scope stops being a writer (option, deletion, sync), `geo=` is removed in that
  update (a removal, replace) only if its scope is that scope. Roles are recomputed per spec change
  and per read; a former writer applies the area from its next plan.
- **Consumers** (§4.15) apply `applyArea` after the run and before planning, with the panel's
  `location` (geomap) or `{mode: 'auto'}`; they are `loading` while `geoData` is. 0 kept → "No series
  in the map area", the meter parts and **Clear map area** (removes `geo=`, push; focus: the filter
  bar). The filter bar shows `areaChip` of the effective area only, with "Remove map area filter"
  (push). Filtered-out series are not loaded ([ADR-0025](../adr/0025-chart-frame-selection.md)); the
  Inspector keeps its snapshot.
- **Scope** ([T12-018](T12-entity-catalogue.md#t12-018--no-hidden-identifier-in-any-response)):
  only returned series are kept or counted; `geo=` and `map=` never reach the BFF.
- **Pivots** ([T25-010](T25-inspector-and-pivots.md#t25-010--pivot-context), effective area only):
  the filter "map area": Explore "Filters not applied in Explore yet: ‹keys›, map area"; logs,
  traces and profiles "Not carried to ‹dest›: …, map area".

#### T24-099 — Auto-vis row 8, import
**MUST** — With vis `auto` and no `legacyAuto`, after rows 5–7, `hasGeoFields` (§5.17) → `geomap`
with the map-sync defaults; never over an explicit vis (`chooseVis`). A `legacyAuto` panel skips row 8, so
a stored board keeps today's vis; its editor preview renders the draft without `legacyAuto` (row 8,
"Auto (Map)"), and the editor's save drops `legacyAuto`; saving another panel or the board layout
keeps it. LogQL panels: for a panel without `legacyAuto` (and the editor's draft), a metric-series
answer takes the ordered auto-vis decision (rows 5–8, then the rest) and its editor label is that
decision's; a `legacyAuto` panel keeps exactly today's result (the fixed line, label Line) until
edited and saved; a log-line answer keeps today's handling. Explore never picks row 8 (no geomap kind
there yet). Import follows §4.19; its output passes the map-sync validator. **Rows 8 and 11
together** (#173 Part 3b, [T22](T22-value-categorical-and-table-panels.md) §4.5): the map-sync
spec version's `legacyAuto` covers row 11 (reduced categories → bar chart) as well as row 8. Until
map-sync, a board `auto` panel chooses from the pre-bars set; at map-sync every stored `auto` panel
is marked `legacyAuto` and keeps that legacy set (no row 8, no row 11), and a panel saved at
map-sync or later gets both rows, under this rule's preview and save rules. #237 implements it.

### 4.2 Markdown node table (`commonmark` → output)

| Node | Output |
|---|---|
| paragraph | `<p>`; in a tight list item, its inlines only |
| heading n | `<h{min(n+3,6)}>` |
| block_quote | `<blockquote>` |
| list | `<ul>` / `<ol>`, with `start = min(listStart, 999 999)` only when it is not 1 |
| item | `<li>` |
| thematic_break | `<hr>` |
| code_block | `<pre><code data-lang>` (info word `[a-z0-9-]{1,20}`) |
| text | text (interpolated, T24-008) |
| softbreak | `' '` |
| linebreak | `<br>` |
| emph, strong, code | `<em>`, `<strong>`, `<code>` |
| link | T24-005 |
| image | T24-018 |
| html_block, html_inline | T24-006 |
| anything else | dropped (`html`) |

No source attribute is copied. The output is pure and memoised (LRU 32).

**The walk** (#198 Part 2b). The tree is walked post-order with an explicit stack, never by
recursion. Each frame holds its output; a finished frame gives it to its immediate parent only: an
element wraps it, while a rejected link, an `ai` non-local link and a tight-list paragraph splice it
in. The root's output is returned as the fragment. Inside an image's alt only text survives (links,
emphasis and code give their text; HTML gives nothing but is still counted; a nested image records
`image`). A run of `text` siblings is interpolated as one string. Removals are recorded on entry, so
in document order; `html`/`iframe` once per leaf block, at its first HTML node.

**Depth.** Each node costs the elements it creates: 1 for paragraph, heading, block quote, list,
item, emphasis, strong, code, hard break and thematic break; 2 for a code block (`pre`, `code`) and a
kept link (`a`, then its spans); 0 for a tight-list paragraph, a rejected or `ai` non-local link and
HTML; for an image 1 (`<img>`), 2 (a new-tab link) or 0 (alt text). A leaf block's inlines are
pre-scanned (an iterative post-order with the render's context) for the deepest cost chain below it.
A block (not an `html_block`) at depth d with cost c and inline chain i is shown **flat** when
d + c + i > `MAX_DEPTH` − 1: one `<span class=flat>` (`white-space: pre-wrap`) holding the block's
**whole source lines**, verbatim with their terminators (`sourceLines`), and one `depth` removal; its
children are not visited, interpolated or counted. Elements reach `MAX_DEPTH` − 1 and a flat span
`MAX_DEPTH`, so the DOM depth below the root is at most 32. Inline nodes are visited at most twice
(pre-scan, render), blocks once.

### 4.3 Clock formats (`Intl.DateTimeFormat`)

The date is `weekday:'short', day:'numeric', month:'short'`; the offset is `longOffset`, with `GMT`
shown as `UTC`. The day difference is the zone date − the Context-zone date. `since` uses the first
zone.

### 4.4 Import mapping (#158, #17)

- **Text:** `mode` (`html` → `markdown`); `code.language`, or `plaintext` (noted);
  `convertImportedText(content, mode)`, with a report line per note; `ok: false` → §5.4 step 5.
- **Clock:** `timezone` → `zones[0].tz` (`''` if absent or "browser"; unknown → noted); `clockType`
  `12 hour` / `24 hour` / `custom` → `h12` / `h23` / `auto` (custom noted); countdown/countup with
  `countdownSettings.endCountdownTime` and `endText` → `countdown {to, label, after:'countUp'}`.
- Other keys are dropped ("Option ‹key› not mapped"); lines matching `^\s*\|.*\|\s*$` are noted
  "Markdown table shown as text".

### 4.5 List widget states (T24-024, T24-027)

| State | Rows | Meter | Table / CSV | Facts |
|---|---|---|---|---|
| key change (debounced filter, mode, tenant) | the old key's rows hidden at once | — | — | — |
| pending, no snapshot for this key | "Loading…" after 300 ms | `loading` | "Loading…" / disabled | null |
| empty | the empty text (below) | `100 %` or `coverage unknown` | none / header only | `0 boards` |
| ok | the snapshot | `coverageText` | the snapshot | the snapshot |
| error, no snapshot for this key | "Couldn't load boards" + Retry (503: "The configuration store is unavailable") | `unavailable` | the error / disabled | null |
| same-key refetch failed | rows kept, "Couldn't refresh: showing boards from HH:mm:ss" (the rows' fetch time) + Retry | `… · stale (HH:mm:ss)` | the snapshot | `… (stale)` |
| refetch ok | the new snapshot (T24-023, T24-025) | recomputed | new | new |

Empty texts: "No starred boards. Star a board with ☆ in its header" · "No recently viewed boards" ·
"No boards match ‘‹q›’" · "No boards tagged ‹tag›".

**Cancellation:** on a key change the widget unsubscribes. React-query aborts the request only when no
observer remains, and the old answer never renders in this widget. The debounce timer is cleared on
unmount.

### 4.6 Board list import (VIZ-060; Dashboard list → `boardList`; #158, #17)

- Defaults: `showStarred` true, `showRecentlyViewed` and `showSearch` false, `maxItems` 10, `query`
  `''`, `tags` `[]`. A wrong type → the default and "Option ‹key› malformed: default used". `sort` is
  `default`.
- The mode is the first enabled of starred, recent and search. None → starred and "No list enabled:
  starred used"; more than one → "Only the first list (‹mode›) kept: add another Board list for
  ‹modes›". The mode note comes first in the report.
- Search: tags are lower-cased; an invalid one → "Tag ‘‹t›’ dropped: not a valid tag". The first valid
  tag → tag mode; the other valid tags → "Tags not kept: ‹list› (a board list filters by one tag)";
  search text → "Search text dropped in tag mode". With no valid tag, Cc characters are removed
  ("Control characters removed from search text"), then the text is cut to 100 code points ("Search
  text cut to 100 characters").
- Other modes with search text or tags → "Search text and tags dropped: they apply to search only".
- `maxItems` is clamped to 1–50 ("Item limit ‹m› clamped to ‹l›"); `keepTime: false` → "Links keep the
  time range"; other keys, sorted → "Option ‹key› not mapped".
- Note order: (1) the mode note (more than one extra list: joined with " and "); (2) the malformed
  notes, in the order `showStarred`, `showRecentlyViewed`, `showSearch`, `maxItems` (an integer),
  `query` (a string), `tags` (an array of strings), `keepTime` (booleans otherwise); (3) search: each
  invalid tag (its source text quoted), then "Tags not kept" (the other valid tags, lower-cased,
  deduplicated, the kept tag excluded), then "Search text dropped in tag mode" (a non-empty query);
  with no valid tag, the Cc note, then the cut note; other modes: one "Search text and tags dropped"
  when either is non-empty; (4) the clamp; (5) `keepTime`; (6) the unmapped keys, in code-unit order.

### 4.7 Change feed states (part B2; T24-033)

| State | Rows | Meter | Table / CSV | Facts |
|---|---|---|---|---|
| key change / pending | the old key's rows hidden at once / "Loading changes…" after 300 ms | `loading` | off | null |
| empty | "No changes in this time range" (with a kind subset, e.g. "No deploy or config changes in this time range") | `100 %` or `coverage unknown` | header only | `0 changes` |
| complete | the rows | `100 %` (one page) / the paged text + Refresh | the rows | `‹N› changes` |
| more / capped | the rows + Load older / the 2 000 rows and the cap text | `truncated` | the loaded rows | `‹N›+ changes` |
| an older page fails | the rows + "Couldn't load older changes. Retry" | unchanged | unchanged | unchanged |
| refresh ok / fails | the new page 0 / the rows kept + "Couldn't refresh: showing changes from HH:mm:ss" | recomputed / `… · stale (HH:mm:ss)` | the rows | recomputed / `… (stale)` |
| error, no snapshot for this key | "Couldn't load changes" + Retry (503: "The configuration store is unavailable") | `unavailable` | off | null |

Older-page requests are aborted on unmount, on a key change and when a new page 0 replaces the
snapshot.

### 4.8 Change feed import (part B2; VIZ-060; Annotations list → `changeFeed`; #158, #17)

- Fixed: all kinds, `entityMode: 'context'`, `orgWide: false`.
- `tags`: not an array of strings → "Option tags malformed: default used" (`[]`). Otherwise each tag
  is lower-cased; an invalid one → "Tag ‘‹t›’ dropped: not a valid tag" (‹t› as written); a repeat →
  "Duplicate tag ‘‹t›’ dropped"; past 8 → "Tag ‘‹t›’ dropped: at most 8 tags" (both lower-cased).
- `showTags`, `onlyFromThisDashboard` and `onlyInTimeRange` that are not booleans → "Option ‹key›
  malformed: default used" (defaults true, false and true).
- `onlyFromThisDashboard: true` → "The change feed lists the organisation's changes";
  `onlyInTimeRange: false` → "The change feed lists the board's time range"; `limit` → "Paged by the
  change feed"; other keys, sorted → "Option ‹key› not mapped".
- The notes come in the order listed: the tag notes in tag order, then the malformed booleans in the
  order `showTags`, `onlyFromThisDashboard`, `onlyInTimeRange`, then the three meaning notes, then
  the unmapped keys.

### 4.9 Log panel gap record (part B2; informative)

The board log panel today against [VIZ-034](../product/05-visualisation-catalogue.md#viz-034--log-stream)
and [VIZ-035](../product/05-visualisation-catalogue.md#viz-035--log-patterns-with-new-badge). The
implementation documents it in `docs/client/logs.md`:

| Feature (VIZ) | Today | Follow-up |
|---|---|---|
| GPU text (034) | A DOM list | #69 |
| A 10⁶-line fling at frame rate (034) | **Gap**: the fling stops at each slice end (Q-B1 in `docs/client/logs.md`) | L4, #136 |
| Minimap of error density (034) | Missing | L1 |
| JSON tree, prettify (034) | Missing | L1 |
| Dedupe, context lines (034) | Missing | L2 |
| Patterns with the NEW badge (035) | Missing | L3 |
| Severity gutter, wrap, paging (034) | Met | — |

### 4.10 Geomap auto rules (part E; T24-081)

Normalised aliases (T24-080), in precedence order within each rule:

| # | Aliases | Source |
|---|---|---|
| 1 | lat `lat`, `latitude`, `geo_location_lat`; lon `lon`, `lng`, `longitude`, `geo_location_lon` | coords |
| 2 | `geohash`, `geo_hash` | geohash |
| 3 | `cloud_region` (hint `cloud_provider`) | cloud |
| 4 | `geo_region_iso_code`, `region_iso_code` | region |
| 5 | `geo_country_iso_code`, `country_code`, `country` | country |
| 6 | `iata`, `iata_code`, `airport` | iata |
| 7 | `region` (hint `cloud_provider`) | cloud or region |

### 4.11 Geomap orders and coverage (part E step 1b; T24-089 to T24-093)

Strings compare by UTF-16 code units (JavaScript `<`). Series keys are hashes and never start with
`cluster:`.

| Order | Key (ascending) | Use |
|---|---|---|
| seed | (−rank, −\|v\|, key) | clusters |
| draw (bottom → top) | (−r, rank, \|v\|, id); a cluster takes its members' max | drawing, pick |
| keyboard | (y, x, id) of the centres (CSS px, exact) | the mark list (T24-093) |

rank: failing 4, degraded 3, watch 2, else 0.

**Coverage** ([T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal),
amended: `Coverage.geo`), counted before the cap, in this order with zeros omitted: `k not placed`
(not counting the ambiguous), `k ambiguous`, `locations unavailable`, `k outside the map`, `k without
a usable value (a missing, b infinite, c out of range)`.

### 4.12 Geomap states (part E step 1b; T24-095), on entry

| State | Map | List | Table | Facts | Meter | Focus target | Announce |
|---|---|---|---|---|---|---|---|
| loading | status, "Loading…" at 300 ms | none | disabled | null | `loading` | the status (at once) | — |
| error | "Couldn't load data" + Retry | none | disabled | null | `unavailable` | Retry | "Couldn't load data" |
| invalid | "Invalid map data (‹detail›)" | none | disabled | null | `unavailable` | the status | the text |
| mapDataUnavailable | "Map data unavailable" + Show table | none | every row | T24-094 | the parts | Show table | the text |
| tooSmall | "Too small to show a map: ‹N› series" + Show table | none | every row (or the header) | T24-094 | the parts | Show table | the text |
| empty | the basemap + "No series in this window" | `<p tabIndex=-1>` | the header | null | `100 %` | the `<p>` | the text |
| noneShown | the basemap + "No series could be placed: ‹parts›" + Show table | the `<p>` | every row | T24-094 | the parts | the `<p>` | the text |
| ok | the marks | T24-093 | every row | T24-094 | the parts or `100 %` | the first item (or the placeholder) | "‹n› marks" |
| refetch ok / failed | new / kept | repaired / kept | new / kept | new / kept | new / `… · stale (HH:mm:ss)` | repaired / the same | the removal / "Couldn't refresh" |

Show table focuses the first row toggle (else the header). When loading ends before 300 ms, focus
goes straight to the new target.

### 4.13 Geomap Inspector targets (part E step 1b; T24-092, [T25](T25-inspector-and-pivots.md) §4.9)

Value statuses read No value, Infinite and Out of range; draw statuses read On the map, Not placed,
Outside the map, Not drawn: no usable value and Not drawn: cap.

| Kind | Header | Details | Members | Pivots |
|---|---|---|---|---|
| marker | the name; `geoPlace` or the location status; `formatValue` and the state | Value status; Location (4 dp); Source `‹key› ‹code›[ (‹provider›)]` (coordinates: `lat, lon`); Location detail; Group (`… (in other (n))`); Draw | — | T25 `mark` (the origin window), labels |
| cluster | `Cluster of n`; `near ‹seed place›` | Worst state; Values min – max | the rows (label chips) | — |
| aggregate | `other (n)`; `‹n› groups, ‹m› series` | — | the groups (label-map chips) | — |
| group | the group label; `‹m› series` | Worst state; Values min – max | the rows | — |

`announce` = `Inspector: ` + (at depth d > 0, `Level ‹d + 1›: `) + a marker `‹name›, ‹formatValue›[,
‹state›]` · a cluster `Cluster of ‹n›, near ‹seed place›[, worst ‹state›]` · the aggregate `other (n),
‹n› groups, ‹m› series` · a group `‹label›, ‹m› series[, worst ‹state›]` (T25-008).

### 4.14 Geomap table and CSV columns (part E step 1b; T24-094)

`name,key,value,value_status,state,location_status,location_detail,source,code,provider,place,lat,lon,group,group_member,draw_status`

- `place` = `geoPlace` (§5.16); `group` = the drawn group's label (`other (n)` for its members);
  `group_member` = the row's own group label when it is aggregated, else empty.
- `location_detail`: invalid → `‹reason› ‹key›`; unknownCode → `‹source› ‹key›=‹value›`;
  providerMismatch → `‹provider›: c1; c2`; ambiguous → `‹reason›: c1; c2`; else empty.

### 4.15 Map area results (part E step 2; T24-098)

With an effective area and the panel not a writer:

| Result | Filtering | Disclosure |
|---|---|---|
| series: PromQL, LogQL metric, log volume | each by `areaDecision` | the meter parts; 0 kept → the T24-098 empty state |
| histogram buckets (heatmap, histogram) | each bucket series, before binning | as above (series counts) |
| baseline series | its primary's decision (same key); no primary → its own labels | counted once, by the primary |
| geomap consumer, any state with rows | the series before `geoRowSet` | the meter; table, CSV: the kept rows |
| scalar, string | no | the notice "Map area not applied (no series)" |
| log lines, traces, profiles | no | the notice "Map area not applied to ‹log lines \| traces \| profiles› yet" |
| widgets, text, Explore | — | — |

### 4.16 Writer per state (part E step 2; T24-096, T24-097)

| State | Commit, write, follow | Start |
|---|---|---|
| `loading`, `error`, `invalid`, `mapDataUnavailable`, `tooSmall` (no frame) | none | at its input view when its frame builds |
| `empty`, `noneShown`, `ok` | commits write; it follows | — |

### 4.17 Sync and saved views (part E step 2; T24-097)

`*` always wins for synced maps.

| Event | URL | Maps |
|---|---|---|
| a commit by a synced map | `*` (push) | all synced maps follow |
| a board save changing a synced map's `options.view` | `*` kept | the URL has `*`: it stays at `*`; no `*`: it applies the saved view at once (null: fit) |
| a board save changing an unsynced map's `options.view` | its entry removed (replace) | it moves to the saved view (null: fit) |
| sync turned off | two updates, in order: (1) if `*` stops being a writer and `geo=`'s scope is `*`, `withArea('*', null)` (a removal, always written); (2) its entry := the frame's displayed camera (`FrameSummary.geo.view`, a fitted view included; no frame: `*` if present, else nothing), replace, `kind: 'map'`; refused → `lastView` := that camera, with the notice | it stays where it was and no longer refits on new data |
| sync turned on | its own entry removed (replace) | it adopts `*`, else its saved view |

### 4.18 Board URL store, budget and reads (part E step 2; T24-096)

One `BoardUrlStore` (§5.17, a provider per board page) is the only board URL writer. Its writers:
time (dispatch and init), `useBoardParams` (variables, filters, sections), map commits and the area
chip. Copy link reads `latest()`. `fitsUrlBudget` is unchanged; `map=` and `geo=` count as ordinary
pairs.
- **Update:** next = f(`latest()`); null or encoded-equal → `'unchanged'`. A removal (it only
  removes pairs) is always written. Otherwise, if `!fitsUrlBudget(next)`, `evictMaps` removes `map=`
  entries one at a time (panel scopes last-first in layout order, then `*`, never the scope being
  written; then `geo=` only if it is not effective) until it fits. `'map'`: still over →
  `'url.tooLong'`, nothing written. `'other'`: today's behaviour on that next (`check`; time writes
  have none), so there is no new failure. `'timeInit'` (the first-open `boardTimeInit`, the one
  exception): only `from`/`to` (replace), no eviction or removal and no budget check; it opens the
  time gate.
- **Queue:** a written update sets `latest()` := next at once and is enqueued (FIFO) with the tag
  `{ boardUrl: id, seq }` (seq increasing). The data router's `navigate(…, { replace: !push, state:
  tag })` runs only after the previous one's promise resolves (one entry per push). A tagged location
  older than the newest seq is ignored (`latest()` never rolls back); the current seq's echo is
  skipped.
- **External navigation** (POP, an untagged PUSH or REPLACE, a route change, unmount) cancels the
  queue: pending and in-flight writes are dropped (a late completion is ignored by its stale seq) and
  `latest()` := the external location. A route change and unmount dispose the store, so nothing
  navigates afterwards.
- **Eviction:** an evicted scope keeps its camera with the notice "Link too long — map changes not
  saved in the link" (T24-096).
- **Reads:** every location change applies the URL's full map state (present and absent entries),
  except the store's immediate echo (a non-POP location with the current tag): a load, a POP
  (tagged or not) and an untagged link all apply.

### 4.19 Geomap import (part E step 2; VIZ-060; `type: 'geomap'` → `geomap`; #158, #17)

**Precedence:**
0. Each object's mode is decided first, after the field fallbacks (size: a series value field →
   value, else fixed; symbol: `mode`; color: `field` non-empty → field, else fixed; text: `mode` or
   inferred). The selector itself (`size.field`, `symbol.mode`, `color.field`, `text.mode`) is
   validated by (3) and, if malformed, treated as absent.
1. Members the mode does not use (size fixed mode: `min`, `max`; value mode: `fixed`; color field
   mode: `fixed`), and fields meaningful only in another mode or view, are ignored silently, even
   when malformed.
2. A required location field (below) absent, empty, not a string or not a label key → only
   "Location fields missing (‹path›)".
3. A wrong JSON type or a non-finite number → the stated default and "Option ‹path› malformed:
   default used".
4. The row's own notes.

Absent → the stated default, silently. A **series value field** matches `^Value( #.+)?$`; a
**series name field** is `name`, `Name` or `Series`. Output defaults not listed: `cluster: false`,
`reducer: last`, `groupBy: null`, `colour: group`.

| Source (shape; absent → default) | Pulsus | Validation and notes |
|---|---|---|
| `options`, `view`, `controls`, `tooltip`, `layers[i].location`, `.config`, `.config.style`, `.style.*` (objects) | — | not an object → its whole subtree defaults, one malformed note |
| `view.id` (string; `zero`) | `fit` → `view` null; `zero` → (0, 0, zoom); `coords` → (lat, lon, zoom); north-america 40, −100, 4 · south-america −20, −60, 3 · europe 46, 14, 4 · africa 0, 30, 3 · west-asia 26, 53, 4 · s-asia 19.5, 80, 4 · se-asia 10, 106, 4 · e-asia 33, 120, 4 · australia −25, 135, 4 · oceania −10, −140, 3 | other string → null, "View ‹id› not mapped: fit used" |
| `view.lat`, `view.lon` (numbers; 0, coords only) | lat, lon | \|lat\| > 85.0511 → ±85.0511, "Latitude ‹v› clamped to ‹c›"; lon ∉ [−180, 180) → `lonNorm`, "Longitude ‹v› normalised to ‹n›" (no note for 180 → −180) |
| `view.zoom` (number; 1; zero and coords only) | zoom | < 0 → 0, > 14 → 14, "Zoom ‹z› clamped to ‹c›" |
| `view.shared`, `view.dashboardVariable` (bools; false) | `sync`, `boundsFilter` | `dashboardVariable` true → "View bounds go to the map area filter, not variable ‹name›" (`dashboardVariableName` a string, else "…filter, not a variable") |
| `controls.mouseWheelZoom` (bool; true) | `wheelZoom` | — |
| `tooltip.mode` (`details`; `none`) | — | `none` → "Tooltips are always shown"; other → malformed |
| `basemap` (any) | the offline basemap | present → "Basemap replaced by the built-in offline map" |
| `layers` (array; []) | the first `markers` layer; none → the source default layer (all its defaults below) | a non-object element or a non-string `type` → "Layer ‹i› malformed: skipped"; another type → "Layer ‹type› not mapped yet"; a 2nd markers layer → "Only the first markers layer kept" |
| `location.mode` (`auto`; `coords`, `geohash`, `lookup`) | `{mode: 'auto'}` / `{coords, lat: latitude, lon: longitude}` / `{geohash, field: geohash}` / `{lookup, field: lookup, gazetteer}` | other → auto, "Location mode ‹m› not mapped: auto-detected"; required: `latitude` then `longitude` / `geohash` / `lookup`, each matching `^[A-Za-z_][A-Za-z0-9_.]{0,99}$`; the first failing → auto, "Location fields missing (‹path›)" |
| `location.gazetteer` (string; countries) | `…/countries.json` → `country`; `…/usa-states.json` → `region`, `country: 'US'`; `…/airports.geojson` → `iata` | other → auto, "Gazetteer ‹basename› not available: auto-detected" |
| `style.size` `{fixed: 5, min: 2, max: 15, field: ''}` (numbers, string) | a series value field → `{by: 'value', min, max}`; else `{by: 'fixed', min: f, max: f}` | another field → fixed, "size field ‹f› not mapped; using fixed size ‹fixed›"; min > max → swapped, "Size limits reversed: swapped"; then each into 2–40 (max ≥ min), "Size ‹a›–‹b› clamped to ‹c›–‹d›" (fixed: "Size ‹f› clamped to ‹c›") |
| `style.symbol` `{mode: 'fixed', fixed: 'img/icons/marker/circle.svg'}` (strings) | basename `circle` / `square` / `triangle` → that | `mode` ≠ `fixed` → circle, "Symbol mode ‹v› not supported; using circle"; another basename → circle, "Symbol ‹name› not mapped: circle used" |
| `style.color` `{fixed: '', field: ''}` (strings) | a series value field → `state` iff `hasThresholds`, else `group`; else `group` | a series value field without thresholds → "colour field ‹f› not mapped without thresholds; using group colours"; another field → "colour field ‹f› not mapped; using group colours"; `fixed` only → "Fixed colour not kept: colours follow groups" |
| `style.text` `{mode: inferred, fixed: '', field: ''}` (strings; mode `fixed`, `field`; absent → `field` if non-empty, else `fixed` if non-empty, else none) | none → `labels: 'none'`; else `auto` | a `field` other than a series name field → "text field ‹f› not mapped; using series names"; `fixed` → "Fixed label text not kept: labels show series names"; another mode → "Text mode ‹v› not supported; using series names" |
| `config.showLegend` (bool; true) | — | false → "The legend shows with 2 or more groups" |
| any other present key | — | "Option ‹path› not mapped" (last, sorted) |

**Notes** come in source order: view → controls → tooltip → basemap → layers (per layer: type,
location, size, symbol, color, text, showLegend); then every "Option ‹path› not mapped", sorted by
path (UTF-16). Paths read `view.lat`, `layers[0].config.style.size.min`. Text values in notes have
their Cc characters removed and are cut to 40 code points.

## 5. Interfaces

### 5.0 Board spec version order

Each change below takes the **next free** board spec version when it is coded, with an upcaster
from the immediately preceding version (the identity unless noted; [T11-016](T11-postgres-schema.md#t11-016--document-upcasters-are-golden-tested)).
This document names the versions by their change; the numbers in the last column hold only if the
changes land in the order of the table. A fixture is named `v‹N›-‹change›.json` with its real
number, and a gate ID keeps the label it was given (`unit:board-spec-geomap-v8` is the map-sync
gate whatever its number).

| Name | Change | Issue | Number if landed in this order |
|---|---|---|---|
| tags version | `BoardSpec.tags` (§5.5) | #215 (I1), landed | v4 |
| widgets version | `query` optional, `text`, `clock` (§5.1) | #198 (A1) Part 1, landed | v5 |
| board-list version | `boardList` (§5.5) | #216 (I2) Part 1, landed | v6 |
| change-feed version | `changeFeed` (§5.8) | part B2 | the next free (v8 or later) |
| geomap version | `geomap` (§5.15) | part E step 1b (#234 Part 1), landed | v7 |
| map-sync version | `sync`, `boundsFilter`, `legacyAuto` (§5.15) | part E step 2 | the next free (v8 or later) |
| units version | `vis.unit` ([T22](T22-value-categorical-and-table-panels.md) §6.2) | #290 | the next free (v8 or later) |

An older server refuses a head saved at a newer version (`ErrSchemaTooNew`).

### 5.1 Board spec: the widgets version (OpenAPI, Go, TS)

`query` becomes optional; `Vis.kind` adds `text` and `clock`; `Vis.options` (#173) gains the keys
below (errors are `board.options.‹…›`):

| Key | Type / bounds | Default | Kinds | Error |
|---|---|---|---|---|
| mode | `markdown`\|`code` | `markdown` | text | `mode.invalid` |
| content | string ≤ 65 536 UTF-8 bytes | `''` | text | `content.tooLong` |
| language | `plaintext`\|`json`\|`yaml`\|`sql`\|`promql`\|`logql`\|`go`\|`shell` | `plaintext` | text, code mode only | `language.invalid` |
| zones | 1–12 × `{tz, label ≤ 64}`; `tz` `''` or a zone name (below), not `Local`; no two items with the same `tz` (`zones.duplicate`) | `[{tz:'',label:''}]` | clock | `zones.invalid`, `zones.duplicate` |
| hourCycle | `auto`\|`h12`\|`h23` | `auto` | clock | `hourCycle.invalid` |
| seconds, date | bool | `false`, `true` | clock | — |
| countdown | absent or `{to: RFC 3339 with offset, label 1–64, after: 'countUp'\|'hide'}`; `to` is `YYYY-MM-DDThh:mm:ss`, an optional fraction of 1–9 digits and `Z` or `±hh:mm`, naming a real time (month 1–12, day 1 to the month's length, hour ≤ 23, minute and second ≤ 59, offset ≤ 23:59) | absent | clock | `countdown.invalid` |

`language` is valid only in code mode (`mode` `code`; absent is `markdown`). A widget has neither
`thresholds` nor `legend`: each is `board.json.unknownKey`, reported by the rules pass (the shape
pass cannot know a `kind` that comes later). A `query` on a widget is reported at `…/query`
without checking its members; a panel of an invalid kind without a query reports only its kind.

**Zones.** A `tz` is checked in two steps. Its form, on every read and write: `''`, or at most 64
bytes matching `^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$`, other than `Local`. Its existence, in
Go on writes only: on a create every `tz` must be a name of the build's zone set, the names in the
`zoneinfo.zip` of the toolchain that built the server (the file `time/tzdata` embeds), generated
into the source and checked against the toolchain by a test; on a save only a `tz` the stored head
does not hold must exist, so a zone already stored is kept even if a later tzdata drops it. A read
never checks existence: a stored zone is always readable. The set is fixed by the build and the
same on every replica; host zoneinfo and `ZONEINFO` are never read. The client checks the form only.

Go decides validity; the upcaster from the immediately preceding version (the tags version, v4) is the identity
([T11-016](T11-postgres-schema.md#t11-016--document-upcasters-are-golden-tested)); the fixtures are
`v5-widgets.json` and `invalid.json`.

`isWidgetPanel(p)` narrows `PanelSpec` and guards every `panel.query` read; `textOptions` and
`clockOptions` fill the defaults; `PanelFrame` branches first to `<WidgetBody>`.

### 5.2 Renderer (`client/src/security/sanitise/`)

```ts
// url.ts
export type UrlClass = { kind: 'local'; href: string; host: string } | { kind: 'external'; href: string; host: string }
  | { kind: 'mailto'; href: string } | { kind: 'rejected' };
export const URL_FORBIDDEN = /[\u0000- \u007F-\u009F\\]/;
export function classifyUrl(raw: string, appOrigin: string): UrlClass; // raw passes toWellFormed first
export function toWellFormed(s: string): string; // lone surrogates → U+FFFD (ES2023 has no String.prototype.toWellFormed)
// findIframes.ts
export interface IframeHit { readonly offset: number; readonly line: number; readonly src: string | null } // offset: UTF-16 start
export function findIframes(html: string): readonly IframeHit[];
// markdown.tsx
export type RenderPolicy = 'board' | 'ai';
export type RemovalKind = 'html' | 'iframe' | 'linkScheme' | 'image' | 'unresolved' | 'depth';
export interface Removal { readonly kind: RemovalKind; readonly line: number } // block start line
export function renderMarkdown(src: string, env: { vars: ReadonlyMap<string, string>; entity: string | null },
  opts: { policy: RenderPolicy; appOrigin: string; headingOffset?: number /* 3 */ }): { node: ReactNode; removals: readonly Removal[] };
export function renderCode(src: string, language: CodeLanguage): ReactNode;
export function logRemovals(panelId: string, removals: readonly Removal[]): void;
export function removalMessage(r: Removal): string; // t(`markdown.removal.${kind}`, {line})
export function sourceLines(src: string, start: number, end: number): string; // lines start..end, clamped, terminators kept
export const MAX_DEPTH = 32; // DOM depth below the root (§4.2)
```

Both options are required. `src`, every variable value and the entity pass `toWellFormed` before
anything else, so interpolation, `encodeURIComponent` and classification never see a lone surrogate.

**`findIframes`** returns the **union**, de-duplicated by start offset and sorted, of (a) the `iframe`
elements in the `parse5.parse` tree (template content included) and (b) the `iframe` start-tag tokens
from `parse5-sax-parser`; both with `sourceCodeLocationInfo`, spec attribute decoding and the first
duplicate `src` (or `null`). The tokens come from the package's `ParserFeedbackSimulator` (the
tokenizer driver `SAXParser` wraps) through the Vite alias `parse5-sax-parser/feedback` →
`dist/parser-feedback-simulator.js`, because `SAXParser` extends `Transform` from `node:stream`,
which browsers lack; `unit:find-iframes` checks that its tokens equal `SAXParser`'s and that the
file imports no `node:` module.

**Rule:** a destination is recovered if either the spec tree or the spec tokenizer sees an iframe start
tag. Each covers the other's gap (tree: `<select><iframe>`; SAX: `<select><title><select><iframe>`);
both keep the raw-text, RCDATA, comment and CDATA protection; over-counting only adds a link.

Dependencies ([ADR-0024](../adr/0024-markdown-runtime-dependencies.md)): `dependency-policy.json`
`runtimeAllowlist` += `commonmark`, `parse5`, `parse5-sax-parser`; `runtimeClosure.markdown` = those
plus `entities`, `mdurl`, `minimist`; pins `commonmark` 0.31.2, `parse5` 8.1.1 (moves from
devDependencies), `parse5-sax-parser` 8.0.1; `@types/commonmark` as a dev dependency.

### 5.2a Text view, registry and actions (`client/src/widgets/`, `pages/board/`; #198 Part 3a)

```ts
// widgets/text/TextBody.tsx (board route chunk; imports no sanitiser module, types aside)
export const loadTextMarkdown = () => import('./TextMarkdown');
export type RegionName = { labelledBy: string } | { label: string };
export const TextBody: MemoExoticComponent<(p: { panel: WidgetPanelSpec; name: RegionName;
  editing: boolean; context: 'board' | 'preview' }) => ReactElement>;
export function textVars(all: ReadonlyMap<string, string>, o: TextOptions): ReadonlyMap<string, string>;
// widgets/text/TextMarkdown.tsx: the one dynamic entry, the only importer of sanitise/markdown
export function TextContent(p: { panelId: string; options: TextOptions; vars: ReadonlyMap<string, string> }): ReactElement;
export function TextRemovals(p: { options: TextOptions; vars: ReadonlyMap<string, string> }): ReactElement | null;
// boards/spec.ts: checkBoardSpec of a one-panel probe board, the /vis errors relative to the panel
export function widgetVisErrors(panel: WidgetPanelSpec): FieldError[];
// widgets/text/textVis.ts: keeps original's stored representation (absent defaults stay absent)
export function textVis(o: TextOptions, original: WidgetPanelSpec['vis'] | undefined): WidgetPanelSpec['vis'];
// widgets/registry.tsx
export interface WidgetDef { kind: WidgetKind; label: MessageId; editTitle: MessageId;
  size: { w: number; h: number }; newVis(): WidgetPanelSpec['vis']; Editor: ComponentType<WidgetEditorBodyProps> }
export const WIDGETS: WidgetRegistry;                        // { defs: [TEXT_DEF, BOARD_LIST_DEF] }, menu order
// BOARD_LIST_DEF (#216 Part 2b): 4 × 8, newVis {kind: 'boardList'}, Editor BoardListEditorBody (§5.7)
// WidgetEditorBodyProps.onLocalInvalid?(message | null): a local text the body cannot write; the
// editor disables Done and the page refuses Save while one is reported (Text never calls it)
export const WidgetRegistryContext: Context<WidgetRegistry>; // default WIDGETS
// boards/editorState.ts
| { type: 'addWidget'; vis: WidgetPanelSpec['vis']; size: { w: number; h: number }; grid?: GridRef }
| { type: 'updateWidget'; id: string; patch: { title?: string; vis?: WidgetPanelSpec['vis'] } }
```

**States.** The body is one region in every state (T24-009), named by the frame's heading on a
board and "Preview: ‹title or Text›" in the editor. In order: `invalid` (`widgetVisErrors` ≠ [];
T24-014), `empty`, `loading`, `error` (the entry failed; no retry) and `content`. Options and
variables reach `TextContent` through `useDeferredValue` (M0). The tab stop is set while
`scrollHeight > clientHeight`, measured by one `ResizeObserver` on the region and its content and
after every commit that changes the state, the options or the variables (T24-017).

**Module rules.** No Markdown module (the five packages, `markdown.tsx`, `findIframes.ts`,
`TextMarkdown.tsx`) may be in the static closure of `index.html` or `BoardPage`; a missing root, a
dangling import, an unmapped chunk or a missing, static or empty entry also fails
([T05](T05-testing-and-performance.md) §7.1, `ci:dep-audit`). The entry's chunk is a lazy chunk of at
most 120 KB.

**Registry and actions.** "Add widget" (the toolbar and each section header) lists the registry's
defs and dispatches `addWidget(def.newVis(), def.size)`, which shares `addPanel`'s path (the panel
cap, the first free cell, a collapsed section opens) and selects the panel. A widget's menu has
Edit panel iff its kind has a def; the widget editor shows Title and the def's `Editor`, and
`updateWidget` applies only to a widget of the patch's kind. Both actions are edits (none while
saving). A test, or a later kind, provides another registry through the context.

### 5.3 Wall clock (`client/src/state/wallClock.ts`)

```ts
export interface WallClock { now(): number; subscribe(cb: () => void, due: (now: number) => number): () => void }
export function createWallClock(nowFn?: () => number, timers?: Timers, doc?: Pick<Document, 'hidden' | 'addEventListener'>): WallClock;
export const boundaryDue = (unitMs: number) => (now: number) => now - (now % unitMs) + unitMs;
export function countdownDue(toMs: number): (now: number) => number;
export function useWallClock(due: (now: number) => number): number;
```

### 5.4 Import conversion (`sanitise/importText.ts`, called by #158 and #17)

```ts
export type ImportNote = { kind: 'iframeToLink'; line: number; host: string } | { kind: 'iframeNoLink'; line: number }
  | { kind: 'htmlNotRendered'; count: number };
export function convertImportedText(content: string, mode: 'markdown' | 'code', appOrigin: string):
  | { ok: true; content: string; notes: readonly ImportNote[]; inserted: readonly { offset: number; text: string }[] }
  | { ok: false; reason: 'sizeLimit'; links: number };
export interface TextImportError { kind: 'textTooLargeForLinks'; panelIndex: number; sourceId?: number; links: number }
export function markdownLink(label: string, href: string): string; // [esc(label)](<href: & → &amp;, < > \ escaped>)
```

The conversion is **append-only** (VIZ-056 needs a link and a report). `mode: 'code'` → unchanged, with
no notes. Otherwise one parse:

1. `findIframes` runs on each `html_block` literal (line = block start + `line` − 1) and once per leaf
   block on its `html_inline` literals joined in order, so `<script>` + `'<iframe …>'` + `</script>`
   stays raw text (line = leaf start).
2. Each iframe with a `local` or `external` `src` gives `markdownLink('Open embedded page (‹host›)',
   href)` and `iframeToLink {line, host}`; otherwise `iframeNoLink {line}`. The notes are sorted by
   line, then `htmlNotRendered {count}`.
3. A top-level block's links (space-joined) are inserted at E, just after its last line's newline:
   `"\n" + links + "\n"`, plus `"\n"` before a non-blank next line, with a leading `"\n"` at EOF
   without a newline. Lines split on `\r\n`, `\n` or `\r`, as commonmark does; after a lone `\r` the
   inserted line ends are `\r`, since a `\n` there would join it as one CRLF and put the links
   inside the block. The iframe HTML stays (it is dropped at render). `inserted` is ascending by
   offset (a UTF-16 index in the input): removing the entries in that order, each at its offset,
   gives the input.
4. `markdownLink` escapes label punctuation; `<dest>` has `&` → `&amp;` and `<`, `>`, `\` escaped.
5. **Size:** if the result exceeds 65 536 UTF-8 bytes it returns `{ok: false, reason: 'sizeLimit',
   links: n}`. The importer omits that panel, imports the rest, and adds a `TextImportError`
   (`sourceId` if an integer): "Text panel #‹index› (id ‹id›) is too large to add embedded-page links
   (‹n› links). Shorten or split it in the source and import again." No content is copied; the source
   file is the copy.

### 5.5 Board spec: the tags and board-list versions (part B1; OpenAPI, Go, TS)

Part B1 adds two things to the board spec, each at the next free spec version when it is coded,
with an identity upcaster (T11-016):

- **Tags**, in I1 (#215), Go and the client's validator together: `BoardSpec` gains `tags`
  (T24-029). The tags version is the version after the current one when I1 is coded (v4: it landed
  before #198, whose widgets version is v5 if no other spec change lands first); the client accepts and keeps `tags` (no editor yet). Fixtures:
  `v‹N›-board-tags.json` and the tag rows of `invalid.json`, TS = Go.
- **`Vis.kind` `boardList`** with the options below, Go and TS, in I2 (#216) after #198 (a
  `boardList` panel has no `query`, and "query optional" is #198's version). Go decides validity;
  TS = Go on the fixtures `v‹N›-board-list.json` and `invalid.json`.

Other keys → `board.json.unknownKey`. Errors are `board.options.‹…›`.

| Key | Type / bounds | Default | Error |
|---|---|---|---|
| mode | `starred`\|`recent`\|`search`\|`tag` | `starred` | `mode.invalid` |
| query | string ≤ 100, no Cc (as `q`, §5.6), only with `search` | `''` | `query.invalid` |
| tag | `AnnotationTag`, required iff mode `tag` | absent | `tag.invalid` |
| limit | integer 1–50 | 10 | `limit.invalid` |
| sort | `default`\|`incidents` | `default` | `sort.invalid` |

`boardListOptions` fills the defaults. `isWidgetPanel` includes `boardList`, and `<WidgetBody>` (#198)
adds it (until I2 Part 2, a stored board list shows the widget's "not available yet" frame).

The rules, landed as v6 (#216 Part 1; Go `boardListOptions` after `widgetOptions`, TS the same). Keys
are checked in `OPTION_ORDER` (`sort`, `mode`, then `query`, `tag`, `limit` after `countdown`); `m` is
the mode, `starred` when absent; `board.string.nul` comes first. `sort` and `mode` are shared keys: each
kind has its own values, and the readers of the other kinds (`textOptions`, `barchartOptions`) guard
them (`isTextMode`, `isChartSort`) and fall back to their defaults.

| Key | Valid when | Else |
|---|---|---|
| `sort` | in `default`, `incidents` (kind `boardList`); in the chart sorts (other kinds) | `sort.invalid` |
| `mode` | in `starred`, `recent`, `search`, `tag` (`boardList`); `markdown`, `code` (`text`) | `mode.invalid`; then `query` and `tag` get only their own checks, not the mode ones |
| `query` present | ≤ 100 code points, no U+0000–001F or U+007F–009F (the gateway's `q` rule with no minimum), and `m` = `search` (`''` included) | `query.invalid` |
| `tag` present | `AnnotationTag`, and `m` = `tag` | `tag.invalid` |
| `tag` absent | `m` ≠ `tag` | `tag.invalid` at `…/tag` |
| `limit` present | a whole number (a JSON number; `1e1` is 10) from 1 to 50 | `limit.invalid`; a non-number is `board.json.type` |

As a widget, a `boardList` panel with a `query` is `board.panel.query.forbidden`, and `thresholds` or
`legend` is `board.json.unknownKey`. The v5 → v6 upcast is the identity.

### 5.6 BFF contract (part B1; spec first, [ADR-0015](../adr/0015-go-bff.md))

```yaml
/boards get: q { 1–100 chars, no Cc (U+0000–001F, U+007F–009F) } → 400 boards.q.invalid; tag { AnnotationTag } → 400 boards.tag.invalid
BoardList: + applied { q?, tag? } (required; what was applied), + tagsStale (required int ≥ 0)
BoardSummary: + tags (required, [AnnotationTag] ≤ 16, or null = stale)
BoardRefList: + applied {} (required), + truncated (required; starred reads 201, recent limit + 1)
BoardSpec: + tags (optional, ≤ 16, uniqueItems, AnnotationTag)
```

```go
type BoardFilter struct{ Q, Tag string } // core; "" = absent
// OrgTx (RLS): RepairBoardTags(ctx) (int64, error);
//   ListBoards(ctx, f) ([]BoardSummary, truncated bool, tagsStale int64, error);
//   ListStarred(ctx, user) and ListRecent(ctx, user, limit) ([]BoardRef, bool, error);
//   MoveBoardHead and InsertBoard take tags.
// Service.ListBoards: tx 1 repairs (an error or timeout is logged without content and never fails the
// list), then tx 2 lists; both on the read-write pool (T11 replicas serve only audit and import dry
// runs) and the request context (a cancel rolls back).
```

### 5.7 Client list modules (part B1; `api/Api.ts`, `widgets/lists/`, `widgets/boardList/`)

```ts
listBoards(tenant: string, signal?: AbortSignal, f?: { q?: string; tag?: string }): Promise<BoardPage>;
listStarred(tenant: string, signal?: AbortSignal): Promise<RefPage>;   // SidebarBoards reads .items
listRecent(tenant: string, signal?: AbortSignal, limit?: number): Promise<RefPage>;
export type BoardListMode = 'starred' | 'recent' | 'search' | 'tag';
export type BoardListItem = BoardSummary & { tags: readonly string[] | null };   // null: stale, or an old server
export interface BoardPage { items: BoardListItem[]; truncated: boolean;
  applied: { q?: string; tag?: string } | null; tagsStale: number }   // old server: applied null, tagsStale 0, tags null
export interface RefPage { items: BoardRef[]; truncated: boolean; applied: {} | null }   // applied null = old server (truncated false)
// HttpApi sends q only when non-empty and tag only when given; listRecent's limit defaults to RECENT_LIMIT.
// StubApi filters as the BFF and computes truncated before it cuts (boards > 1 000, starred > 200, recent > limit).
// widgets/lists/snapshot.ts (shared with part B2)
export interface ListSnapshot<R> { key: readonly unknown[]; rows: readonly R[]; coverage: Coverage; fetchedAtMs: number }
export function listCoverage(loaded: number, shown: number, truncated: boolean, staleAtMs: number | null,
  unknown?: Coverage['unknown']): Coverage;   // no `applied` → oldServer; else tagsStale > 0 → tagsStale
export function withStale<R>(s: ListSnapshot<R>, atMs: number): ListSnapshot<R>;   // a copy, coverage.staleAtMs = atMs
export function listSetSize(s: ListSnapshot<unknown>): number;   // −1 when truncated or unknown, else rows.length
export function csvCell(v: string): string;   // the T24-026 guard, then RFC 4180; defined in client/src/data/csv.ts (#173), re-exported here
// widgets/lists/focus.ts, widgets/lists/table.ts
export function repairActive(prevKey: string | null, prevIndex: number, keys: readonly string[]):
  { key: string | null; index: number; gone: boolean };
export interface ListTable { columns: readonly string[]; rows: readonly { key: string; cells: readonly string[] }[] }
export function listCsv(t: ListTable): string;   // header + rows, each cell csvCell, CRLF
// widgets/boardList/
export function boardListOptions(o?: VisOptions): BoardListOptions;  // { mode; query; tag: string | null; limit; sort }
export interface BoardRow { uid: string; title: string; display: string; tags: readonly string[] | null;
  updatedAt: string | null; current: boolean }
export function boardSnapshot(key: readonly unknown[], r: BoardPage | RefPage,
  o: { mode; q; tag; currentUid; shown; nowMs }): { snapshot: ListSnapshot<BoardRow>; notice: 'tagNeedsServer' | null };
// Starred and Recent rows: tags [] (CSV empty), updatedAt null. An old server: search filters the
// titles (ASCII-folded) with tags null, tag mode has no rows and the notice.
export function boardRowName(r: BoardRow): string;   // ‹display›[, this board]
export function rankingCaption(sort: 'default' | 'incidents', c: { investigations: boolean }): string | null;
export function boardListTable(s: ListSnapshot<BoardRow>): ListTable;   // title,uid,tags,updated_at
export function boardListFacts(title: string, mode: BoardListMode, s: ListSnapshot<BoardRow> | null): SummaryFacts | null;
// Part 2a: the view (widgets/boardList/source.ts, useBoardList.ts, BoardListBody.tsx, BoardListView.tsx)
export const RECENT_WIDGET_LIMIT = 50;
export function boardListKey(tenant: string, o: BoardListOptions, q: string): readonly unknown[];   // T24-021
export function boardListFetch(api: Api, tenant: string, o: BoardListOptions, q: string, signal: AbortSignal): Promise<BoardPage | RefPage>;
export type BoardListPhase = 'pending' | 'ok' | 'empty' | 'error';
export function useBoardList(i: { tenant; currentUid; title; options; q }): BoardListModel;
// { key, mode, q, tag, phase, snapshot (this key's; stale applied), notice, error: 'store' | 'generic' | null,
//   refreshFailed, shown, caption, facts, retry(), showMore(): first new index }
// BoardListBody: invalid → the T24-014 state; search → SearchBoardList, else FixedBoardList; both render
// BoardListCore (model, Shift+T, keys, announcements) → BoardListView. CAPABILITIES: app/capabilities.ts.
// Part 2b: the editor (widgets/boardList/boardListVis.ts, BoardListEditorBody.tsx; boards/tags.ts)
export function boardListVis(o: BoardListOptions, original: WidgetPanelSpec['vis'] | undefined): WidgetPanelSpec['vis'];
// the head's stored representation: mode, limit, sort when the head has the key or the value is not
// the default; query in search mode likewise; tag in tag mode when set; no options when none is written
export function BoardListEditorBody(p: WidgetEditorBodyProps): ReactElement;
// the preview (BoardListBody preview over useDebounced(panel, 250): inert, link-free, registers nothing),
// Show (SegmentedControl), Search text or Tag, Rows (1–50, whole numbers), Order (Select + the caption)
export function useDebounced<T>(value: T, ms: number): T;   // widgets/lists/
export function addTags(tags: readonly string[], input: string):
  { tags: readonly string[]; rest: string; problem: 'invalid' | 'duplicate' | 'full' | null };
export function tagError(fields: readonly FieldError[]): FieldError | null;   // the first at /tags or /tags/<i>
// widgets/lists/ (shared with part B2)
export function useSearchCommit(initial: string): { text; q; cc; setText(v): void; clear(): void };   // 250 ms, ≤ 100, Cc
export function useListKeys(i: { keys; listKey; names; fallback(): HTMLElement | null; onGone(name): void }): ListKeys;
// { activeKey, rowProps(key, index): { tabIndex, ref }, onListKeyDown(e), focusRow(index) }
export function useListAnnouncer(): { text: string; announce(s: string): void };   // ≤ 1 write per 2 s, latest wins
// client/src/import/boardList.ts
export function importBoardList(src: Readonly<Record<string, unknown>>): { options: BoardListOptions; notes: string[] };
```

### 5.8 Board spec: the change-feed version (part B2; OpenAPI, Go, TS)

The change-feed version is the next free version when it is coded (§5.0), with an identity upcaster from the immediately preceding version (T11-016); it depends on no other B1 version. `Vis.kind`
adds `changeFeed` with the options below. Go decides validity; TS = Go on the fixtures
`v‹N›-change-feed.json` and `invalid.json`. Other keys (`fieldConfig`, `thresholds`, `depth`, …) →
`board.json.unknownKey`. Errors are `board.options.‹key›.…`.

| Key | Type / bounds | Default | Error |
|---|---|---|---|
| kinds | 1–4 unique of `deploy`, `config`, `flag`, `annotation` | all four | `kinds.invalid`, `kinds.duplicate` |
| tags | 0–8 unique `AnnotationTag` | `[]` | `tags.invalid`, `tags.duplicate` |
| entityMode | `context`\|`all` | `context` | `entityMode.invalid` |
| orgWide | bool | `false` | `board.json.type` |
| showTags | bool | `true` | `board.json.type` |

`changeFeedOptions` fills the defaults; `isWidgetPanel` includes `changeFeed`, and `<WidgetBody>`
adds it.

### 5.9 Annotations contract (part B2; spec first, [ADR-0015](../adr/0015-go-bff.md))

Every path runs in `OrgTx` under RLS (T11-003) on the read-write pool. The identity is the amended
[T12-010](T12-entity-catalogue.md#t12-010--stable-identity-64-bit-wire-id): `EntityId` is the
XXH3-128 (`zeebo/xxh3`) of the canonical bytes of (binding, kind, identifying values), as a
lower-case UUID, and is also the `entityRef` of `e=`. The BFF canonicalises the submitted `attrs` by
the T12 §4.2 kind table, and stores and reads only the **canonical map** (T12 §4.5).

```yaml
AnnotationCreate: + entity? { binding: slug of a binding in the org, kind, attrs: { [attr]: string 1–256 } }
  # → 400 annotations.entity.invalid (canonicalisation, T12-010) / 400 annotations.entity.binding (unknown slug)
Annotation: + entity (required: { id: EntityId, binding: slug, kind, ident: (string | null)[] in schema order } | null)
/annotations get: + kind[] ≤ 4 (any-of) · tag[] ≤ 8 (all-of) · entity[] ≤ 16 EntityIds (any-of) · orgWide (only with entity)
  · beforeAt + beforeId (both or neither) → 400 annotations.‹param›.invalid
  # a repeated value, an upper-case id, a repeated orgWide / beforeAt / beforeId, or orgWide without entity → 400;
  # a missing cursor partner is reported on the missing one's pointer (beforeId alone → /beforeAt)
AnnotationList: + applied (required: { kinds?, tags?, entity?, orgWide?, before? }: what was applied)
  · next (required: { at, id } | null) · orgWideHidden (required: integer ≥ 0, or null when scoped)
all three routes: + 403 scope_denied: "data scope denied" (unset or uncompilable scope, no fields), or
  "outside your data scope" with one field: /entity annotations.entity.scope or /entity annotations.scope
```

`orgWideHidden` is a count of the organisation-wide rows in `base` that an entity filter without
`orgWide` excluded (0 with no entity filter); the statement always computes it, and the BFF sends
null when the scope is not full (where it is always 0, because `P` admits no organisation-wide row).

`limit` stays 1–500 (default 500). The list reads `limit + 1` rows: more than `limit` → the extra row
is trimmed, `next` = the last kept row's `(at, id)`, and `truncated` = `next ≠ null`.

**Data scope** ([T12-018](T12-entity-catalogue.md#t12-018--no-hidden-identifier-in-any-response),
T12 §4.15; fail closed). `core.DataScope.AnnotationScope() (full bool, clauses, err error)`. The
clauses are OR-ed. Each clause is **compiled per kind** of the T12 §4.2 kind table into `$scope` =
`[{k: kind, b: [binding id] (absent = any binding), a: {position: [allowed value]}}]`:
- `b: []` → 403 `scope_denied` at compile time; no SQL runs;
- an attribute key maps to the kind's position through any of its alternatives, under the position's
  canonical name (its first alternative): `k8s.cluster.name` is the cluster's second alternative
  (`k8s.cluster.uid`) and the pod's primary;
- keys on one position intersect their values; an empty intersection matches nothing;
- a key with no position in a kind drops the clause for that kind.

The SQL and `ScopeCovers` read only this compiled list. The predicate `P` = `$scope_full OR
(entity_key IS NOT NULL AND a clause matches the canonical map)`: **organisation-wide rows are
full-scope only**. An unset or uncompilable scope → 403 `scope_denied` before any statement. `P` is
inside each path's one statement:
- **list** (the feed and the markers): in `base` (§6), so no row outside `P` reaches the rows, the
  cursors, the counts or an export; `orgWideHidden` is null when scoped, and the toggle is hidden;
- **create**: `ScopeCovers` (= `P`) on the canonical map, or 403 `annotations.entity.scope`; a create
  without an entity needs full scope, or 403 `annotations.scope`;
- **delete**: `DELETE … WHERE org_id = $1 AND id = $2 AND P RETURNING …`; a hidden row and an absent
  row give the same 404, and the audit event is written only when a row is deleted.

There is no get or update route; the Inspector reads the loaded row. Text and tags are free content
and are never parsed (the T12-018 note). Until authentication (D12) every request has full scope.
CI posters keep sending `entity` unchanged.

### 5.10 Client change-feed modules (part B2; `api/Api.ts`, `state/contextSearch.ts`, `widgets/changeFeed/`)

```ts
// ContextSearch gains e: readonly string[] (URL `e=`, a comma list, at most 16; IA-026)
listAnnotations(tenant: string, w: { fromMs: number; toMs: number; limit?: number; kinds?: readonly EventKind[];
  tags?: readonly string[]; entities?: readonly string[]; orgWide?: boolean; before?: Cursor }, signal?: AbortSignal): Promise<ChangePage>;
export interface Cursor { at: number; id: string }
export interface ChangePage { items: Change[]; truncated: boolean; applied: object | null /* null = old server */;
  next: Cursor | null; orgWideHidden: number | null }
export interface Change extends Annotation { entity: { id: string; binding: string; kind: string; ident: (string | null)[] } | null }
export interface ChangeSnapshot extends ListSnapshot<Change> { next: Cursor | null; more: 'none' | 'more' | 'cap';
  pages: number; orgWideHidden: number | null; oldServer: boolean }
export function boardAnnotationsQuery(api: Api, tenant: string, w: TimeWindow): UseQueryOptions<ChangePage>;   // T24-030
export function firstPage(key: readonly unknown[], p: ChangePage, o: { fetchedAtMs: number }): ChangeSnapshot;
export function olderPage(s: ChangeSnapshot, p: ChangePage, cap?: number /* 2 000 */): ChangeSnapshot;   // T24-032
export function changeRelevance(c: Change, sel: Selection | null, loaded: ReadonlySet<string>): boolean | null;  // T24-035; null = no effect
export function changeTarget(c: Change): Extract<InspectorTarget, { type: 'change' }>;
// also: changeLabel(c, loaded) (T24-034 entity text), changeRowName(c) (T24-036), changeFeedTable(s),
// changeFeedFacts(title, s | null) (T24-037), changeFeedOptions(o) (§5.8), importChangeFeed(src) → { options; notes: string[] } (§4.8)
```

### 5.11 Geo resolver and loader (part E; `client/src/vis/geo/`)

`locate` is pure, and every field is `readonly`:

```ts
export type GeoSource = 'coords' | 'geohash' | 'country' | 'region' | 'iata' | 'cloud';
export interface GeoPlace { lat: number; lon: number; source: GeoSource; key: string /* raw label key */;
  code: string | null /* canonical; null for coords */; provider: string | null;
  name: string | null; cell: { dLat: number; dLon: number } | null /* geohash only */ }
export type LocationResult =
  | { status: 'placed'; place: GeoPlace } | { status: 'noLocation' } | { status: 'gazetteerUnavailable' }
  | { status: 'invalid'; reason: 'coords' | 'incompleteCoords' | 'geohash'; key: string }
  | { status: 'unknownCode'; source: GeoSource; key: string; value: string }
  | { status: 'providerMismatch'; key: string; provider: string /* lower-cased hint */; candidates: string[] }
  | { status: 'ambiguous'; reason: 'keyCollision' | 'aliasConflict' | 'sharedCode' | 'name' | 'providers' | 'regionOrCloud'; candidates: string[] };
export type LocationOption = { mode: 'auto' } | { mode: 'coords'; lat: string; lon: string } | { mode: 'geohash'; field: string }
  | { mode: 'lookup'; field: string; gazetteer: 'country' | 'region' | 'iata' | 'cloud'; country?: string /* [A-Z]{2}, region only */ };
export function locate(labels: Labels, o: LocationOption, g: Gazetteer | null): LocationResult;
export function decodeGeohash(h: string): { lat: number; lon: number; dLat: number; dLon: number } | null;
// decode.ts (type-only imports, so Node scripts load it), re-exported by assets.ts: whole-asset
// validation; null on any violation (T24-087); never throws
export function decodeBasemap(j: unknown): Basemap | null; export function decodeGazetteer(j: unknown): Gazetteer | null;
// assets.ts
export function geoLoader(get: (url: string, init: RequestInit) => Promise<Response>,
  urls: { readonly basemap: string; readonly gazetteer: string }): () => Promise<GeoData>;
export const loadGeoData: () => Promise<GeoData>; // geoLoader over fetch and urls.ts; one promise per page
// urls.ts: the assets imported with ?url
export const basemapUrl: string; export const gazetteerUrl: string;
```

```ts
// types.ts: coordinates are integers in hundredths of a degree; rings and polylines are absolute
// interleaved [x0, y0, x1, y1, …] (rings implicitly closed)
export interface BasemapCountry { a2: string; a3: string; name: string; polygons: readonly (readonly Int32Array[])[] } // [outer, ...holes]
export interface Basemap { countries: readonly BasemapCountry[]; coast: readonly Int32Array[]; border: readonly Int32Array[] }
export interface CountryRow { a2: string; a3: string; name: string; x: number; y: number }
export interface CodeRow { code: string; name: string; x: number; y: number }   // region; IATA (name = place)
export interface CloudRow { provider: string; id: string; place: string; x: number; y: number }
type Idx<R> = ReadonlyMap<string, readonly R[]>;                                 // values in file order
export interface Gazetteer { country: readonly CountryRow[]; region: readonly CodeRow[]; iata: readonly CodeRow[];
  cloud: readonly CloudRow[]; countryByA2: Idx<CountryRow>; countryByA3: Idx<CountryRow>;
  countryByName: Idx<CountryRow> /* NFC + toLowerCase */; regionByCode: Idx<CodeRow>; iataByCode: Idx<CodeRow>;
  cloudById: Idx<CloudRow> }
export interface GeoData { basemap: Basemap | null; gazetteer: Gazetteer | null }
// aliases.ts (no imports; E3b's hasGeoFields reads GEO_ALIAS_KEYS)
export function normKey(k: string): string;  // T24-080
export const LAT_ALIASES: readonly string[]; export const LON_ALIASES: readonly string[]; export const HINT_KEY = 'cloud_provider';
export type AutoKind = 'coords' | 'geohash' | 'cloud' | 'region' | 'country' | 'iata' | 'regionOrCloud';
export const GEO_AUTO_RULES: readonly { rule: 1|2|3|4|5|6|7; kind: AutoKind; aliases: readonly string[] }[]; // §4.10
export const GEO_ALIAS_KEYS: ReadonlySet<string>;  // every alias of rules 1–7 (not the hint)
```

`loadGeoData` makes two parallel GETs, shared by every later call on the page; a failed GET, a
response that is not JSON or an asset that does not validate nulls that asset only. The asset file
names are content-hashed by the build: `urls.ts` is the `geo-assets` input of the client build
(`vite.config.ts`), so both files are emitted and listed in the signed manifest before a route
imports the geo modules; its entry chunk stays out of the initial JS.

### 5.12 Asset formats (part E; `basemap.json`, `gazetteer.json`, version 1)

Coordinates are integers x = round(lon · 100) and y = round(lat · 100), rounded half away from zero,
always in the order (x, y). A **delta array** is `[x0, y0, dx1, dy1, …]`: the first pair absolute,
the rest differences, restarting for each ring and each polyline. Both files are compact UTF-8 JSON,
keys in the order listed (`v`, `q`, then the data members), with a trailing LF.

```text
basemap.json
{ "v": 1, "q": 100,
  "countries": [[a2, a3, nameEn, [polygon, …]], …]  a2 [A-Z]{2}|-99, a3 [A-Z]{3}|-99, name 1–100 chars; sorted (a3, nameEn)
  polygon = [outer, hole, …]   ring = delta array, implicitly closed, ≥ 3 distinct points, no repeated consecutive point
            outer counter-clockwise (signed area > 0), holes clockwise; each starts at its smallest (x, y);
            polygons sorted by (min x, min y) of the outer
  "coast": [polyline, …], "border": [polyline, …]   polyline = open delta array, ≥ 2 points }

gazetteer.json (rows may repeat a code: ambiguous at lookup, T24-084)
{ "v": 1, "q": 100,
  "country": [[a2 [A-Z]{2}, a3 [A-Z]{3}, nameEn, x, y], …]          sorted by (a2, a3, name)
  "region":  [[code [A-Z]{2}-[A-Z0-9]{1,3}, name, x, y], …]         sorted by (code, name)
  "iata":    [[code [A-Z]{3}, place, x, y], …]                      sorted by (code, place)
  "cloud":   [[provider [a-z][a-z0-9]{1,15}, id [a-z0-9-]{1,40}, place, x, y], …] sorted by (provider, id) }
```

Every name and place is 1–100 characters.

### 5.13 Build tool, cloud regions and sources (part E; `tools/geo/`)

`tools/geo/build.py SRC_DIR` uses only the Python standard library. It checks each source file's
SHA-256 against `tools/geo/sources.json`, then writes both assets, `report.txt` (the T24-086 drops)
and `manifest.json` (each asset's SHA-256 and the source digests it was built from). `--check`
rebuilds and compares byte for byte, exiting 1 on any difference. A PR that changes an asset attaches
the `--check` output; the procedure is in `docs/client/supply-chain.md`. The sources are never
committed and never downloaded by CI; `ci:geo-data` checks the committed assets against the manifest
and decodes them.

`tools/geo/cloud-regions.csv` is curated and tracked (AGPL-3.0), one record per region:

```text
provider,id,place,iso_a2,ne_id,source,retrieved
aws,eu-west-1,Dublin,IE,1159151309,AWS Regions - AWS Regions and Availability Zones,2026-11-26
gcp,europe-west1,St. Ghislain,BE,1159120321,Regions and zones - Compute Engine,2026-11-26
azure,westeurope,Amsterdam,NL,1159151519,List of Azure Regions - Microsoft Learn,2026-11-26
```

It covers every region on each provider's published public-cloud region list (`source`, the page's
title) on its `retrieved` date, azure restricted-access regions included; preview and announced
regions, the government, sovereign and China partitions, and ids not on the list are excluded and
listed in the docs. `place` is the published location; where that is only a country or a state, it
is a curated city, a Natural Earth populated place. `ne_id` is a Natural Earth populated place, which gives the latitude and longitude
(T24-085).

**Sources.** `tools/geo/sources.json` holds the dataset, version, file, SHA-256, licence and
retrieval date of each; it holds no download location. Its shape is `{ "v": 1, "sources": [{ class,
dataset, version, fileDate, file, sha256, licence, retrieved }, …] }`, sorted by `file`; the
tracked CSV has `sha256` null and is digested at build time. `manifest.json` is `{ "v": 1,
"assets": [{ file, sha256, bytes, sources }, …], "sources": { ‹file›: ‹sha256› } }`, and
`build.py --notices` prints the "Data" section: `== Data ==`, then one line per source.

| Class | Dataset, version (file date) | File · SHA-256 | Licence |
|---|---|---|---|
| Outlines | Natural Earth 110m Admin 0 Countries 5.1.1 (2022-05-09) | `ne_110m_admin_0_countries.zip` · `0f243aeac8ac6cf26f0417285b0bd33ac47f1b5bdb719fd3e0df37d03ea37110` | public domain |
| ISO 3166-1 | Natural Earth 10m Admin 0 Countries 5.1.1 (2022-05-09) | `ne_10m_admin_0_countries.zip` · `ce1ac7036499a0edd641fbc093cd209a98f96a49d2eca8480aaacad35138a7f6` | public domain |
| ISO 3166-2 | Natural Earth 10m Admin 1 States, Provinces 5.1.1 (2022-05-09) | `ne_10m_admin_1_states_provinces.zip` · `efc59726337323058f9446210adc96673179cd344e053666ee3d28cb58ba2b05` | public domain |
| Cloud metros | Natural Earth 10m Populated Places simple 5.1.2 (2022-05-13) | `ne_10m_populated_places_simple.zip` · `2963ee08f7743f13f37d5243acd77a2f7a510e26a36c7e04b920f1b381f2b251` | public domain |
| IATA | OurAirports `airports.csv`, snapshot 2026-11-25 | `airports.csv` · `ceba1cef67fb7ddeeb8aebf52cfca29d678f0599fd46cd93b8974f9a6a67ea16` | public domain |
| Cloud ids | `tools/geo/cloud-regions.csv` | in the repository | AGPL-3.0 (facts, each record dated) |

**Notices.** No source requires a notice. `build/THIRD_PARTY_NOTICES.txt` gains a "Data" section
that names each dataset and its version (`make go-licenses` appends `build.py --notices`).

### 5.14 Geomap seam and host (part E step 1b; `engine/api.ts`, `charts/`, `vis/geo/plan.ts`)

The seam additions are [ADR-0027](../adr/0027-geomap-frame-seam.md)'s, verbatim (every field
`readonly`): `VisKind` `'geomap'`, `GeoView`, `GeoBounds`, `GeoMapSpec`, the `geo` `FrameData` and
`HoverItem` members, `GeoCommitEvent`, `GeoBrushEvent`, `GeoMarksEvent`, `setFocusMark`, `cameraKey`
and `FrameSummary.geo`. The marks use two more tokens (`design/tokens.toml`, T24-090):
`pattern-ink` (pattern strokes over a fill) dark `#0B0D10A6`, light `#FFFFFFB3`, and `category-other`
(the aggregate's fill, [T21-003](T21-time-and-distribution-panels.md#t21-003--encoded-twice),
[T22-004](T22-value-categorical-and-table-panels.md#t22-004--colour-and-identity)) dark `#8A919C`,
light `#6B7280`. The host and the plan:

```ts
export interface GeoMapFrameProps { panelId: string; title: string; unit: Unit; options: GeomapOptions;
  thresholds: Thresholds | null /* the panel's; the spec gets their lines */; run: PanelRun;
  geoData: { basemap: Basemap | null; gazetteer: Gazetteer | null } | 'loading';
  fill?: boolean; sizeMemo?: { current: FrameSize | null }; onInspect?: ChartFrameProps['onInspect'] }
// The component's props: geoData optional (absent: the shared loadGeoData()); inspectorSource?: boolean (default
//   true; the editor preview passes false: it never inspects or selects); onLoadFailed?(): the map renderer could not load.
// ChartFrameProps += onSummary?(s: FrameSummary): each a11y summary, after the frame's own state.
// The producer contract (Canvas 2D): when the scene import rejects and the load's generation still matches, the frame is not
//   disposed and its kind is still geomap, the frame emits exactly one a11y summary {kind: 'geomap', geo: null, …} (no drawn);
//   otherwise nothing. GeoMapFrame calls onLoadFailed() for a geomap summary with geo null.
// GeoMapBody (pages/board/): the lazy host inside a panel-local error boundary keyed by an attempt count. A host-chunk
//   rejection or onLoadFailed shows one state: attempt 0 "Map couldn't load" + Retry (attempt + 1: a fresh lazy, boundary
//   and frame, so both imports run again; no cache-busting URL); attempt ≥ 1 "Map couldn't load. Reload the page to try
//   again." + Reload (location.reload()). Focused when focus was in the panel; other panels stay usable.
// ChartFrameProps += onFrame?(f: EngineFrame | null) (null before dispose), surface?: 'chart' | 'geo'. With 'geo': no crosshair
//   and no label targets; the canvas wrapper is the plot surface (tabIndex 0, role="application", aria-roledescription="map",
//   aria-label = the title) and the key target; its keys call frame.cameraKey (T24-091)
// ChartFrame owns `select` and `hover`. targetOf: item.kind 'geo' → { type: 'geo', target: geoTarget(rows, data.geo.seq,
//   { kind: id starts 'cluster:' ? 'cluster' : 'marker', id, keys: item.keys }) } (§5.16); selectionOf → { keys: the target
//   rows' keys, fromMs: null, toMs: null }
// geoTooltip: a marker "‹name›\n‹value› · ‹state›\n‹geoPlace›"; a cluster "Cluster of ‹n›\nworst ‹state›\n‹5 names, seed
//   order›[, +k more]" (the state parts only with thresholds)
// vis/framePlan.ts: 'geomap' → { kind: 'geomap' } → PanelFrame renders <GeoMapFrame>
export type GeoPlan = // vis/geo/plan.ts
  | { state: 'loading' | 'error'; rows: GeoRowSet | null }
  | { state: 'invalid'; issue: FrameDataIssue }
  | { state: 'mapDataUnavailable' | 'tooSmall'; rows: GeoRowSet }   // validated (T24-088)
  | { state: 'empty' | 'noneShown' | 'ok'; rows: GeoRowSet; spec: GeoMapSpec; data: { kind: 'geo'; geo: GeoFrame } };
export function planGeo(p: GeoMapFrameProps, size: FrameSize, view: GeoView | null /* T24-088 */,
  o: { seq: number; motion: 'ease' | 'cut'; staleAtMs?: number | null /* a kept refetch failure, first seen */ }): GeoPlan;
```

### 5.15 Geomap rows and the geomap spec version (part E step 1b; `vis/geo/frame.ts`, OpenAPI, Go, TS)

`vis/geo/frame.ts` is pure:

```ts
export type ValueStatus = 'ok' | 'noValue' | 'infinite' | 'outOfRange'; // T21-012
export type DrawStatus = 'shown' | 'notPlaced' | 'outsideMap' | 'excluded' | 'capped'; // zoom-independent
export interface GeoRow { key: string; labels: Labels; name: string; value: number; valueStatus: ValueStatus;
  state: State | null; location: LocationResult /* §5.11 */; draw: DrawStatus; group: number; groupId: GroupId }
export type GroupId = { series: string } | { present: true; value: string } | { present: false } | { other: true }
export interface GeoGroup { id: GroupId; label: string; pattern: string; colourIndex: number | null; members: GroupId[] | null;
  memberLabels: string[] | null /* parallel to members: their final labels */ }
export interface GeoRowSet { rows: readonly GeoRow[] /* by key */; groups: readonly GeoGroup[]; coverage: Coverage;
  groupBy: string | null /* the groupBy label key */ }
export interface GeoFrame extends GeoRowSet { seq: number; shown: Uint32Array; basemap: Basemap }
// T22 Coverage += geo?: Record<'notPlaced' | 'ambiguous' | 'locationsUnavailable' | 'outsideMap' | 'noValue' | 'infinite' | 'outOfRange', number>
export function geoRowSet(series: readonly SeriesFrame[], source: 'instant' | 'range', o: GeomapOptions,
  th: Thresholds | null /* the panel's, with their direction */, g: Gazetteer | null, q: Completeness): GeoRowSet;
export function validateGeoRows(s: GeoRowSet, th: Thresholds | null): FrameDataIssue | null; // `state` against th
export function geoFrame(s: GeoRowSet, b: Basemap, seq: number): GeoFrame;
```

**The geomap version** of the board spec is the next free version when it is coded (§5.0), with an identity upcaster from the immediately preceding version (T11-016); it depends on no widget or list version.
`Vis.kind` adds `geomap` with the options below. Go decides validity; TS = Go on the fixtures
`v‹N›-geomap.json` and `invalid.json`. Errors are `board.options.‹key›.invalid` unless noted.
`depth`, `tilt`, `projection`, `perspective`, `shadow` and `3d` → `board.json.unknownKey`
([T22-002](T22-value-categorical-and-table-panels.md#t22-002--no-depth-options-on-2d-kinds)). A save
to an older server → 400, shown as "This server does not support map panels yet"; old binaries
cannot move a head saved at the geomap version or later (`ErrSchemaTooNew`,
[T11-015](T11-postgres-schema.md#t11-015--migration-runner-and-compatibility-window)).

| Key | Type / bounds | Default | Error |
|---|---|---|---|
| location | the 1a `LocationOption` (§5.11) | `{mode: 'auto'}` | `location.invalid` |
| reducer | T22 `Reducer` | `last` | `reducer.invalid` |
| size | `{by: 'value'\|'fixed', min 2–40, max min–40}` | `{by: 'value', min: 4, max: 20}` | `size.invalid` |
| colour | `group`\|`state` (`state` needs thresholds) | `group` | `colour.invalid` |
| groupBy | a label key \| null (null and absent are one stored value) | null | `groupBy.invalid` |
| symbol | `circle`\|`square`\|`triangle`\|`diamond` | `circle` | `symbol.invalid` |
| labels | `auto`\|`none` | `auto` | `labels.invalid` |
| cluster, wheelZoom | bool | `true` | `board.json.type` |
| view | null \| `GeoView` (ADR-0027 bounds; null and absent are one stored value) | null | `view.invalid` |

**The map-sync version** (part E step 2) is the next free version when it is coded, and depends on the geomap version (it extends the geomap options; §5.0, T11-016). Go decides validity;
TS = Go on the fixture `v‹N›-geomap-sync.json`. The geomap options gain:

| Key | Type / bounds | Default | Error |
|---|---|---|---|
| sync | bool | `false` | `board.json.type` |
| boundsFilter | bool | `false` | `board.json.type` |

`Vis` gains `legacyAuto?: true`, valid only with `kind: 'auto'` (else `board.vis.legacyAuto.invalid`;
its use is T24-099). Its upcaster from the immediately preceding version (whichever that is) sets `legacyAuto: true` on every `auto` panel and changes
nothing else. A map-sync save to an older server → 400, shown as "This server does not support map sync yet"
(`ErrSchemaTooNew`, as for the geomap version).

### 5.16 Geomap targets, mark list and rows (part E step 1b; `vis/geo/targets.ts`, `charts/geo/`, `vis/geo/rows.ts`)

```ts
// vis/geo/targets.ts: every geo Inspector target comes from geoTarget
export interface GeoMemberEntry { text: string; labels: Labels; keys: readonly string[] }
export interface GeoInspectorTarget { kind: 'marker' | 'cluster' | 'aggregate' | 'group'; id: string; frameSeq: number;
  title: string; rows: readonly GeoRow[] /* a snapshot, key order */; members: readonly GeoMemberEntry[] | null /* marker: null */;
  set: GeoRowSet /* the row set it was built from; group targets and later views read only this */ }
export function geoTarget(s: GeoRowSet, frameSeq: number, ref: { kind: 'marker' | 'cluster'; id: string; keys: readonly string[] }
  | { kind: 'aggregate' } | { kind: 'group'; from: GeoInspectorTarget; entry: number }): GeoInspectorTarget;
//   cluster, group: one entry per row {text: its name, labels, keys: [key]}; aggregate (id 'other:geo'): one entry per group
//   {text: its final label, labels: {[L]: value} | {} (absent) | the series labels (no groupBy), keys: its rows};
//   group: id 'group:' + JSON.stringify(GroupId), built from `from`'s snapshot only. selectionOf = {keys: the rows' keys, null, null}
// T25 MemberSection = { texts: { shown: the texts of entries 0–7, count: n, labels: their label maps }, runs: null,
//   resolve: n > 8 ? { panelId, runId: 'geo:' + target.id } : null,
//   next: i → { target: cluster or group → the marker of rows[i]; aggregate → geoTarget({kind: 'group', from, entry: i}),
//     selection: its keys, title } }
// The host answers 'geo:' + id from the open request's top view (T25 §4.8: the last pushed view, else the root target),
//   when it is a geo target of the asking panel: resolveGeoMembers(top, runId) → { texts: all n, members: [], labels: all n },
//   else null (stale); pure, from the snapshot. No GeoMapFrame registers a resolver, so a board panel, its full screen
//   and the editor preview answer alike in any mount order (#234 Parts 3 and 4)
export function geoPlace(r: GeoRow): string; // the gazetteer name, else lat, lon toFixed(4); '' if not placed
// charts/geo/GeoMarkList.tsx
export interface GeoMarkListProps { title: string; marks: GeoMarksEvent['marks']; rows: ReadonlyMap<string, GeoRow>; unit: Unit;
  complete: boolean /* the meter reads '100 %' */; selection: Selection | null; frame: EngineFrame | null;
  seq: number /* a new one is a refetch */; rowSet: GeoRowSet; onInspect(t: GeoInspectorTarget, f: HTMLElement): void;
  onActive(id: string | null): void /* → setFocusMark */; announce(text: string): void }
export function geoMarkName(m: GeoMarksEvent['marks'][number], rows: GeoMarkListProps['rows'], unit: Unit, sel: Selection | null,
  thresholds: boolean): string;
// charts/PanelTable.tsx += toggle?: { label(key): string /* "Select ‹name›" */; onToggle(key): void } (a leading 24 px
//   aria-pressed button, T25-016); onInspectRow?(key, el) (an Inspect button per row); rowNote?(key): string | null (a
//   visible note on a selected row, "Not placed")
// vis/geo/rows.ts
export function geoTable(s: GeoRowSet, unit: Unit): PanelRows; export function geoCsv(s: GeoRowSet, unit: Unit): string;
export function geoFacts(title: string, s: GeoRowSet, series: readonly SeriesFrame[], instant: boolean, unit: Unit): SummaryFacts | null;
// csvCell (T24-026, amended): exempt iff /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|Infinity)$/ (no m flag) matches and the
//   cell holds no \n, \r, U+0085, U+2028 or U+2029
```

### 5.17 Map URL state, map area, auto-vis row 8 and import (part E step 2; `state/`, `vis/geo/`, `vis/autovis.ts`, `import/geomap.ts`)

```ts
// state/boardUrl.ts — the one board URL writer (a provider per board page; §4.18)
export interface BoardUrlState { context: ContextSearch; rest: readonly SearchParamPair[] }
export interface BoardUrlStore {
  latest(): BoardUrlState; // advanced synchronously on enqueue and by external locations (load, POP, untagged)
  update(f: (s: BoardUrlState) => BoardUrlState | null, o: { push: boolean; kind: 'map' | 'other' | 'timeInit';
    check?: (s: BoardUrlState) => ParamError | null /* the caller's existing check, unchanged */ }): 'ok' | 'unchanged' | ParamError;
}

// state/mapParams.ts — pure codecs over rest pairs
export const MAP_PARAM = 'map', AREA_PARAM = 'geo', MAX_URL_MAPS = 8 /* unsynced, layout order */;
export interface MapParams { views: ReadonlyMap<string /* '*' | panel id */, GeoView>; area: { scope: string; bounds: GeoBounds } | null }
export function readMapParams(rest: readonly SearchParamPair[]): MapParams; // invalid pairs skipped; then the first valid per scope / geo wins
export function withMap(rest: readonly SearchParamPair[], scope: string, v: GeoView | null): SearchParamPair[];
export function withArea(rest: readonly SearchParamPair[], scope: string, b: GeoBounds | null): SearchParamPair[];
//   b → geo= encodeArea(scope, b) (replacing any geo=); null → geo= removed; canonical, sorted
export function encodeView(scope: string, v: GeoView): string;
//   `${scope}_${n(lat,5)}_${n(L,5)}_${n(zoom,3)}`: L = round5(lonNorm(lon)); L ≥ 180 → L − 360 (canonical after rounding)
export function encodeArea(scope: string, b: GeoBounds): string; // `${scope}_` + ⌊w⌋ ⌊s⌋ ⌈e⌉ ⌈n⌉ at 1e-4, clamped to ±180 / ±85.0511, '_'-joined, n(x, 4)
// n(x, d): x.toFixed(d), trailing zeros and a bare '.' removed, '-0' → '0'. Read: map
//   /^(\*|[a-z0-9-]{1,40})_(-?\d{1,3}(?:\.\d{1,5})?)_(-?\d{1,3}(?:\.\d{1,5})?)_(\d{1,2}(?:\.\d{1,3})?)$/, |lat| ≤ 85.0511,
//   −180 ≤ lon < 180, 0 ≤ zoom ≤ 14; geo the writer's scope then four /-?\d{1,3}(?:\.\d{1,4})?/, all by '_', −180 ≤ w < e ≤ 180, −85.0511 ≤ s < n ≤ 85.0511
export function evictMaps(s: BoardUrlState, order: readonly string[] /* scopes, layout order */, keep: string | null,
  areaEffective: boolean, fits: (s: BoardUrlState) => boolean): { state: BoardUrlState; evicted: string[] }; // the §4.18 order
export function areaChip(b: GeoBounds): string; // "Map area: 28.2°N–59.5°N, 31.0°W–59.0°E"

// vis/geo/area.ts — pure
export type AreaDecision = 'in' | 'outside' | 'unlocated' | 'unapplied';
export function areaDecision(labels: Labels, o: LocationOption, g: Gazetteer | null, b: GeoBounds): AreaDecision;
//   locate: placed → in iff w ≤ lon ≤ e and s ≤ lat ≤ n (geohash: the cell centre), else outside;
//   gazetteerUnavailable → unapplied (kept); any other status → unlocated (removed)
export interface AreaResult { series: readonly SeriesFrame[]; outside: number; unlocated: number; unapplied: number }
export function applyArea(series: readonly SeriesFrame[], b: GeoBounds, o: LocationOption, g: Gazetteer | null,
  primaryOf?: (s: SeriesFrame) => SeriesFrame | null /* baseline → its primary by key */): AreaResult;
// T22 Coverage += area?: { outside; unlocated; unapplied }; meter parts after the existing ones, zeros omitted:
//   `k outside the map area` · `k without a location` · `map area not applied to k (locations unavailable)`

// vis/geo/writers.ts
export function mapRoles(spec: BoardSpec): { local: Set<string>; writers: Set<string>; scopes: Map<string, string> };
//   local = unsynced geomaps after the 8th (layout order); writers = non-local with boundsFilter, plus every synced
//   geomap when a synced one has boundsFilter; scope = '*' if sync else the panel id

// vis/autovis.ts
export function hasGeoFields(series: readonly SeriesFrame[]): boolean;
//   N = series.length ≥ 2 and 2·h ≥ N, h = series with a §4.10 alias key (T24-080 normal form) whose value is non-empty
// autoVis input += geo: boolean; AutoVis.rule += 8; order: 5, 6, 7, 8, then the later rows
// panelRun: geo = !vis.legacyAuto && hasGeoFields(result series). streamView (LogQL panels): T24-099
// PanelEditor: draft = { ...panel, vis: withoutLegacyAuto(panel.vis) }; <PanelPreview panel={draft}> and its auto label use
//   panelView(run, draft.vis); the stored board panel is untouched until save. Save drops vis.legacyAuto.
// Explore: geo = false (no geomap kind there yet)

// import/geomap.ts
export function importGeomap(src: unknown /* the panel's `options` */, hasThresholds: boolean):
  { options: GeomapOptions /* map-sync version */; notes: string[] };   // §4.19
```

## 6. Data & storage

The widgets version of the board spec (§5.1) is stored as the board document is today; its upcaster from the immediately preceding version is the identity
(T11-016). There is no new table, route or storage: widgets fetch nothing and make only safe GETs
(links and `local` images).

**Part B1.** The tags version of the board spec (§5.5) is stored the same way, with an identity upcaster. Migration 4 adds
the `boards.tags` cache ([T11](T11-postgres-schema.md) §4.3); it is metadata-only and keeps the N+1
window (T11-012, T11-013). The repair and the list (T24-029) run as two transactions:

```sql
-- migrations/00004_board_tags.sql (lock_timeout 5s, statement_timeout 5min; metadata-only)
ALTER TABLE boards ADD COLUMN tags text[] NOT NULL DEFAULT '{}', ADD COLUMN tags_version bigint NOT NULL DEFAULT 0;
ALTER TABLE boards ADD CONSTRAINT boards_tags_max CHECK (cardinality(tags) <= 16) NOT VALID;
-- I4 (next release): ALTER TABLE boards VALIDATE CONSTRAINT boards_tags_max;

-- name: RepairBoardTags :execrows — tx 1, committed alone; SET LOCAL statement_timeout '2s', lock_timeout '500ms'
WITH s AS (SELECT id FROM boards WHERE org_id = $1 AND deleted_at IS NULL AND tags_version <> head_version
           ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED)          -- locked rows: no head move can interleave
UPDATE boards b SET tags = coalesce(ARRAY(SELECT jsonb_array_elements_text(v.spec->'tags')), '{}'), tags_version = b.head_version
FROM s, board_versions v WHERE b.org_id = $1 AND b.id = s.id AND v.org_id = $1 AND v.board_id = b.id AND v.version = b.head_version;

-- name: ListBoards :many — tx 2, ONE statement (one snapshot); always ≥ 1 row
WITH m AS (
  SELECT b.uid, b.title, b.tags, b.tags_version = b.head_version AS fresh, b.head_version, v.created_at, v.author_kind, v.author_id,
         (sqlc.arg(q)::text = '' OR strpos(lower(b.title COLLATE "C"), lower(sqlc.arg(q)::text COLLATE "C")) > 0
            OR (b.tags_version = b.head_version AND lower(sqlc.arg(q)::text COLLATE "C") = ANY (b.tags)))
     AND (sqlc.arg(tag)::text = '' OR (b.tags_version = b.head_version AND sqlc.arg(tag)::text = ANY (b.tags))) AS hit
  FROM boards b JOIN board_versions v ON v.org_id = b.org_id AND v.board_id = b.id AND v.version = b.head_version
  WHERE b.org_id = $1 AND b.deleted_at IS NULL),
st AS (SELECT count(*) FILTER (WHERE NOT fresh) AS tags_stale FROM m)   -- every stale row, returned or not
SELECT st.tags_stale, h.uid, h.title, CASE WHEN h.fresh THEN h.tags END AS tags, h.head_version, h.created_at, h.author_kind, h.author_id
FROM st LEFT JOIN LATERAL (SELECT * FROM m WHERE hit ORDER BY created_at DESC, uid LIMIT 1001) h ON true
ORDER BY h.created_at DESC NULLS LAST, h.uid;   -- the all-NULL sentinel exists only when nothing matched
-- uid NULL = no rows; > 1 000 rows = truncated. MoveBoardHead / InsertBoard: SET tags = $5, tags_version = <new head>.
-- ListStarred LIMIT 201; ListRecent LIMIT $3 + 1
```

`strpos` (not `LIKE`) means `%` and `_` in `q` are plain characters. `lower(… COLLATE "C")` folds ASCII
only, so `zürich` does not match `ZÜRICH`.

**Part B2.** The change-feed version (§5.8) is stored the same way, with an identity upcaster. Migration 5 adds
the annotation's canonical entity ([T11](T11-postgres-schema.md) §4.4). It is metadata-only, keeps the
N+1 window (T11-012, T11-013) and is numbered after #215's migration 4. Every path is **one
statement**:

```sql
-- migrations/00005_annotation_entity.sql (lock_timeout 5s; metadata-only)
ALTER TABLE annotations ADD COLUMN entity jsonb;
ALTER TABLE annotations ADD CONSTRAINT annotations_entity_pair
  CHECK ((entity_key IS NULL) = (entity IS NULL)) NOT VALID;   -- existing rows are all NULL/NULL; I7 validates it next release

-- name: ListAnnotations :many — ONE statement; always ≥ 1 row; $lim = limit + 1
WITH base AS (SELECT id, at, end_at, kind, text, tags, entity_key, entity FROM annotations a
  WHERE org_id = $1
    AND ($scope_full OR entity_key IS NOT NULL AND EXISTS (           -- the data scope P, fail closed
      SELECT 1 FROM jsonb_array_elements($scope) c
      WHERE c->>'k' = a.entity->>'kind'
        AND (c->'b' IS NULL OR c->'b' @> jsonb_build_array(a.entity->>'binding_id'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_each(c->'a') kv
                        WHERE NOT kv.value @> jsonb_build_array(a.entity->'attrs'->>kv.key))))
    AND at <= $to AND at >= $from - interval '31 days' AND coalesce(end_at, at) >= $from   -- the overlap set
    AND (cardinality($kinds::text[]) = 0 OR kind = ANY ($kinds)) AND tags @> $tags::text[]),
f AS (SELECT * FROM base
  WHERE cardinality($ents::text[]) = 0 OR entity_key = ANY ($ents) OR ($org_wide AND entity_key IS NULL)),
st AS (SELECT count(*) FILTER (
         WHERE cardinality($ents::text[]) > 0 AND NOT $org_wide AND entity_key IS NULL) AS org_wide_hidden
       FROM base)                                                     -- the BFF sends null when scoped
SELECT st.org_wide_hidden, h.* FROM st
LEFT JOIN LATERAL (SELECT * FROM f WHERE NOT $has_before OR (at, id) < ($before_at, $before_id)
                   ORDER BY at DESC, id DESC LIMIT $lim) h ON true
ORDER BY h.at DESC NULLS LAST, h.id DESC;   -- the all-NULL sentinel exists only when nothing matches

-- Go: more than limit rows → trim, next = the last kept row, truncated = next ≠ null.
-- name: CreateAnnotation — one INSERT; entity_key = the EntityId and entity = {id, binding, binding_id, kind, ident,
--   attrs (the canonical map)}, or both NULL; the scope check (ScopeCovers) runs before it (§5.9).
-- name: DeleteAnnotation — DELETE FROM annotations WHERE org_id = $1 AND id = $2 AND P RETURNING …; the audit event only on a row.
```

`annotations_at (org_id, at)` serves the keyset order; the 31-day lower bound on `at` is exact
because a range is at most 31 days (T11 §4.4). `P` uses `@>` with `jsonb_build_array` (not `?`, which
sqlc reads as a parameter), and a missing attribute gives `[null]`, which no allowed list contains;
the compiled `$scope` never holds a JSON `null`. `P` is byte-identical in the list and the delete
statement.

**Part E, step 1a.** The two assets (§5.12) are static files committed in the client tree and
built into the client like any other asset, so they are in the signed manifest of
[ADR-0016](../adr/0016-asset-integrity-verified-by-bff.md). There is no table, route, migration or
browser storage. A data refresh is a rebuild from new pinned sources (§5.13): the PR updates
`sources.json`, the assets and `manifest.json`, with the `--check` output attached. In the
prototype the basemap has 287 polygons with 1 hole, and the gazetteer (without cloud rows) 238 ISO
3166-1 rows (14 `-99` features dropped, 4 shared alpha-2 codes resolved by `ADM0_A3`), 4 313 ISO 3166-2
rows (188 malformed codes dropped, 60 repeated) and 3 245 IATA rows. All 177 features keep their
largest polygon; the one drop is a PRK sliver (3 points, 4.5·10⁻¹² deg², a border artefact near the
Tumen; PRK's 43-point polygon is kept); ZAF's Lesotho hole passes; the polar vertices are only in ATA
and the seams only in ATA, FJI and RUS; two runs are byte-identical; both assets validate.

**Part E, step 1b.** The geomap version (§5.15) is stored as the board document is today, with an
identity upcaster (T11-016). There is no new table, route, migration or browser storage. The camera
view lives in the engine frame and the host (`lastView`), so it is lost on unmount unless it was
saved into `options.view`; the selection, the Inspector and its `nav` stack are in memory only, per
page ([T25](T25-inspector-and-pivots.md) §6).

**Part E, step 2.** The map-sync version (§5.15) is stored as the board document is today; its upcaster
marks every stored `auto` panel `legacyAuto` (T11-016). There is no new table, route, migration or
browser storage. A map's view and the map area live in the board URL (`map=`, `geo=`, §4.18), so a
link, a reload and history reproduce them; they are never stored and never sent to the BFF.

## 7. Performance budget


**The geo bundle rule** (#234 Part 3, `geoInRoute` in `client/scripts/lib/bundleModules.ts`, run by
`npm run origins` on both builds, fail-closed like the Markdown rule): no module of `src/vis/geo/`,
`src/engine/(canvas2d|controller)/geo/`, `src/charts/geo/`, `GeoMapFrame` or `inspector/geoModel`
is in the static closure of `index.html` or `src/pages/boards/BoardsPage.tsx`; the board route's
(`BoardPage.tsx`) may hold only `vis/geo/targets.ts` and `inspector/geoModel.ts`; a missing root,
an unknown import or an unmapped chunk is a finding; `src/charts/GeoMapFrame.tsx` and
`src/engine/canvas2d/geo/scene.ts` are dynamic entries (`missing-geo-entry`) and in
`bundle-budgets.json` `required.lazyModules`. The loader imports the asset URLs itself, so the
`geo-assets` input (`urls.ts`) stays an entry nothing imports.
The Markdown and parse5 code loads as lazy chunks within the ADR-0014 §8 budgets (ADR-0024).
Report-only: `bench:markdown-render` (64 KiB ≤ 16 ms p95) and `bench:clock-tick` (20 Clocks × 12 zones
≤ 2 ms per tick).

#198 Part 3b: `bench:text-widget-render` measures the Text widget in Chromium on the production
stub build. Board P holds 6 Text panels (4 × the gallery's 2 KiB runbook, a 16 KiB and a 64 KiB
`benchInput`, each with a `$env` line, no data panel). Steps: `open` (a new context), `var` (5
filter-bar changes of `env`, each a memo miss), `type16` and `type64` (10 and 5 characters typed in
the editors). Per step it reports the uncached render (`markdown:render:<bucket>` measures, stub and
dev builds only; `le4k`, `le16k`, `le64k` by UTF-8 bytes) as p50, p95 and max, the main-thread tasks
over 16 ms and the event-latency p95. Report-only; `LONG_TASK_GATE=enforce` fails a `le4k` or
`le16k` render p95 or long task over 16 ms, or a `le64k` render p95 over 16 ms.

Measured at landing (ms; Chromium in the pinned e2e container on a shared workstation, not the
reference lab; the four runbook copies share one memo entry):

| Step | `le4k` p50 / p95 (n) | `le16k` p50 / p95 (n) | `le64k` p50 / p95 (n) | Tasks over 16 ms (worst) | Event latency p95 |
|---|---|---|---|---|---|
| `open` | 6.8 / 6.8 (1) | 11.5 / 11.5 (1) | 19.0 / 19.0 (1) | 9 (104.4 ms) | — |
| `var` | 0.6 / 2.2 (5) | 4.0 / 13.9 (5) | 16.4 / 18.4 (5) | 64 (67.1 ms) | 111.4 ms (click) |
| `type16` | — | 2.8 / 9.5 (10) | — | 43 (78.5 ms) | 81.0 ms (keydown) |
| `type64` | — | — | 10.8 / 35.6 (5) | 41 (117.0 ms) | 70.3 ms (keydown) |

M1 is triggered (the `le64k` render p95 is over 16 ms in every step), and so is M2 (`type16` has
tasks up to 78.5 ms while its `le16k` render p95 is 9.5 ms). Each becomes a follow-up issue.

| Rung | Trigger | Design |
|---|---|---|
| M0 (Part 3a) | — | Deferred values, the narrowed variables key, one memoised `TextContent` per panel |
| M1 | `le64k` or `le16k` render p95 > 16 ms | Content over 8 KiB is parsed and walked in a module worker inside the Markdown chunk. `renderMarkdown` splits into `planMarkdown` (the same walk, producing serialisable records and removals) and `planToReact`. The key is unchanged, and the previous output stays until the result arrives |
| M2 | A commit long task over 16 ms while the render p95 is ≤ 16 ms | Commit the top-level blocks in slices of ≤ 200 elements per frame, in a transition |

Part B1: list widgets render plain DOM, without virtualisation (1 000 rows fit). Report-only:
`bench:widget-lists` (a 1 000-row re-render ≤ 16 ms p95).

Part B2: a Change feed holds at most 2 000 rows, in plain DOM. Each page is one indexed statement
(`annotations_at`). Report-only: `bench:widget-lists` adds a 2 000-row Change feed render (≤ 50 ms
p95).

Part E, step 1a: in the prototype the basemap is 31 441 B and the gazetteer (without cloud rows)
90 501 B brotli. `ci:bundle-size` gains the rows `geo-basemap` ≤ 40 000 B and `geo-gazetteer`
≤ 104 000 B within the 1 000 000 B total; origin/main at 3fb02ce is 575 005 B (stub build) and
558 708 B (HTTP build), so ≥ 280 KB of the total stays free. The assets load once per page, in
parallel, on the first `loadGeoData` call. Hole validation is bounded by the T24-087 cost (880 pair
tests on the real basemap).

Part E, step 1b: a frame draws at most 5 000 rows (the T22-006 cap, disclosed by the meter); the
clusters are rebuilt only when the level ⌊zoom⌋ or the data changes, and the hidden mark list holds
only the in-view marks. Report-only: `bench:geomap-markers` (5 000 rows, 10 s of pan and zoom,
Chromium at 1×) p95 ≤ 16 ms per frame.

Part E, step 2: the area runs once per result, after the run and before planning, with no request.
`bench:geo-area` (5 000 series: 4 000 `cloud_region` labels cycling gazetteer ids and 1 000
coordinates; the EU area; 20 warm-up and 200 timed runs) reports `applyArea`'s p50 and p95 on PR
(report-only) and is enforced at p95 ≤ 2 ms once the lab exists (`GEO_BENCH_GATE=enforce`).

## 8. Security, tenancy & RBAC

- One renderer with no HTML string sink and no Trusted Types policy of its own (T24-004,
  [T18-005](T18-security.md#t18-005--two-named-trusted-types-policies-no-default), T18-013); every
  URL is classified after interpolation (T24-005, T18-011).
- Removals and import errors carry no content (T24-007, §5.4 step 5).
- AI output loads no image or other auto-loading element (T24-018, T18 §4.10). Until the image proxy
  ships, no external image is loaded (T18-014 interim).
- Tenancy: widgets fetch and store nothing; RLS is unchanged.
- Part B1: every board query runs in `OrgTx` under RLS (T11-003); org B is in every itest. The list
  GET writes only the tags cache, in a separate short transaction (at most 200 rows, `SKIP LOCKED`,
  2 s, on the primary); a failed repair leaves rows stale, and its log carries no titles.
- CSV cells are guarded against formula injection (`csvCell`, T24-026). Search uses `strpos`, so `q`
  has no wildcards; folding is ASCII-only.
- Part B2: the data scope `P` is inside each annotations statement (list, create, delete), compiled
  per kind and fail closed (§5.9, T12-018): organisation-wide rows are full-scope only, a scoped
  answer has `orgWideHidden: null`, and a hidden row and an absent row give the same 404 on delete.
  Org B is in every itest. Change text and tags are free content shown as authored and never parsed;
  the user docs say "with scopes, don't name other services in change text". The CSV guards the text
  (`csvCell`).
- Part E, step 1a: the assets are static public data, fetched from the same origin and verified
  through the signed manifest (ADR-0016). There is no route, storage, RLS change or request to
  another origin, and [T12-018](T12-entity-catalogue.md#t12-018--no-hidden-identifier-in-any-response)
  is untouched. Labels are only read by a pure function. The build checks every source's SHA-256
  before reading it, and each asset is validated whole before use (T24-087).
- Part E, step 1b: no route or storage; the frame shows only the tenant's own query labels, and
  targets, members and pivots carry nothing else (T12-018). Every CSV cell goes through `csvCell`;
  its numeric exemption needs the whole cell to be a number with no line terminator, so a cell such
  as `-1+2` or `=SUM(1)` is still guarded (T24-026).
- Part E, step 2: the map area only removes and counts the series a query returned; `geo=` and
  `map=` never reach the BFF, so no request and no RLS scope changes (T12-018). The pivots name the
  area as not carried and never put `geo=` in an href (T25-010). URL values are read only through the
  §5.17 patterns; an invalid pair is skipped, never rewritten. Import notes strip Cc characters and
  are cut to 40 code points, and imported options hold only validated values (§4.19).

## 9. Failure modes & degradation

| Risk | Handling |
|---|---|
| URL bypass, log or report leaks, AI images | `classifyUrl` and the fuzz gate; content-free removals and errors; `ai` has no `<img>` |
| Tenancy; spec versions | No fetch or storage; safe GETs; the next spec version |
| Ticks; zones | The due-time scheduler (T24-011); Go decides zone validity: the form on every parse, existence on writes only against the build's zone set, a zone the head holds kept; a stored zone is always readable; a bad zone → one row (T24-010) |
| Tenancy (part B1) | `OrgTx` under RLS; org B in the itests |
| Rolling upgrade | One migration (N+1); an old binary's head move leaves the row stale → `unknown` until repaired; old binaries cannot move a head saved at the tags version or later (`ErrSchemaTooNew`); an old server answers without `applied` (T24-029) |
| A GET that writes | A separate short transaction, ≤ 200 rows, `SKIP LOCKED`, 2 s, on the primary; a failure leaves rows stale and never fails the list |
| A failed refetch; a late answer | The snapshot is kept with `staleAtMs`; an answer for an old key never renders (T24-024) |
| Scope (part B2) | RLS and `P` in one statement per path; an unset scope or `b: []` → 403 before any SQL |
| Rolling upgrade (part B2) | Migration 5 after #215 (N+1); an old server answers without `applied` (T24-038); `annotations_entity_pair` `NOT VALID` until I7 |
| Rows change while paging | Keyset order on (`at`, `id`); the T24-032 guarantees; the paged meter text and Refresh |
| An older page fails | The rows are kept, with Retry (§4.7) |
| Stale geo data (part E) | A label the data does not know is `unknownCode`, never placed elsewhere; refreshes go through `--check` (§5.13) |
| A source changes (part E) | A crossing ring, polar land outside `polarFeatures` or a collapsing country fails the build (T24-086); nothing is drawn wrong |
| An asset fails to load or validate (part E) | That asset alone is null, with one `console.debug` line; a null gazetteer → `gazetteerUnavailable`, and coordinates and geohashes still place (G0) |
| Bundle growth (part E) | 122 KB measured against 144 KB of new rows; ≥ 280 KB of the total stays free (§7) |
| Spec versions (part E step 1b) | the geomap version, with an identity upcaster; an older server's 400 → "This server does not support map panels yet"; old binaries cannot move a head at the geomap version or later (§5.15) |
| Too many rows (part E step 1b) | The 5 000-row cap keeps min, max and the worst states (T22-006); the meter, the table and the CSV disclose and list every row |
| Rows that cannot be drawn (part E step 1b) | Each status is independent and disclosed (T24-089, §4.11); `noneShown`, `mapDataUnavailable` and `tooSmall` still offer the table (§4.12) |
| A stale Inspector step (part E step 1b) | `push` checks `seq` and `depth`, and the content unmounts with its request; a push before the `originChanged` effect hits the open request and the selection stays (T25 §4.8) |
| Camera lost on unmount (part E step 1b) | Only `options.view` persists; a new frame starts at `lastView ?? options.view` (T24-088) |
| CSV injection (part E step 1b) | `csvCell` on every cell, the numeric exemption only for whole numbers without line terminators (T24-026) |
| Lost URL writes (part E step 2) | One store and one FIFO queue; a stale seq is ignored and an external navigation cancels the queue (§4.18) |
| Link length (part E step 2) | Map pairs are evicted first; removals always succeed; other writers behave as today; a refused map write stays local, with a notice (§4.18, T24-096) |
| A silent vis switch (part E step 2) | Stored `auto` panels are `legacyAuto` and keep their vis; only an edited-and-saved or new panel gets row 8, previewed first (T24-099) |
| Generic `region` labels (part E step 2) | Rule 7 of §4.10 can pick a map for non-geographic regions; the unknown codes are disclosed and the user can pick another vis (persisted, VIZ-065) |
| Spec versions (part E step 2) | the map-sync version; an older server's 400 → "This server does not support map sync yet" (§5.15) |

## 10. Testing

Written first in the implementation issues. Origin `https://dash.test`; all fail today.

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:board-spec-widgets` | spec.test.ts, validate_test.go | fixtures | valid → none; text + `query` → `board.panel.query.forbidden`; line without → `.required`; clock `depth` → `unknownKey`; 13 zones, `tz:'Mars/Base'` → `zones.invalid` (`Mars/Base` in Go only, on a new spec: the client checks the form, and its row carries `client_fields` `[]`); duplicate zone → `.duplicate`; 65 537 bytes → `content.tooLong`; `to:'2026-11-26 14:00'` → `countdown.invalid`; TS = Go; the version before upcasts | T24-003, VIZ-031, 057 |
| `unit:classify-url` | sanitise/url.test.ts | strings | rejected: `/\t/evil.test`, `/a/../..//evil.test`, `/.//evil`, `/\\evil.test`, `//evil.test`, ` /x`, `/x\u0085`, `https://u:p@x.test/`, `JaVaScRiPt:x`, `data:,x`, `boards/b1`; local: `/boards/b1?x=1#h`, `/%5Cevil.test` (unchanged); external: `HTTPS://X.TEST` → `https://x.test/`; mailto: `mailto:o@x.test` | T24-005 |
| `unit:well-formed` | sanitise/url.test.ts | `'a\uD800'`, `'\uDC00b'`, `'😀'`, `''` | `'a�'`, `'�b'`, unchanged, `''`; in `classifyUrl`, a lone surrogate in an accepted path → `%EF%BF%BD`, in a host → rejected | T24-005, T24-008 |
| `unit:markdown-links` | sanitise/markdown.test.tsx | inputs L (below); `board`, then `ai` | a → text + `linkScheme`; t → `/%09/e.test`; b, d, e → new-tab `<a>`; `ai`: b → text `b (x.test)`, e → text `e (o@x.test)`, no removal; d an anchor | T24-005, T24-018 |
| `unit:markdown-nodes` | same | `"<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n**ok**"`; `# A\n###### F\n1000000. x` | DOM `<p><strong>ok</strong></p>`, removals `[{html,1},{html,3}]`; `<h4>`, `<h6>`, `<ol start="999999">` | VIZ-054, T24-009 |
| `unit:markdown-iframe` | same | `<iframe src="https://s.test/"></iframe>`; `<div>t<iframe src="/b"></iframe></div>`; `a <script>'<iframe src="/b">'</script>` | nothing rendered; removals `[iframe]`, `[iframe]`, `[html]` | T24-006 |
| `unit:markdown-images` | same | inputs I (below); `board`, then `ai`; images with the sources `/api/x` and `/auth/x` | board: `<img src="/l.svg">`, link "g", text "d", `<img src="/%09/e.test">`; ai: 4 texts + `image`, no `img`; `/api/` and `/auth/` → a link + `image` | T24-018, T18-014 |
| `unit:markdown-interpolate` | same | inputs V (below) | text `Env prod prod $missing $__from {{entity}}`; code `$env`; href `?q=a%20b%26c`; y → text + `linkScheme` | T24-008 |
| `unit:removal-redaction` | same | `[x](javascript:fetch('https://u:hunter2@e.test/?token=abc'))`; `<a href="https://e.test/?token=abc">` | `[{linkScheme,1}]`, `[{html,1}]`; editor text and `console.debug` JSON lack `hunter2`, `token`, `e.test` | T24-007 |
| `fuzz:markdown-nodes` | sanitise/markdown.fuzz.test.ts | 10 000 inputs (mulberry32, seed 20261125) of 1–40 tokens from the corpus payloads, Markdown syntax, `$env`, `{{entity}}`, U+0000, U+202E, U+D800; both policies, import | `checkInvariants`: tags ⊆ §4.2 + `span`; attributes ⊆ `href target rel src alt loading start data-lang class aria-hidden`, no `on*`, `style`, `srcdoc`; `href`/`src` pass the independent checker (`ai`: `local` anchors only); `ai` no `img`; `span` only as the glyph, the hidden text or a flat span; DOM depth ≤ `MAX_DEPTH`; well-formed text; import inverse | VIZ-054, 056 |
| `unit:markdown-depth`, `unit:markdown-root`, `unit:markdown-walk`, `unit:markdown-pathological`, `unit:markdown-flat-lines`, `unit:markdown-inline-depth`, `unit:markdown-surrogates` | sanitise/markdown.test.tsx | `P(N)` = `'> '.repeat(N)` before each line; `E(k)` = k nested `em` (#198 Part 2b plan §5) | each depth pair renders elements, then one flat span of the block's whole source lines and one `depth`; the root fragment; splicing into the immediate parent, removal order; `'>'.repeat(20000)+'x'`, `'*'.repeat(50000)`, `'['.repeat(20000)`, `'- '.repeat(5000)+'x'`, `E(5000)` in < 2 s; `sourceLines` clamping, CR, CRLF; lone surrogates → U+FFFD, `%EF%BF%BD`; DOM depth ≤ 32 | T24-006, T24-008, VIZ-054 |
| `unit:markdown-xss-corpus` | sanitise/markdown.corpus.test.tsx | the generated `__fixtures__/xss-corpus.json` (groups S, H, B, V, L, N, D, U), `createRoot`, both policies | each case's generated shape and removals; `checkInvariants`; no `fetch`, `XMLHttpRequest.open` or `sendBeacon` | VIZ-054, 056, T18-013 |
| `unit:xss-corpus-current` | scripts/gen-xss-corpus.test.ts | `gen-xss-corpus.ts --check` | committed = regenerated; one changed expectation → exit 1 | VIZ-054 |
| `unit:find-iframes` | sanitise/findIframes.test.ts | `<iframe data-src="a" src="b">`, `<iframe title='src="x"'>`, `<iframe src="b" SRC="c">`, `<iframe src="?a&copy=1">`, `<!-- x --!><iframe src=y>`, `<!--><iframe src=z>`, `<select>`/`<table>`/`<frameset>`/`<template>`/`<svg>`/`<select><title><select>` + `<iframe src=w>`; then `<script>`, `<textarea>`, `<title>`, `<style>`, `<xmp>`, `<plaintext>`, `<![CDATA[`, `<?x`, `</ ` before `<iframe src=x>` | `b`, `null`, `b`, `?a&copy=1`, `y`, `z`, `w` ×6; none for the rest or `<svg><![CDATA[…]]>`; no duplicates | T24-006 |
| `unit:import-text-iframe` | sanitise/importText.test.ts | f1, f3–f12 | exact `inserted`, `notes`; removing `inserted` gives the input byte-for-byte; hrefs f1 `https://x.test/a)b?q=%5B1%5D&r=%3C2%3E`, f3 `https://x.test/?a=&copy;&b=&#169;&c=&amp;d&e=1`, f5 as listed; f4/f6–f10 as listed; f11 f1's notes and link texts, each a `link` node; f12 each link after its top-level block, the next paragraph a `paragraph` | VIZ-056, T24-016 |
| `unit:import-size-error` | same | 65 500-byte panel "Payroll", `src` with `?token=SECRET123` | error `{kind:'textTooLargeForLinks', panelIndex, sourceId, links:1}`; JSON and message lack `SECRET123`, `Payroll` | T24-016 |
| `unit:security-lint` | scripts/security-plugin.test.ts | `ESLint.lintText` snippets | `security/no-iframe` (`ci:no-iframe`) on JSX `iframe`/`frame`/`frameset`/`object`/`embed`, `createElement` of those (any case), `srcDoc` and `srcdoc` assignment, `new DOMParser` (also `window.DOMParser`), `.createContextualFragment(`, static computed keys included; `security/no-html-sink` on `innerHTML`/`outerHTML`/`insertAdjacentHTML` in every spelling; `security/markdown-boundary` on commonmark outside `sanitise/`, parse5 or the alias outside `findIframes.ts`, `HtmlRenderer`/`XmlRenderer`, `minimist`, bare `parse5-sax-parser` outside its test; the full config applies both | VIZ-056, T08-009 |
| `unit:bundle-modules` | scripts/check-bundle-modules.test.ts, config/moduleGraph.test.ts | graph fixtures (one a worker chunk); a probe build whose worker extends `node:stream` | `minimist`, `node:` (with or without NUL), `__vite-browser-external`, `SAXParser`'s entry → one `forbidden-module` each, exit 1; clean → exit 0; missing → exit 2 | ADR-0024 |
| `unit:sanitise-bundle` | scripts/sanitise-bundle.test.ts | Vite build of a probe lazily importing the sanitiser | no forbidden module; lazy chunk ≤ 100 000 bytes brotli 11; a probe extending `node:stream` `Transform` is caught | ADR-0024, ADR-0014 §8 |
| `unit:text-widget` | widgets/text/TextBody.test.tsx | `env=prod`; `# R`, a link, `Env $env`; code `promql`; `''`, `'  '` in view and edit; the removal-redaction input; a rejecting entry | `h4` "R"; a new-tab `a` with the three `rel` values; "Env prod"; `<pre><code data-lang="promql">` literal; empty / "Write Markdown" with no chunk load; `logRemovals` once with `[linkScheme]`; the load-failed text | T24-008, T24-014 |
| `unit:text-region` | same | each state, on a board and in the preview, titles `Runbook` and `''` | the board name "Runbook" in every state; "Preview: Runbook", "Preview: Text"; `data-text-state` | T24-009 |
| `unit:text-overflow` | same | `clientHeight` 100, `scrollHeight` the content's length; 50 → 200 → 50, exactly 101 and 100; a `$env` value grows and shrinks; a resize | `tabIndex` 0 after each growth and at 101, absent after each shrink and at 100, with no region resize; the resize measures | T24-017 |
| `unit:text-invalid` | same + `widgetVisErrors` | 65 537-byte content; `language` in Markdown mode; the `invalid.json` text rows | the renderer and the entry never called; preview status "Preview unavailable: Use at most 65 536 bytes." described by the region; board text; the rows' fields without the panel prefix | T24-014 |
| `unit:text-widget-vars` | same | `env` changes, then an unrelated `zone` | one memo miss and the new text; then no `TextContent` render and no lookup | T24-008 |
| `unit:board-variables` | boards/variables.test.ts | a query with `$env`; Markdown `$region ${env}`; code `$x`; a clock | `['env', 'region']` | T24-008 |
| `unit:widget-add` | boards/editorState.test.ts | `addWidget`: top, a collapsed section, a data vis, 200 panels, a full grid; `updateWidget`: same kind, other kind, no vis, a data panel; while saving | added 6 × 6, selected, the section open; unchanged; `board.fullPanels`; `board.full`; patched; unchanged; title only; unchanged; ignored | VIZ-053 |
| `unit:widget-editor` | pages/board/WidgetEditor.test.tsx | Edit panel on p-1; Content; Code; Markdown; a 65 537-byte paste; Remove; Done | "Edit text panel"; the panel and preview follow; Plain text; no `language` after Markdown; `content.tooLong` under Content and in the preview, no render; the removal list; focus to Add panel / the menu | T24-007, T24-014 |
| `unit:widget-spec-roundtrip`, `unit:text-vis-roundtrip` | BoardWidgets.test.tsx, widgets/text/textVis.test.ts | `v5-widgets.json`: edit and type back; Discard; Save; refetch. p-3 without options typed and deleted | clean after typing back; Discard gives the head; the PUT is the fixture with one change, the other panels byte-equal; p-3 stays without options | T24-002, T24-003 |
| `unit:widget-registry-generic` | BoardWidgets.test.tsx | a context with `TEXT_DEF` and a test-only clock def | the menu lists both; the def's `newVis` and size; its editor title and body; the saved vis; Edit panel on the stored clock | §5.2a |
| `unit:bundle-modules` (Markdown) | scripts/check-bundle-modules.test.ts | manifests: Markdown only through `dynamicImports`; in a route chunk; no root; a dangling import; an unmapped chunk; no, static or empty entry; no manifest | [] and exit 0; exactly one finding each, exit 1; exit 2 | ADR-0014 §8, ADR-0024 |
| `unit:clock-format` | widgets/clock/format.test.ts | 12:34:56Z, Context London, en-GB | Tokyo `21:34` `Thu 26 Nov` `UTC+09:00` night; New York `07:34` `UTC−05:00` day; Auckland `01:34` `Fri 27 Nov` `+1 day` night; UTC `12:34` `UTC` day; `h12` Tokyo `9:34 pm` | T24-010, 013 |
| `unit:clock-countdown` | same | `to` 14:49:56Z, 12:35:38Z, 12:34:56Z, 12:22:56Z, +2 d 3 h | `in 2 h 15 min`, `in 42 s`, `since 21:34 (0 s)`, `since 21:22 (12 min)`, `in 2 d 3 h`; `hide` + past → no row | T24-012 |
| `unit:countdown-due` | state/wallClock.test.ts | `to` fixed; r in ms | r → (text, due, next): 125 000 (`2 min`, +5 001, `1 min`); 120 000 (`2 min`, +1, `1 min`, announced); 960 000 (`16 min`, +1, `15 min`, announced); 60 000 (`1 min`, +1, `59 s`); 1 000 (`1 s`, +1, `now`); 1 (+1, `since … (0 s)`, announced); after-`to` e 59 999 (+1 → `1 min`). Property (200 s → −130 s, 137 ms steps): text changes exactly at due | T24-011, 012 |
| `unit:wall-clock` | same | fake timers; zone + countdown | one timer at earliest due; hidden at r = 90 s → none; visible at 30 s → all notified, `in 30 s` announced once; last unsubscribe clears | T24-011 |
| `e2e:widget-text` | e2e/widgets.spec.ts | `"# R\n[S](https://s.test)\nEnv $env"` through the boards API, env=prod; then Edit board → Add widget → Text → `# Added` → Done → Save → reload (#198 Part 3b) | `h4`; `_blank` link with the three `rel` values; env=dev → "Env dev", no query; the region named by the title; after reload, `h4` "Added" | VIZ-053, T24-008, T24-009 |
| `e2e:widget-text-xss` | same | (a) `unit:markdown-nodes` input + iframe line; payloads and a wrapped `alert` set `window.__xss`. (b) the whole corpus from `fixtures/xss-e2e-cases.json` (generated from the corpus: `digest`, `skip`, the `<img>` request paths), one case per fresh context (service workers blocked) on its own one-panel board, against the committed per-browser load baseline recorded from a twin board. (c) canaries c1–c12 (#198 Part 3b §4.2) | (a) `__xss` unset; no finding after the consumed Trusted Types canary; no `iframe`; the editor lists `[html, html, iframe]`. (b) the list equals the generated one; the twin's key → count map equals the baseline; per case `checkInvariants` on the rendered DOM, the `<img>` paths equal the case's, no `iframe`/`script`/`object`/`embed`/`frame`/`base`/`link`/`meta`/`form`, `__xss` unset, the document's CSP equals `CSP` exactly, the Trusted Types canary consumed, no request beyond the baseline, no image outside the case's list or loaded twice, no CSP or Trusted Types violation, console line, page error or service worker. (c) each canary gives exactly its findings | VIZ-054, 056, T18-013, T24-018 |
| `e2e:widget-clock` | same | `page.clock` 12:34:56Z; Tokyo, NY; countdown to 12:35:56Z; reduced motion too | `in 1 min`, silent; +1 s `in 59 s`; +59 s `since 21:35 (0 s)`, announced; no transition if reduced | T24-012, VL-016 |
| `e2e:widget-a11y` | same | both, view/edit; Text (#198 Part 3b): an overflowing Text with two links and a short Text in view mode, then the editor | axe clean; T24-017 order (Text: panel menu → region → link 1 → link 2; the short region not tabbable); the preview region "Preview: ‹title›" and an over-limit content's "Preview unavailable" status; "Tokyo, 21:34, Thu 26 Nov, night, UTC+09:00" | T24-017, T24-009, T24-014, VIZ-066, 068 |
| `golden:widget-gallery` | e2e/widget-gallery.spec.ts | 5 pages × dark/light/grey, fixed clock: `widget-text` and `widget-text-removals` from #198 Part 3b (`dev/widgets?page=`), the three Clock pages in A2; grey is CSSOM `grayscale(1)` on dark | baselines generated in the pinned e2e container (0.1, ≤ 0.2 %); a reload gives the same pixels | VIZ-069, 067, T24-015 |
| `unit:xss-e2e-cases` | scripts/gen-xss-e2e-cases.test.ts | `--check` against the committed list; a baseline map with one count incremented (c13); one case's source changed under its id (c14); the image extraction rows and one case per skip reason (#198 Part 3b §5) | exit 0, one changed expectation → exit 1; c13 names that key, c14 that id's digest; the extracted paths; the reasons | VIZ-054, T24-018 |
| `unit:widget-gallery-route` | src/app/router.test.tsx | `/t/demo/dev/widgets?page=widget-text`, then `…removals`; the http build | 3 `[data-text-body]`; 1 `[data-text-removals]` with 7 items; no route in the http build | VIZ-069 |

Markdown inputs for the rows above (one per line, as written in the test):

```text
L  [a](javascript:x)   [t](</\t/e.test>)   [b](https://x.test/p)   [d](/b)   [e](mailto:o@x.test)
I  ![l](/l.svg)   ![g](https://x.test/g.png)   ![d](data:,x)   ![s](</\t/e.test>)
V  vars {env:'prod', q:'a b&c', u:'javascript:x'}; Env $env ${env} $missing $__from {{entity}}   `$env`
   [x](https://x.test/?q=$q)   [y]($u)
```

`ci:dep-audit` and `ci:no-iframe` still pass. Report-only: `bench:markdown-render` (50 distinct 64 KiB
inputs, every memo lookup a miss: the uncached p95 ≤ 16 ms), `bench:text-widget-render` (§7, #198
Part 3b), `bench:clock-tick` (20 Clocks × 12 zones ≤ 2 ms per tick). No itest until A3. Every gate is in
[T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

Fixtures `api/fixtures/import/text-iframe.json` (all pass in a prototype; ⏎ is a newline, a leading
number is a line number):

```text
f1 1 Intro <iframe src="https://x.test/a)b?q=[1]&amp;r=<2>"></iframe> end⏎2 <div>⏎3 keep <b>me</b>⏎4 <iframe src="https://intended.test/"></iframe>
   5 </div>⏎6 after⏎7⏎8 `<iframe src="https://code.test/">` and \<iframe src="https://esc.test/">⏎9⏎10 <iframe src="javascript:alert(1)"></iframe>
   after 1: ⏎[Open embedded page \(x\.test\)](<https://x.test/a)b?q=[1]&amp;r=%3C2%3E>)⏎⏎; after 6: ⏎[…](<https://intended.test/>)⏎
   notes [{iframeToLink,1,x.test},{iframeToLink,4,intended.test},{iframeNoLink,10},{htmlNotRendered,4}]
f3 <iframe src="https://x.test/?a=&amp;copy;&amp;b=&amp;#169;&amp;c=&amp;amp;d&amp;e=1"></iframe>
   insert ⏎[Open embedded page \(x\.test\)](<https://x.test/?a=&amp;copy;&amp;b=&amp;#169;&amp;c=&amp;amp;d&amp;e=1>)⏎
f4 1  0  `<iframe src="https://code.test/">`⏎3 <script>const e = '<iframe src="https://s1.test/">';</script>
   5 <style>/* <iframe src="https://s2.test/"> */</style>
   7 x <textarea><iframe src="https://s3.test/"></textarea> <title><iframe src="https://s4.test/"></title> y
   9 <iframe src="https://real.test/"><iframe src="https://inner.test/"></iframe>⏎11     <iframe src="https://indented.test/">⏎13 <plaintext><iframe src="https://p.test/">
   insert after 9 only (real.test); notes [{iframeToLink,9,real.test},{htmlNotRendered,11}]
f5 <iframe src="https://x.test/?a=1&copy=2&b=&copy;&c=&notit;&d=&#169=x"></iframe>
   href https://x.test/?a=1&copy=2&b=%C2%A9&c=&notit;&d=%C2%A9=x (= browser's src URL)
f6 B = `<iframe src="https://s.test/"></iframe>⏎` + 65 442 × `x` + `⏎` (65 483 bytes; insert is 53) → 65 536 bytes, converted;
   one more `x` → `{ok:false, sizeLimit, links:1}`; B with mode code → `ok`, unchanged, notes []
f8 <div><!-- a --!><iframe src="https://bang.test/"></iframe></div>⏎⏎x <!-- b --!> <iframe src="https://bang2.test/"></iframe> y
   inserts after 1 and 3; notes [{iframeToLink,1,bang.test},{iframeToLink,3,bang2.test},{htmlNotRendered,3}]
f9 lines 1, 3, 5, 7: <select><iframe src="https://sel.test/"></iframe></select> · a <select><iframe src="https://sel2.test/"></select> b ·
   <frameset><iframe src="https://fs.test/"></frameset> · <template><iframe src="https://tpl.test/"></template> → a link after each; 4 iframeToLink, {htmlNotRendered,11}
f10 <select><title><select><iframe src="https://x.test/"></iframe></select></title></select>⏎⏎a ‹same with y.test› b
   links after 1, 3; notes [{iframeToLink,1,x.test},{iframeToLink,3,y.test},{htmlNotRendered,16}]
f7 lines 1–13 (blank between): <![CDATA[<iframe src="https://c1.test/">]]> · a <![CDATA[<iframe src="https://c2.test/">]]> b ·
   <?x <iframe src="https://p1.test/"> ?> · a <?x <iframe src="https://p2.test/"> ?> b · <!DOCTYPE <iframe src="https://d.test/">> ·
   <div></ <iframe src="https://b.test/">x</div> · <div><!--><iframe src="https://after.test/"></div>
   only insert: after 13, after.test; notes [{iframeToLink,13,after.test},{htmlNotRendered,7}]
f11 f1 with \r\n line ends, and with \r: f1's notes and link texts after the ends of lines 1 and 6
   (after a lone \r the inserted line ends are \r); each link a link node; inverse exact
f12 1 - <iframe src="https://li.test/"></iframe>⏎2 para one⏎3⏎4 > <iframe src="https://bq.test/"></iframe>⏎5 para two⏎
   links after 1 and 4, each ⏎…⏎⏎; top-level list, paragraph (link), paragraph, block_quote, paragraph (link), paragraph;
   notes [{iframeToLink,1,li.test},{iframeToLink,4,bq.test},{htmlNotRendered,2}]
```

### 10.1 Part B1 tests

Written first in I1 and I2 (§11); all fail today: nothing exists yet.

**Fixture B:** 12 starred refs in server order: Checkout (`ck-1`), Checkout (`ck-2`), Edge, Gateway,
Inventory, NOC overview, Orders, Payments (`pay`), PSP API, Search, Shipping, Web; `truncated: false`.
**Fixture S:** org A: "Checkout overview" `[team:payments]`, "CHECKOUT latency", "Zürich edge",
"ZÜRICH core", "payments" `[payments]`, "Ledger" `[finance, team:payments]`, and 1 002 "bulk-n"
(distinct `created_at`, older than the named boards, which are in this order); org B:
"checkout b".

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:board-spec-board-list` | boards/spec.test.ts, validate_test.go; the board-tag cases in I1 (#215), the rest in I2 | `{}`; tag mode, no tag; starred + tag; 101-char query; `query:'a\tb'` (`\t` = U+0009 TAB); recent + query; limit 0/51/2.5; `sort:'care'`; `depth:1`; board tags ×17/`['A']`/`['a','a']` | Defaults `{starred,'',null,10,default}`; `tag.invalid` ×2, `query.invalid` ×3, `limit.invalid` ×3, `sort.invalid`, `board.json.unknownKey`, `board.tags.invalid` ×2, `.duplicate`; TS = Go; the version before upcasts; the editor shows the Cc text for `a\tb` (U+0009) and sends nothing | T24-029, T24-021, VIZ-031 |
| `unit:board-list-source` | widgets/boardList/source.test.tsx | Stub Api, fake timers | T24-021 calls and keys; `'  Checkout '` → `{q:'Checkout'}`; `''` → no `q`; keys at 0/100/200 ms → one key change and request at 450 ms, the previous rows shown until then | T24-021 |
| `unit:board-list-rows` | widgets/boardList/rows.test.ts | B, current `pay` | `Checkout · ck-1`, `Checkout · ck-2`, the rest plain; `pay` "this board"; `incidents` → B order + the caption | T24-022, T24-023 |
| `unit:list-coverage` | widgets/lists/snapshot.test.ts | `listCoverage` → `coverageText`; `unknown` via `boardSnapshot` (no `applied`; `tagsStale` 1, 3) | (12,10) `showing 10 of 12`; (12,12) `100 %`; (1000,10,trunc) `truncated · showing 10 of 1,000`; (0,0) `100 %`; (3,3,oldServer) `coverage unknown`; (3,3,tagsStale 1) `tags not yet known for 1 board`, 3 → `tags not yet known for 3 boards`; stale 12:31:05 `stale (12:31:05)`; Narrow in search only | T24-024, VIZ-027 |
| `unit:board-list-states` | widgets/boardList/states.test.tsx | Stub: ok B → the refetch fails at 12:31:05 → Retry ok, B minus Orders, Edge → "Edge v2"; also 503 | `Loading…` at 300 ms, `loading`, facts null; 12 rows; failure: rows kept, the notice, `showing 10 of 12 · stale (12:31:05)`, CSV 12 rows, `12 boards (stale)`; Retry: 11 rows, "Edge v2", CSV without Orders, `11 boards`; 503 → the store text, `unavailable` | T24-024, T24-026, T24-027 |
| `unit:board-list-mixed` | widgets/boardList/mixed.test.tsx | No `applied`: starred `{items:B, truncated:false}`; search `check` → S org-A items / `[]`; tag `team:payments` → S org-A items / `[]`. New server `tagsStale: 3`; a save → 400 at `/tags` | Starred `coverage unknown · showing 10 of 12`, setsize −1; search → 2 checkout rows, no chips / "No boards match ‘check’", both `coverage unknown`; tag (both) → the T24-029 notice, no rows, `coverage unknown`; `tags not yet known for 3 boards`; the editor text | T24-029 |
| `unit:board-list-key` | widgets/boardList/key.test.tsx | Deferred stub: `check` settled (2 rows); type `pa`→`pay` within 250 ms; a second widget on `check`; tenant `acme` → `beta`; `pay` rejects | At 450 ms (commit) no `check` row, CSV disabled, facts null; `check`'s refetch kept while widget 2 observes, aborted when it leaves; late `check` answers never render in widget 1; no `acme` row after `beta` (render log); `pay` → "Couldn't load boards", no rows, `unavailable` | T24-024 |
| `unit:list-keyboard` | widgets/lists/keyboard.test.tsx | B, limit 10, focus on row 4 (Gateway) | ↓×3 from 1 → 4; End → 10; Home → 1; PageDown → 10; Show more, Enter → 11 focused. A refetch without Gateway → Inventory (row 4) focused, "Gateway is no longer listed"; focus outside the list stays; empty → the empty text; error → Retry; Esc clears the search, the next Esc reaches the T25 ladder | T24-025 |
| `unit:list-table-csv` | widgets/lists/table.test.ts | Titles `=SUM(1)`, `+1`, `-prod`, `@x`, `\tx`, `\rx` (`\t` = U+0009 TAB, `\r` = U+000D CR), `a,b`, `say "hi"`, `ok`; B; S | `'=SUM(1)`, `+1` (a number, unchanged since #184 step 1b), `'-prod`, `'@x`, `'\tx`, `"'\rx"`, `"a,b"`, `"say ""hi"""`, `ok`; B rows: empty tags, `updated_at`; S `Checkout overview` tags `team:payments`; a `tags: null` row → `unknown`, and the row shows "tags unknown"; facts `{'12 boards','Starred'}`, S `1,000+ boards`; amended by #184 step 1b: the §10.5 guard block, each result | T24-026, VIZ-066, VIZ-068 |
| `unit:import-board-list` | import/boardList.test.ts | I1–I9 (below) | Options (`sort:'default'`) and notes exactly as listed | T24-028, VIZ-060 |
| `itest:board-find` | boards/list_itest_test.go; the 400s over HTTP in cmd/pulsus-dash/boards_itest_test.go | S | `q=` checkout → 2 org-A rows, updated desc; zürich → Zürich edge; ZÜRICH → ZÜRICH core; payments → payments; finance and FINANCE → Ledger (an exact tag), fin → none; `%` → none; bulk → the 1 000 newest in `created_at DESC, uid` order, truncated, the 2 oldest absent; `tag=team:payments` → Ledger, Checkout overview; `q=checkout&tag=team:payments` → Checkout overview; `q=ledger&tag=payments` → none; 101 chars, `Bad Tag` → the §5.6 400s; org B sees only "checkout b" | T24-021, tenancy |
| `itest:board-tags` | boards/list_itest_test.go | Org A saves `tags:['a','b']`, then none, then v1's spec again. Org B saves and lists | `[a,b]`, `[]`, `[a,b]`; B's save of A's uid → 404; B's repair touches 0 A rows; `tag=a` in B → none | T24-029, tenancy |
| `itest:board-list-snapshot` | boards/list_itest_test.go (one SELECT per list: store/boards_itest_test.go); two connections, barriers; a labelled fault injection sets `tags_version` 0 on X (head `[a]`, title "X checkout") | (1) Conn 2 row-locks X; conn 1 lists `tag=a`; release; conn 2 lists; conn 1 lists. (2) Between conn 1's repair and read, conn 2 commits a schema-3 head move on Z. (3) `tag=zzz`. (4) X locked: an unfiltered list; `q=checkout`. (5) A repair error (tracer), a timeout (`pg_sleep`). (6) A cancel during the repair | (1) X absent, `tagsStale` 1; then present, 0. (2) Z counted, never `100 %`. (3) the sentinel only: `[]`, stale 1. (4) X returned with `tags: null`, `tagsStale` 1, both times. (5) 200, stale counted, the log without titles. (6) both roll back. One SELECT per list | T24-029 |
| `itest:board-tags-old-binary` | cmd/pulsus-dash/boards_old_binary_itest_test.go, run by `make itest-old-binary` in I1 (local, required for every change to the board schema or spec; hosted CI is not a gate) | 10 000 boards in 2 orgs at schema 3, a looping reader; migration 4; the base-commit binary beside N. The old service creates Y, saves Z; N saves X `[a]`; the old service saves X | No rewrite (`relfilenode`), the reader waits ≤ 1 s, 17 tags fail; the old binary starts (4 = 3 + 1) and passes `itest:board-crud`; `tag=a`: `tagsStale` 2 (Y, Z); the old save of X → `ErrSchemaTooNew`, nothing written; the next N list: Y, Z `{}`, `tag=a` → X, 0 | T11-012, T11-013, T11-015 |
| `itest:board-tags-validate` (I4) | same | Schema 4 with all rows ≤ 16 tags; apply the I4 migration | `pg_constraint.convalidated` true; an UPDATE to 17 tags fails | T11-013 |
| `itest:board-prefs` (amended) | existing | 201 starred; 200; 51 views, limit 50 | `truncated` true, false, true | T24-021 |
| `e2e:widget-board-list` | e2e/widgets.spec.ts | Stub BFF; B; search over S | 10 rows + Show more; "check" → one request 250 ms after the last key, 2 rows, "2 boards" announced once; hrefs carry `from`/`to`; ⌘-click → a new tab | VIZ-053, T24-021–023 |
| `e2e:widget-lists-a11y` | same | Widgets in the loading (held 2 s), empty, error 500, stale, unknown, ok B and `bulk` states; view, edit; reduced motion | axe clean in each; focus to the empty `<p>` / Retry; `Payments, this board`; the T24-025 order; setsize 12 / −1 (`bulk`, unknown); no transition when reduced | T24-025, T24-027, VL-016 |
| `golden:widget-gallery` (amended) | e2e/widget-gallery.spec.ts | + `widget-board-list` (B), `widget-board-list-search` (S), `widget-board-list-states` (loading, stale, unknown, empty); 3 themes | CI baseline (0.1, ≤ 0.2 %) | VIZ-069, VIZ-067 |

Import cases for `unit:import-board-list` (Dashboard list options → `boardList` options and notes, in
order; every result has `sort:'default'`, and `query:''`, `tag:null`, `limit:10` unless shown):

```text
I1 {}                                                              → starred; no notes
I2 {showStarred:true, showRecentlyViewed:true, maxItems:80}        → starred, limit 50; "Only the first list (starred) kept: add another Board list for recent", "Item limit 80 clamped to 50"
I3 {showStarred:false, showSearch:true, tags:['Team-A','b c','ops'], query:'x'}
                                                                   → tag, tag 'team-a'; "Tag ‘b c’ dropped: not a valid tag", "Tags not kept: ops (a board list filters by one tag)", "Search text dropped in tag mode"
I4 {showStarred:false, showSearch:true, query:'a' × 120}           → search, query 'a' × 100; "Search text cut to 100 characters"
I5 {showStarred:'yes', maxItems:'many', keepTime:false, folderUID:'abc', includeVars:true}
                                                                   → starred; "Option showStarred malformed: default used", "Option maxItems malformed: default used", "Links keep the time range", "Option folderUID not mapped", "Option includeVars not mapped"
I6 {showStarred:false, showRecentlyViewed:false, showSearch:false} → starred; "No list enabled: starred used"
I7 {showStarred:false, showSearch:true, tags:['!!']}               → search; "Tag ‘!!’ dropped: not a valid tag"
I8 {showRecentlyViewed:false, query:'x', maxItems:0}               → starred, limit 1; "Search text and tags dropped: they apply to search only", "Item limit 0 clamped to 1"
I9 {showStarred:false, showSearch:true, query:'a\tb\u0007c'}       → search, query 'abc' (removed: U+0009 TAB, U+0007 BEL); "Control characters removed from search text"
```

Report-only: `bench:widget-lists` (a 1 000-row re-render ≤ 16 ms p95). `ci:dep-audit` passes. Every
gate is in [T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

### 10.2 Part B2 tests

Written first in I5 and I6 (§11); all fail today: nothing exists yet.

**Entities** (the [T12](T12-entity-catalogue.md) §4.5 vectors): bindings e1 =
`00000000-0000-4000-8000-0000000000e1` (slug `prod-eu`) and e2 =
`00000000-0000-4000-8000-0000000000e2` (slug `prod-us`).

| Name | Binding, kind, attrs | EntityId |
|---|---|---|
| checkout@e1 | e1, service, `{service.name: checkout}` | `bb7487bd-100d-a998-e0f0-3c65f11da1a7` |
| checkout@e2 | e2, service, `{service.name: checkout}` | `3d1d4695-d757-d5f8-d6bf-c1b134128742` |
| payments@e1 | e1, service, `{service.name: payments, service.namespace: shop}` | `854bc89f-5785-b55c-398b-87a03d62a7d9` |
| gateway@e1 | e1, service, `{service.name: gateway}` | `af71dde5-5f66-4d0b-7ba4-e96eba601d3c` |
| pod | e1, pod, `{k8s.cluster.name: prod-eu-1, k8s.namespace.name: shop, k8s.pod.name: checkout-7d9f}` | `970888cf-821c-14c3-0155-320ca949dd19` |
| env prod | e1, environment, `{deployment.environment.name: prod}` (or `deployment.environment`, or both equal) | `f8bdae9d-e739-228c-dd0e-317933242944` |
| env stage | e1, environment, `{deployment.environment: stage}` | `ac9609b4-95c1-1f31-60b9-bd315336ed95` |
| cluster A | e1, cluster, `{k8s.cluster.name: prod-eu-1}` (canonical `{k8s.cluster.uid: prod-eu-1}`) | `9454e37d-718e-a60b-cea1-8827d683c0d7` |
| cluster B | e1, cluster, `{k8s.cluster.uid: c-9f2}` | `136e6b87-b494-b7ea-7873-c976399bcfff` |

**Fixture C:** the window 2026-11-26 12:00–13:00Z; change cN has the id
`00000000-0000-4000-8000-` + N as 12 decimal digits (c1 `…000000000001`, c11 `…000000000011`); every
row is created before page 0. c5 and c9 overlap from before the window (c9 ends exactly at `fromMs`),
and c8 ends before it.

```text
c1  deploy      12:10:00           "checkout v2.31"                   [pr:4402]  checkout@e1
c2  config      12:19:02           "payments.psp.timeout 5000→2000"   [pr:4411]  payments@e1
c3  flag        12:21:30           "new-checkout-flow 10%→50%"        []         checkout@e2
c4  annotation  12:23:00–12:40:00  "INC-2041 mitigation window"       []         organisation-wide
c5  deploy      11:50:00–12:05:00  "gateway v1.8 rollout"             []         gateway@e1
c6  config      12:19:02           "payments.retry 3→1"               []         payments@e1
c7  annotation  12:30:00           '=HYPERLINK("a")'     []         organisation-wide
c8  deploy      11:20:00–11:40:00  "checkout v2.30"                   []         checkout@e1
c9  config      11:30:00–12:00:00  "edge cache ttl 60→30"             []         organisation-wide
scope fixture adds:
c10 annotation  12:35:00           "rollback near checkout@e2"        []                       organisation-wide
c11 config      12:33:00           "retries raised after checkout@e2 timeouts"  [rel:checkout-prod-us]  payments@e1
keyset (a) inserts after page 1: n1 deploy 12:45:00 (id …000000000020), n2 deploy 12:05:00 (id …000000000021), both org-wide
```

The full order of C in the window is c7, c4, c3, c6, c2, c1, c5, c9 (8 rows). Its CSV (one page, UTC):

```text
at,end_at,kind,entity_id,entity,text,tags,id
2026-11-26T12:30:00.000Z,,annotation,,,"'=HYPERLINK(""a"")",,00000000-0000-4000-8000-000000000007
2026-11-26T12:23:00.000Z,2026-11-26T12:40:00.000Z,annotation,,,INC-2041 mitigation window,,00000000-0000-4000-8000-000000000004
2026-11-26T12:21:30.000Z,,flag,3d1d4695-d757-d5f8-d6bf-c1b134128742,service checkout · prod-us,new-checkout-flow 10%→50%,,00000000-0000-4000-8000-000000000003
2026-11-26T12:19:02.000Z,,config,854bc89f-5785-b55c-398b-87a03d62a7d9,service shop / payments,payments.retry 3→1,,00000000-0000-4000-8000-000000000006
2026-11-26T12:19:02.000Z,,config,854bc89f-5785-b55c-398b-87a03d62a7d9,service shop / payments,payments.psp.timeout 5000→2000,pr:4411,00000000-0000-4000-8000-000000000002
2026-11-26T12:10:00.000Z,,deploy,bb7487bd-100d-a998-e0f0-3c65f11da1a7,service checkout · prod-eu,checkout v2.31,pr:4402,00000000-0000-4000-8000-000000000001
2026-11-26T11:50:00.000Z,2026-11-26T12:05:00.000Z,deploy,af71dde5-5f66-4d0b-7ba4-e96eba601d3c,service gateway,gateway v1.8 rollout,,00000000-0000-4000-8000-000000000005
2026-11-26T11:30:00.000Z,2026-11-26T12:00:00.000Z,config,,,edge cache ttl 60→30,,00000000-0000-4000-8000-000000000009
```

Under P_shop, C + c10 + c11 gives this CSV (c11's text and tag are unchanged; nothing names
checkout@e2 in a structured field):

```text
at,end_at,kind,entity_id,entity,text,tags,id
2026-11-26T12:33:00.000Z,,config,854bc89f-5785-b55c-398b-87a03d62a7d9,service shop / payments,retries raised after checkout@e2 timeouts,rel:checkout-prod-us,00000000-0000-4000-8000-000000000011
2026-11-26T12:19:02.000Z,,config,854bc89f-5785-b55c-398b-87a03d62a7d9,service shop / payments,payments.retry 3→1,,00000000-0000-4000-8000-000000000006
2026-11-26T12:19:02.000Z,,config,854bc89f-5785-b55c-398b-87a03d62a7d9,service shop / payments,payments.psp.timeout 5000→2000,pr:4411,00000000-0000-4000-8000-000000000002
```

**Scopes** (clauses OR-ed; `b` binding ids, `a` attribute key → allowed values):

```text
P_eu    [{b:[e1]}]
P_shop  [{a:{service.namespace:[shop]}}]
S1      [{b:[e2]}, {a:{service.namespace:[shop]}}]                                   → checkout@e2, payments@e1
S2      [{b:[e1], a:{service.name:[checkout, gateway]}}]                             → checkout@e1, gateway@e1
S3      [{a:{k8s.namespace.name:[shop]}}]                                            → pod
S4      [{a:{service.namespace:[shop, '']}}]                                         → payments@e1
S5      [{a:{service.name:[checkout]}}]                                              → checkout@e1, checkout@e2
S6      [{b:[]}]                                                                     → 403 scope_denied, no SQL
T1      [{a:{deployment.environment.name:[prod], deployment.environment:[stage]}}]  → none (compiles to environment {deployment.environment.name: []})
T2      [{a:{deployment.environment.name:[prod, stage], deployment.environment:[prod, dev]}}] → env prod (environment {…name: [prod]})
T3      [{a:{k8s.cluster.name:[prod-eu-1]}}]                                         → cluster A, pod (cluster {k8s.cluster.uid: [prod-eu-1]}; node, namespace, workload, pod {k8s.cluster.name: [prod-eu-1]})
```

No scope above covers an organisation-wide row; full scope covers every row.

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:entity-id` | entity/entity_test.go + `wire/fixtures/json/entity-id.json` (full UUIDs) | The T12 §4.5 vectors; `{}`; name `''`; namespace `''`; an extra key (`service.version`); kind `spaceship`; a pod without its namespace; name `1` (a number); env `prod` vs `stage` | Every T12 §4.5 id; the rest → 400 `annotations.entity.invalid` | T12-010 |
| `itest:annotations-entity` | annotations/annotations_itest_test.go | C in org A; org B with a checkout@e1 change | `entity=` checkout@e1 → c1, `orgWideHidden` 3; checkout@e2 → c3; + payments@e1 → c6, c2, c1; checkout@e1 + `orgWide` → c7, c4, c1, c9; `kind` deploy + config → c6, c2, c1, c5, c9; `tag=pr:4411` → c2; payments@e1 + `flag` → `[]`; B sees none of A; bad parameters → the §5.9 400s | T24-030, T24-031 |
| `itest:annotations-scope` (+ `unit:change-scope-text`) | same (+ widgets/changeFeed/scope.test.ts) | C + c10 + c11; P_eu, P_shop, unset | Full → 10 rows; P_eu in pages of 3 → `[c11, c6, c2]`, `[c1, c5]`; P_shop → c11, c6, c2, with c11's text and tag unchanged and its entity `service shop / payments`; P_shop with `entity=` checkout@e1 → `[]` and the body has `"orgWideHidden": null`; c10 and checkout@e2 are in no structured field, page, cursor, count, CSV entity cell or Inspector fact (the free-text Tags fact excluded); unset → 403; P_shop creates checkout@e1 → 403 `annotations.entity.scope`, no entity → 403 `annotations.scope`, payments@e1 → 201 | T12-018 |
| `itest:annotations-scope-compile` | same | Env created via `deployment.environment`, via `deployment.environment.name` and via both (`prod`); `prod` vs `stage`. The entities table above; S1–S6, T1–T3 | Env → `f8bdae9d-e739-228c-dd0e-317933242944`, attrs `{deployment.environment.name: prod}` each time; the conflict → 400; each scope covers exactly the entities listed above on create, list, markers, delete and CSV; the SQL predicate = `ScopeCovers` on every entity; `entity` and `entity_key` are set or NULL together | T12-010, T12-018 |
| `itest:annotations-delete-scope` | same | P_shop deletes c1 (out of scope), an absent id, then c2; unset | c1 and the absent id → identical 404s, c1 kept, no audit; c2 → 204 and one audit event; unset → 403, no SQL | T12-018 |
| `itest:annotations-keyset` | same; `limit=3` | (a) p1; insert n1 and n2; p2; p3. (b) p1; p2; delete c5 alone; p3. (c) `limit=500` | (a) p1 c7, c4, c3 (`next` 12:21:30 / c3); p2 c6, c2, c1; p3 n2, c5, c9 (`next` null); n1 absent; no id twice. (b) p3 c9. (c) one page of 8. One SELECT per page | T24-032 |
| `itest:annotations-entity-validate` (I7) | same | Schema 5 with every row's `entity` and `entity_key` paired; apply the I7 migration | `pg_constraint.convalidated` true; an INSERT with only one of the two fails | T11-013 |
| `itest:annotations-old-binary` | `make itest-old-binary` (local; skips once the previous release has migration 5) | The **previous release** binary (schema 4) beside N on schema 5 | It starts; its answers have no `applied`; its create with `entity` → 400; N reads its rows with `entity: null` | T24-038, T11-015 |
| `unit:change-source` | widgets/changeFeed/source.test.tsx | A counting stub; a line panel and an unfiltered feed | Concurrent mounts → 1 request; a later mount → 0; Refresh → 1; a failed refresh → the markers' notice and the feed stale; a new window → the feed hides the old rows and the markers keep theirs; an `e` → its own key | T24-030 |
| `unit:change-pager` | widgets/changeFeed/pager.test.ts | C in pages of 3; cap 5; one page of 500; stubs 1 900 + 150 and 1 500 + 500 (`next` null, then set) | Pages of 3: 3 requests, 8 rows, "all 3 pages loaded · may have changed while loading", setsize −1; after p1 `truncated` + Load older, setsize −1; page 500 → `100 %`, setsize 8; cap 5 → c7, c4, c3, c6, c2, capped; 1 900 + 150 → 2 000, capped; 1 500 + 500 with `next` null → complete, with `next` set → capped | T24-032, T24-036 |
| `unit:change-snapshot` | same | 2 pages of 3; a refresh whose page 0 lacks c7 and renames c4 "INC-2041 resolved"; a failing refresh; a key change | `[c4′, c3, c6]` with the older request aborted, CSV and facts matching; failure → rows kept, stale; the old key never rendered | T24-033 |
| `unit:change-entity` | widgets/changeFeed/entity.test.tsx | `e` = [checkout@e1]; [checkout@e1, payments@e1]; [checkout@e2]; ["checkout"]; [] | c1 + "3 organisation-wide changes not shown"; the toggle → 4 rows; the set → 3 rows; e2 → c3; "checkout" → 8 rows + "Entity filter unavailable for this context"; [] → "All entities"; `orgWideHidden` null → no toggle or line | T24-031 |
| `unit:change-rows` | widgets/changeFeed/rows.test.ts | C, UTC | c1 `◆ Deploy · 12:10:00 · service checkout · prod-eu`; c3 `⚑ Feature flag · 12:21:30 · service checkout · prod-us`; c2 `⚙ Config change · 12:19:02 · service shop / payments`; c4 `Note · 12:23:00–12:40:00 · 17 min · organisation-wide`; c7's text literal; no colour | T24-034 |
| `unit:change-selection` | same | c1–c7 and c9 loaded | `{[], 12:19:00, 12:22:00}` → c3, c6, c2 selected, the others muted; a series key + that interval → no effect; foreign `change:…000000000099` → no effect; a series key + `change:…000000000004` + c4's interval → c4 only; the line panel bands and dims nothing; Enter/Space on c4 → inspect and focus on the heading; Load older of a 3-row page → "3 changes loaded" | T24-035, T24-036 |
| `unit:change-inspect` | inspector/model.test.ts | c4; c2; c2 + the filter `job=shop/web`; a service named `a"b\c` + LF + `d` | c4: heading `Note`, Duration `17 min`, Entity `organisation-wide`, Logs disabled ("This change has no service"); c2: Logs `{service_name="payments"}` over 12:18:02–12:20:02; with the filter `{service_name="payments",service_name="web"}` and the T25-010 conflict line; the odd name → `{service_name="a\"b\\c\nd"}` | T24-035 |
| `unit:change-mixed` | widgets/changeFeed/mixed.test.tsx | No `applied`: C; `[]`; an `e`; a create with `entity` → 400 | `coverage unknown`, setsize −1, no Load older; `[]` → empty, `coverage unknown`; `e` → "Filtering by entity needs a newer server", no rows; the create → "This server cannot record the entity yet", 1 request | T24-038 |
| `unit:change-table-csv` | widgets/changeFeed/table.test.ts | C | The C CSV above exactly: the T24-037 header; c7's text `"'=HYPERLINK(""a"")"`; c3 `3d1d4695-d757-d5f8-d6bf-c1b134128742`, `service checkout · prod-us`; facts `{'8 changes', 'Note: =HYPERLINK("a") at 12:30:00'}` | T24-037 |
| `unit:board-spec-change-feed` | boards/spec.test.ts, validate_test.go | `{}`; kinds `[]`, `['deploy','deploy']`, `['release']`; 9 tags; tag `Bad`; `entityMode:'fixed'`; `orgWide:'yes'`; `fieldConfig`; `thresholds`; `depth`; the Table 5-13 rows | Defaults `{kinds: all four, tags: [], entityMode: context, orgWide: false, showTags: true}`; `kinds.invalid`, `kinds.duplicate`, `kinds.invalid`; `tags.invalid` ×2; `entityMode.invalid`; `board.json.type`; `board.json.unknownKey` ×3; TS = Go; the version before upcasts; never auto-picked | T24-037, VIZ-057, VIZ-065 |
| `unit:import-change-feed` | import/changeFeed.test.ts | J1–J4 (below) | Options and notes exactly as listed | T24-039 |
| `e2e:widget-change-feed` | e2e/widgets.spec.ts | Stub BFF, C in pages of 3, a line panel, `?e=bb7487bd-100d-a998-e0f0-3c65f11da1a7` | 1 row + "3 organisation-wide changes not shown"; the toggle → 4 rows; without `e`: Load older ×2 → 8 rows, the paged text, setsize −1; Enter on c4 → the Inspector `Note` and the band on the line panel; Esc ×2 clears and closes; Refresh → 1 request | VIZ-053 |
| `e2e:widget-lists-a11y` (amended), `golden:widget-gallery` (amended) | e2e/ | + Change feeds in the loading, empty, more, capped, paged, stale and old-server states; gallery pages `widget-change-feed`, `widget-change-feed-entity`, `widget-change-feed-states`, `widget-change-feed-inspector` | axe clean in each; setsize per T24-036; CI baseline (0.1, ≤ 0.2 %) | T24-036, VIZ-069 |

Import cases for `unit:import-change-feed` (Annotations list options → `changeFeed` options and
notes, in order; every result has all kinds, `entityMode: 'context'` and `orgWide: false`):

```text
J1 {}                                                       → tags [], showTags true; no notes
J2 {tags:['Deploy','deploy','a b'], onlyFromThisDashboard:true, limit:10, showTags:false}
                                                            → tags ['deploy'], showTags false; "Duplicate tag ‘deploy’ dropped",
                                                              "Tag ‘a b’ dropped: not a valid tag", "The change feed lists the organisation's changes",
                                                              "Paged by the change feed"
J3 {tags:'x', showTags:'no', onlyFromThisDashboard:1, onlyInTimeRange:false, navigateToPanel:true}
                                                            → tags [], showTags true; "Option tags malformed: default used",
                                                              "Option showTags malformed: default used", "Option onlyFromThisDashboard malformed: default used",
                                                              "The change feed lists the board's time range", "Option navigateToPanel not mapped"
J4 {tags:['t0','t1',…,'t9'], onlyInTimeRange:'yes'}         → tags t0–t7, showTags true; "Tag ‘t8’ dropped: at most 8 tags",
                                                              "Tag ‘t9’ dropped: at most 8 tags", "Option onlyInTimeRange malformed: default used"
```

Report-only: `bench:widget-lists` (a 2 000-row Change feed ≤ 50 ms p95). Every gate is in
[T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

### 10.3 Part E step 1a tests

Written first in E1 (§11); all fail today: nothing exists yet. Every value below was computed by a
reference implementation of T24-080 to T24-087.

**Gazetteer T** (`vis/geo/fixtures/gaz-t.json`; x,y as stored):

```text
country GE GEO Georgia 4350,4200 · JP JPN Japan 13800,3600 · XA XAA Atlantis 0,100 · XB XBB Atlantis 100,100 ·
        ZZ ZZZ "Zed North" 500,500 · ZZ ZZZ "Zed South" 500,-500
region  KZ-ALA Almaty 7690,4325 · KZ-ALA "Almaty City" 7695,4328 · US-CA California -12000,3700 · XX-DUP Dupland 4000,4000
iata    QQQ Alpha 100,100 · QQQ Beta 200,200 · SIN Singapore 10399,135
cloud   aws eu-west-1 Dublin -625,5334 · aws eu-west-2 London -12,5150 · aws us-east-1 "Washington, D.C." -7701,3890 ·
        azure westeurope Amsterdam 491,5235 · gcp europe-west1 Mons 394,5045 · ta xx-dup-1 T1 1000,1000 ·
        tb xx-dup-1 T2 2000,2000 · tc xx-dup T3 3000,3000
```

**Fixture L** (auto mode, gazetteer T; L–C), **E** (explicit modes) and **G0** (no gazetteer). Each
expected value is the complete object (`toStrictEqual`): `P(source, key, code, provider, name, lat,
lon[, dLat×dLon])` is `placed` (`-` = null, `cell` null unless given); `I(reason, key)` is
`invalid`; `U(source, key, value)` is `unknownCode`; `M(key, provider, [candidates])` is
`providerMismatch`; `A(reason, [candidates])` is `ambiguous`; `N` is `noLocation`.

```text
L1  cloud_region=eu-west-1  P(cloud, cloud_region, eu-west-1, aws, Dublin, 53.34, -6.25)
L2  cloud.region=EU-WEST-2  P(cloud, cloud.region, eu-west-2, aws, London, 51.5, -0.12)
L3  cloud_provider=gcp cloud_region=europe-west1  P(cloud, cloud_region, europe-west1, gcp, Mons, 50.45, 3.94)
L4  cloud_provider=gcp cloud_region=eu-west-1  M(cloud_region, gcp, [aws eu-west-1])
L5  cloud_region=xx-dup-1  A(providers, [ta xx-dup-1, tb xx-dup-1])
L6  cloud_provider=ta cloud_region=xx-dup-1  P(cloud, cloud_region, xx-dup-1, ta, T1, 10, 10)
L7  cloud_region=mars-north-1  U(cloud, cloud_region, mars-north-1)
L8  cloud.region=eu-west-1 cloud_region=eu-west-2  A(keyCollision, [cloud.region=eu-west-1, cloud_region=eu-west-2])
L9  cloud.region=eu-west-1 cloud_region=eu-west-1  P(cloud, cloud.region, eu-west-1, aws, Dublin, 53.34, -6.25)
L10 lat=0 lon=0  P(coords, lat, -, -, -, 0, 0)
L11 lat=40.7128 lon=-74.0060  P(coords, lat, -, -, -, 40.7128, -74.006)
L12 lat=91 lon=0 → I(coords, lat) · L13 lat="1.5\n" lon=2 → I(coords, lat) · L33 lat=1 lon=180.0001 → I(coords, lon)
L14 latitude=10  I(incompleteCoords, latitude)
L15 lat=10 latitude=11 lon=5  A(aliasConflict, [lat=10, latitude=11])
L16 lat=10 latitude=10.0 lon=5 → P(coords, lat, -, -, -, 10, 5) · L32 lat=-0 lon=180 → P(coords, lat, -, -, -, 0, 180)
L17 lat="" lon="" cloud_region=eu-west-1  P(cloud, cloud_region, eu-west-1, aws, Dublin, 53.34, -6.25)
L18 geohash=u4pruydqqvj  P(geohash, geohash, u4pruydqqvj, -, -, 57.64911063015461, 10.407439693808556, 1.341104507446289e-06×1.341104507446289e-06)
L19 geohash=U4PA  I(geohash, geohash)
L20 geo_country_iso_code=jp  P(country, geo_country_iso_code, JP, -, Japan, 36, 138)
L21 country=atlantis  A(name, [XA Atlantis, XB Atlantis])
L22 country_code=JP country=Georgia  A(aliasConflict, [country=Georgia, country_code=JP])
L23 geo_region_iso_code=us-ca  P(region, geo_region_iso_code, US-CA, -, California, 37, -120)
L24 region_iso_code=KZ-ALA  A(sharedCode, [KZ-ALA Almaty, KZ-ALA Almaty City])
L25 airport=QQQ  A(sharedCode, [QQQ Alpha, QQQ Beta])
L26 region=xx-dup  A(regionOrCloud, [XX-DUP Dupland, tc xx-dup])
L27 region=eu-west-1  P(cloud, region, eu-west-1, aws, Dublin, 53.34, -6.25)
L28 service=web → N · L31 cloud_provider=oci cloud_region=us-ashburn-1 → U(cloud, cloud_region, us-ashburn-1)
L34 country=ZZ → A(sharedCode, [ZZ Zed North, ZZ Zed South]) · L35 country=zzz → the same
C1  Service=a service=b cloud_region=eu-west-1  P(cloud, cloud_region, eu-west-1, aws, Dublin, 53.34, -6.25)  (collision not read)
C2  iata=SIN airport=ZZZ → U(iata, airport, ZZZ) · C9 iata=ZZZ airport=QQQ → U(iata, iata, ZZZ)
C3  iata=SIN airport=QQQ  A(sharedCode, [QQQ Alpha, QQQ Beta])
C4  lat=10 latitude=x lon=5 → I(coords, latitude) · C5 lat=91 lon=0 cloud_region=eu-west-1 → I(coords, lat) (no fallback)
C6  cloud_provider=tz cloud_region=xx-dup-1  M(cloud_region, tz, [ta xx-dup-1, tb xx-dup-1])
C7  cloud.provider=aws cloud_provider=gcp cloud_region=eu-west-1  A(keyCollision, [cloud.provider=aws, cloud_provider=gcp])
C8  geohash=u4pr cloud_region=eu-west-1  P(geohash, geohash, u4pr, -, -, 57.568359375, 10.37109375, 0.17578125×0.3515625)
E1  coords{y,x}: y=0 x=0 → P(coords, y, -, -, -, 0, 0) · E2 y=1 → I(incompleteCoords, y) · E3 lat=1 lon=2 → N · E4 y=1 x=east → I(coords, x)
E5  lookup{site, iata}: site=SIN Site=LHR  A(keyCollision, [Site=LHR, site=SIN])
E6  lookup{state, region, US}: state=CA and E7 state=US-CA → P(region, state, US-CA, -, California, 37, -120)
E8  geohash{gh}: gh=u4pa → I(geohash, gh) · E9 {} → N
G0  g = null: cloud_region=eu-west-1 → gazetteerUnavailable; lat=1 lon=2 → P(coords, lat, -, -, -, 1, 2)
```

**Build fixtures** (`tools/geo/fixtures/`; sources in lon/lat degrees; `polarFeatures` `["ATA"]`
unless given). A square (x0,y0)-(x1,y1) is the ring (x0,y0), (x1,y0), (x1,y1), (x0,y1); a hole
written as a square is that ring reversed. Outputs are the exact `basemap.json` content (compact; RT
in full, the others by member):

```text
RT        AA AAA Alpha: square (0,0)-(10,10) with hole (2,2)-(4,4); triangle (20,0),(30,0),(25,5). BB BBB Beta: (10,0)-(15,10)
          → {"v":1,"q":100,"countries":[["AA","AAA","Alpha",[[[0,0,1000,0,0,1000,-1000,0],[200,200,0,200,200,0,0,-200]],
            [[2000,0,1000,0,-500,500]]]],["BB","BBB","Beta",[[[1000,0,500,0,0,1000,-500,0]]]]],
            "coast":[[1000,1000,-1000,0,0,-1000,1000,0],[200,200,0,200,200,0,0,-200,-200,0],[2000,0,1000,0,-500,500,-500,-500],
            [1000,0,500,0,0,1000,-500,0]],"border":[[1000,0,0,1000]]}; report empty
ROT       AA AAA Alpha (10,10),(10,0),(0,0),(0,10) (clockwise)
          → countries [["AA","AAA","Alpha",[[[0,0,1000,0,0,1000,-1000,0]]]]], coast [[0,0,1000,0,0,1000,-1000,0,0,-1000]], border []
HOLECLAMP PP PPP Polar: outer (-10,80)-(10,89), hole (-5,82)-(5,85); polarFeatures ["PPP"]
          → countries [["PP","PPP","Polar",[[[-1000,8000,2000,0,0,505,-2000,0],[-500,8200,0,300,1000,0,0,-300]]]]],
            coast [[-1000,8505,0,-505,2000,0,0,505],[-500,8200,0,300,1000,0,0,-300,-1000,0]], border []
          with hole (-5,82)-(5,88) (clamped onto the outer) → fails "PPP: hole not strictly inside its outer ring"
COLLINEAR QQ QQQ Square: outer (0,0)-(30,30), holes (2,2)-(8,8) and (8,4)-(12,6) (a shared x = 8 segment) → fails
          "QQQ: hole not strictly inside its outer ring"; the ×100 asset
          [[[0,0,3000,0,0,3000,-3000,0],[200,200,0,600,600,0,0,-600],[800,400,0,200,400,0,0,-200]]] → null
NESTED    QQ QQQ Square: outer (0,0)-(30,30), holes (2,2)-(20,20) and (5,5)-(8,8) → fails as COLLINEAR; the ×100 asset
          [[[0,0,3000,0,0,3000,-3000,0],[200,200,0,1800,1800,0,0,-1800],[500,500,0,300,300,0,0,-300]]] → null
POLE      PP PPP Polar: outer (-10,80)-(10,89), polarFeatures ["ATA"] → fails "PPP: vertex at |lat| >= 85.0511 outside polarFeatures"
ANT       AQ ATA Antarctica (180,-90),(-180,-90),(-180,-70),(0,-60),(180,-70)
          → countries [["AQ","ATA","Antarctica",[[[-18000,-8505,36000,0,0,1505,-18000,1000,-18000,-1000]]]]],
            coast [[18000,-7000,-18000,1000,-18000,-1000]], border []
SPAN      XX XXX Span (170,0),(-170,0),(-170,10),(170,10) → fails "XXX: edge spans more than 180 degrees of longitude"
ENCLAVE   ZA ZAF South: (0,0)-(30,30) with hole (10,10)-(20,20); LS LSO Enclave: (10,10)-(20,20)
          → countries [["LS","LSO","Enclave",[[[1000,1000,1000,0,0,1000,-1000,0]]]],
            ["ZA","ZAF","South",[[[0,0,3000,0,0,3000,-3000,0],[1000,1000,0,1000,1000,0,0,-1000]]]]],
            coast [[0,0,3000,0,0,3000,-3000,0,0,-3000]], border [[1000,1000,1000,0,0,1000,-1000,0,0,-1000]] (once)
SLIVER    AA AAA Alpha: (0,0)-(1,1) + triangle (5,5),(5.001,5),(5,5.001)
          → countries [["AA","AAA","Alpha",[[[0,0,100,0,0,100,-100,0]]]]], coast [[0,0,100,0,0,100,-100,0,0,-100]], border [];
            report "dropped sliver polygon AAA (3 points, 5.0e-07 sq deg)"
COLLAPSE  SL SLV Sliver: (0,0),(0.001,0),(0,0.001) only → fails "SLV: largest polygon collapses under quantisation"
BIGDROP   AA AAA Alpha: (0,0)-(1,1) + (20,20),(30,20),(30,20.00003) → fails "AAA: polygon of 1.50e-04 sq deg collapses"
L-holes   LL LLL Ell: outer (0,0),(20,0),(20,10),(10,10),(10,20),(0,20) and one hole:
          OK (2,12),(2,18),(8,18),(8,12) → countries [["LL","LLL","Ell",[[[0,0,2000,0,0,1000,-1000,0,0,1000,-1000,0],
            [200,1200,0,600,600,0,0,-600]]]]], coast [[0,0,2000,0,0,1000,-1000,0,0,1000,-1000,0,0,-2000],
            [200,1200,0,600,600,0,0,-600,-600,0]], border []; its ×100 asset decodes
          CORNER (12,12),(12,18),(18,18),(18,12) (in the missing corner), CROSS (6,6),(6,16),(16,6) (edges cross), TOUCH (5,5),(5,15),(15,5)
            (through the reflex vertex) → each fails "LLL: hole not strictly inside its outer ring"; each ×100 asset → null
```

Every report is empty except SLIVER's. Building any fixture twice gives identical bytes. On the real
basemap, ZAF's one hole costs 880 pair tests.

**Round trip:** RT's output decodes; Alpha's first outer is (0,0), (1000,0), (1000,1000), (0,1000).

**Malformed basemaps** (each → null): M1 `null`; M2 `[]`; RT with: M3 `v` 2; M4 an extra key
`"x": 1`; M5 Alpha's outer `[0,0,1000,0,0,1000,-1000]` (odd length); M6 Alpha's triangle
`[2000,0,1000,0,-1000,0]` (2 distinct points); M7 Alpha's hole `[200,200,200,0,0,200,-200,0]`
(counter-clockwise); M8 Alpha's hole `[1200,200,0,200,200,0,0,-200]` (outside its outer); M9 Alpha's
triangle `[2000.5,0,1000,0,-500,500]` (a float); M10 Beta's outer `[1000,0,500,0,0,8506,-500,0]`
(y 8506); M11 coast 0 `[-9000,100,18001,0]` (Δx 18001); M12 Beta's polygons `[]`; M13 Alpha's a2
`aa`; M14 border 0 `[1000,0]` (1 point); M15 coast 0 `[-18000,-8505,36000,0]` (an edge of 36000 on
y = −8505); and the ×100 assets of CORNER, CROSS, TOUCH, COLLINEAR and NESTED.

**Malformed gazetteers** (each → null), from the valid G0 `{"v":1,"q":100,"country":[["JP","JPN",
"Japan",13800,3600]],"region":[["US-CA","California",-12000,3700]],"iata":[["SIN","Singapore",10399,
135]],"cloud":[["aws","eu-west-1","Dublin",-625,5334]]}`: G1 country `["JP","JPN","Japan",13800]` (4
fields); G2 region `usca`; G3 IATA x 18001; G4 provider `AWS`; G5 IATA place `""`; G6 no `cloud`;
G7 country y 36.5 (a float); G8 `"x"`.

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:geo-locate` | client/src/vis/geo/locate.test.ts | Gazetteer T; L, C, E, G0 | each object exactly (`toStrictEqual`) | VIZ-045, T24-080–084 |
| `unit:geo-geohash` | client/src/vis/geo/geohash.test.ts | strings | the L18 and C8 values; `''`, 13 characters, `u4pa` → null | T24-083 |
| `unit:geo-decode` | client/src/vis/geo/assets.test.ts | the build outputs; the malformed assets | the valid outputs decode (the round trip); each malformed asset → null | T24-087 |
| `unit:geo-build` | tools/geo/test_build.py | the build fixtures | the exact outputs and failures above; building twice → identical bytes | T24-086 |
| `unit:geo-gazetteer-build` | tools/geo/test_build.py | DBF and CSV fixtures | France + Clipperton (one alpha-2) → FR France; two ZZ features, neither main → both; `-99` dropped; a repeated region → 2 rows; no name → the code; a heliport, an unscheduled airport and `ab` left out; a bad `ne_id` → the build fails | T24-085 |
| `unit:geo-assets` | client/src/vis/geo/assets.test.ts | the bundled files | they decode; 238 countries, ≥ 4 300 regions, ≥ 3 200 IATA rows; aws, gcp and azure rows; `cloud_region=eu-west-1` → L1's object; Mons and Amsterdam placed; SHA-256 = the manifest | VIZ-045, VIZ-046 |
| `unit:geo-load` | client/src/vis/geo/assets.test.ts | a stub: ok, 404, bad JSON, invalid | 2 requests, then 0 on later calls; a failure nulls that asset only; one debug line | T24-087 |
| `ci:geo-data` | CI client job | the committed assets | SHA-256 = the manifest; both decode | T24-087 |
| `ci:bundle-size` (amended) | client/bundle-budgets.json | both builds | `geo-basemap` ≤ 40 000 B, `geo-gazetteer` ≤ 104 000 B, total ≤ 1 000 000 B | T24-087 |

Every gate is in [T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

### 10.4 Part E step 1b tests: the frame

Written first in E2 (§11); all fail today: nothing is built yet. Every value below was computed by a
reference implementation of T24-088 to T24-095.

**Fixture G** (an instant result, unit ms; thresholds 150 watch, 200 degraded, 250 failing where a
test says so; gazetteer T of §10.3; plot 1024 × 512 CSS px):

```text
k01 cloud_region=eu-west-1 120 · k02 cloud_region=eu-west-2 95, and k02 again 97 · k03 cloud_provider=gcp cloud_region=europe-west1 210
k04 cloud_region=westeurope 180 · k05 geo_country_iso_code=jp 60 · k06 iata=sin 40 · k07 lat=40.7128 lon=-74.0060 300
k08 geohash=u4pruydqqvj 75 · k09 cloud_region=mars-north-1 50 · k10 lat=91 lon=0 NaN · k11 cloud_region=xx-dup-1 20
k12 lat=10 lon=10 NaN · k13 lat=-89.9 lon=0 5 · k14 lat=0 lon=0 -30 · k15 service=web 1 · k16 lat=20 lon=20 +Inf
k17 lat=25 lon=25 5e-300 · k18 lat=40.7128 lon=-74.0060 site=b 150
```

**Expected:**

```text
statuses value: k10, k12 noValue; k16 infinite; k17 outOfRange. state: k10, k12, k16, k17 unknown. location: k09 unknownCode,
         k10 invalid, k11 ambiguous, k15 noLocation. draw: k09, k10, k11, k15 notPlaced; k13 outsideMap; k12, k16, k17 excluded;
         k01–k08, k14, k18 shown. k02 = 97 (1 dup, 1 conflict). No thresholds: all states null
         with thresholds: k01, k02, k05, k06, k08, k09, k11, k13, k14, k15 ok; k03 degraded; k04, k18 watch; k07 failing
groups   k01 backDiagonal 1 · k02 horizontal 2 · k03 vertical 3 · k04 dots 4 · k05 crossHatch 5 · k06 checker 6 · k07 dashes 7 ·
         other (11) grid: k08–k18 names, key order; legend `other (11): {geohash="u4pruydqqvj"}, {cloud_region="mars-north-1"}, …` (8), `+3 more`
radii    M 300: k07 20, k03 16.733, k04 15.492, k18 14.142, k01 12.649, k02 11.372, k08 10, k05 8.944, k06 8, k14 8.
         min 2 max 4: patterned → 8 for 0, 75, 300, all-zero and fixed; one group → 2, 2, 4, all-zero 2, fixed 4
fit      (33.388480626497824, 31.996999999999986, 2.6218728064801105), Z 2; bounds (−84.97182758620691, −22.432008240607896,
         148.9658275862069, 68.035106748586)
marks    draw: cluster:k03 [k01,k02,k03,k04,k08] (389.19,154.65) r14 · cluster:k07 [k07,k18] (48.00,215.77) r14 · k05 (976.00,242.09)
         r8.944 · k14 (371.94,411.20) r8 · k06 (827.13,405.29) r8; keyboard: cluster:k03, cluster:k07, k05, k06, k14
levels   Z3 cluster:k03 3, cluster:k07 2 · Z4 both 2 · Z5, Z6 cluster:k07 2 only; cluster:false → cluster:k07 only, 9 marks
pick     (389.19,154.65) cluster:k03 · (979.00,242.09) k05 · (374.94,411.20) k14 · (830.13,405.29) k06 · (700,60) none ·
         tie: k20, k21 (r10, rank 0, |v| 5) at (100,100) → k21 · crossfade: old-only mark at (100,100) → none
camera   zMin 0 (160×120: inset 12, fit (33.388480626497824, 31.996999999999986, 0)), 2 (1024×512), 1.2288186904958809 (300×600),
         14 (5e6×100: fit (33.388480626497824, 0, 14), letterboxed); 4096² fit z 4.729676096014625; one row on 40 000² → (0, 0,
         7.28771237954945); persisted (50,5,1) → (50, 0, 2) on 1024×512, (50, 0, 14) on 5e6×100;
         wheel −100 at (10,256) on (0,0,2) → (0, −31.99118974975306, 2.2885390081777928), drift 0; wheel +100 at (10,10) on (60,−150,3) →
         (54.85601631006218, −70.07375176558472, 2.7114609918222072), drift 281.27 px; 100 steps i = 0…99 at (100+8i, 100+3i),
         deltaY 60·(−1)^i on (50,5,4): every anchor drift < 1e−9, no containment, final (48.907393645219365, 9.482311188337547, 4)
project  lon 179.9 → u 0.9997222222222222; −179.9 → 0.000277777777777762; 180 → −180 → u 0; lat 85.0511 → v 9.26703349835023e−07;
         (0.5, 0) → lat 85.0511287798066; (0,179.9,4) → centre lon 135, bounds (90, −21.943045533438177, 180, 21.943045533438177)
meter    + truncated, 2 warnings: truncated · limited (2 warnings) · 3 not placed · 1 ambiguous · 1 outside the map ·
         4 without a usable value (2 missing, 1 infinite, 1 out of range) · 1 duplicate series combined; 1 conflicts (max kept);
         5 003 rows: showing 5,000 of 5,003; kept min, max
order    UTF-16: kA < k_b < ka < k+U+00E9 < k+U+1F600 (D83D DE00) < k+U+FFFD
```

The radii use the default size (min 4, max 20); a point (x,y) is in CSS px of the plot.

**Group fixtures** (`groupBy: env` for H to Q):
- **H:** h0…h8 with env e0…e8 at lat = lon = 10·j, value 10(j + 1) → the patterns of T24-090, colours
  0–6 and `other (2)` [e7, e8]; with h9 (no `env`) added → `other (3)` [e7, e8, env absent].
- **A:** a1 no `env`, a2 env=`env absent`, a3 env=prod → `env absent` (`{present:false}`,
  backDiagonal, colour 0, [a1]), `"env absent"` (horizontal, 1, [a2]), `prod` (vertical, 2, [a3]).
- **O:** q0…q9 with env e0…e6, `other (2)`, e8, e9 → `other (3)` (`{other}`, [q7, q8, q9]), members
  [`"other (2)"`, e8, e9].
- **Q:** p1 env=`env absent`, p2 env=`"env absent"` (with the quotes), p3 no `env` → `"env absent"`
  [p1], `"\"env absent\""` [p2], `env absent` [p3].
- **D** (no groupBy): d1 `{lat="1", lon="2"}`, d2 the same + `__name__=""` → `{lat="1", lon="2"} ·
  __name__ absent` [d1], `{lat="1", lon="2"} · __name__=""` [d2].
- **U** (the final pass only): u1, u2 named `A` {x=1}, u3 `A (1)`, u4 the aggregate `other (2)`, u5
  `other (2)` → `A (2)`, `A (3)`, `A (1)`, `other (2)`, `other (2) (1)`.
- **H′** = H with h3 NaN and h8 +Inf → h3, h8 `excluded`; the groups are kept; the legend shows `e3
  (not shown)` and `other (2): e7, e8`; shown h0–h2, h4–h7. One row only → `solid`, no legend.
- **S** (`labels: none`): s1 prod 100 at (10,10), s2 prod 300 at (10,20), s3 dev 50 at (20,10) → s1, s2
  backDiagonal 0, s3 horizontal 1; with thresholds: s1 ok; s2 failing outlines and glyphs; one fill.
  G with thresholds: k03 degraded, k04 watch, k01 ok; `colour: 'state'` → state fills.

**Invalid row sets** (G mutated) → the `validateGeoRows` detail: k01 and k02 swapped → `order`; k12
`ok` → `value`; k05 state `failing` → `state`; no thresholds but k12 `unknown` → `state`; k13 or k12
draw `shown` → `draw`; k01 group 9, groups[0] pattern `dots`, or the other members without k08's id →
`group`; `coverage.geo.notPlaced` 2 → `coverage`.

**Cap:** c0000…c5002 with lat (i mod 100) − 50, lon 3⌊i/100⌋ − 75, value i, no thresholds.

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:geo-rows` | vis/geo/frame.test.ts | G with and without thresholds; the invalid sets | the statuses block; G → null; each invalid set → its detail | T24-089 |
| `unit:geo-identity` | vis/geo/frame.test.ts | G, H (+h9), H′, A, O, Q, D, U, one row, S | the groups block (k08–k18 → other (11)); the rest as written (ids, labels, patterns, colours, keys; labels distinct) | VIZ-067, T22-004, T24-090 |
| `unit:geo-basemap-draw` | engine/canvas2d/geo/basemap.test.ts | 1a's RT and ANT outputs (§10.3), apart; a recording context | RT: Alpha's square is one `fill('nonzero')` path, winding (1,1) ±1 and the hole (3,3) 0; 4 coast and 1 border stroke (once, 0.5 px). ANT: 1 coast, 0 border, no stroke on y = ±8505 or x = ±18000 | VIZ-046, T24-091 |
| `unit:geo-radius-project` | engine/controller/geo/marks.test.ts | G; min 2 max 4; the projections | the radii block; the project block ±1e−12 | T24-090, T24-091 |
| `unit:geo-camera` | engine/controller/geo/camera.test.ts | the camera block; a 159 × 200 plot | the camera block; `tooSmall` | INT-002, T24-091 |
| `unit:geo-ownership` | engine/controller/geo/camera.test.ts | G at fit, no commit; data k05, k06; pan +100 px (a commit); data G; a new title; view (10,10,4); view = the camera | refit (19.59791091785336, 120.995, 3.971846219329485); lon 129.95726302107312, lat and zoom the same; kept; kept; moves; no move | T24-091 |
| `unit:geo-keys-engine` | engine/controller/geo/input.test.ts | G, the surface focused, `setFocusMark('k05')`; every case from fit | `+` → z 3.6218728064801105, k05 fixed; `+` then `-` → 2.6218728064801105; `0` → fit; Shift+← → −256 px, Shift+→ stops at the world's east edge (+135.84 px, contained); a wheel deltaX 100 → lon 54.84247413793099; a `null` wheel, other elements → none | T24-091 |
| `unit:geo-inertia` | engine/controller/geo/input.test.ts | G at fit, fake clock; a fling (pointer released while moving); a fling then a pointer-down during the decay | the view keeps panning after release with the shared T02 inertia and settles in 300 ± 50 ms with no overshoot; exactly one `geoCommit` (`gesture: 'pan'`), emitted after it settles, none during the decay; the pointer-down stops the motion on the next frame and the gesture still commits once | INT-003, T24-091 |
| `unit:geo-host` | charts/GeoMapFrame.test.tsx | G; (a) commit C; (b) option view (10,10,4); (c) commit D; (d) option null; (e) commit E and a new title; (f) an engine swap | 3 subscriptions; spec.view (a) C, (b) (10,10,4), moves, (c) D, (d) null, refits, (e) E kept; (f) 3 disposers, frame 2 at E, which gets `setFocusMark('k05')`; (b) then a swap → (10,10,4); no event after dispose | T24-088 |
| `unit:geo-select-hover` | charts/ChartFrame.inspect.test.tsx | G at fit, a T25 host | `select` at cluster:k03 → `{type:'geo', kind:'cluster', id:'cluster:k03', rows k01–k04, k08}` and those keys selected; `hover` on k05 → `{geo_country_iso_code="jp"}` / `60 ms · ok` / `Japan` | INT-034, T24-088 |
| `unit:geo-plan` | vis/geo/plan.test.ts | (a) loading, no basemap; (b) failed, 0 rows; (c) G with k12 `ok`, no basemap; (d) G, no basemap; (e) G at 100 × 100; (f) 0 rows; (g) k09–k11, k15; (h) G | loading; error; invalid `value`; mapDataUnavailable with 18 rows; tooSmall; empty; noneShown; ok | T24-088 |
| `unit:geo-marks` | engine/controller/geo/pick.test.ts | G at fit and Z2–6, `cluster:false`, shuffled input; the tie; the crossfade; the strings | at fit: the draw ids, members, centres ±0.01 px, radii ±0.001, the keyboard order, each pick → its id; the tie → k21; the old-only crossfade point → none; Z2–6: cluster ids and member counts; the order line | VIZ-044, T24-091 |
| `unit:geo-coverage` | vis/reduce.test.ts | G, `truncated`, the warnings `shard 3 timed out` and `series limit 500 reached`; Cap | the meter block; Narrow; the popover lists the 2 warnings; Cap: c0000 (min) and c5002 (max) kept, c0001–c4998 kept, c4999–c5001 `capped` | VIZ-027, T22-006 |
| `unit:board-spec-geomap` | boards/spec.test.ts, validate_test.go | `{}`; size {min:1}, {min:5,max:4}; `colour:'state'` without thresholds; groupBy `1x`; view zoom 15, lon 180; `depth` | the defaults; size ×2, colour, groupBy and view ×2 invalid; unknownKey; TS = Go | VIZ-057, §5.15 |
| `e2e:geomap-offline` | e2e/geomap.spec.ts | no rows, view (53.34, −6.25, 6), 1024 × 512, dark, every other origin aborted | `getImageData` at DPR 1: (432,256) = dark `map-land`, (560,256) = `map-water`, ±2 per channel; 0 requests to another origin | VIZ-046 |
| `golden:gallery` (amended) | e2e/gallery | the pages `geomap-markers` (G), `geomap-groups` (H) and `geomap-states` (G with thresholds) × the 3 themes | the CI baseline | VIZ-069, VIZ-067 |

Report-only: `bench:geomap-markers` (5 000 rows, 10 s of pan and zoom, Chromium at 1×): p95 ≤ 16 ms.
Every gate is in [T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

### 10.5 Part E step 1b tests: interaction

Written first in E2 (§11), with §10.4; all fail today.

**Fixtures** (with §10.4's G, unit ms with thresholds, plot 1024 × 512, at fit):
- **G3** = k01, k05, k06 of G.
- **O2** = §10.4's O + q10 {env=e8, pod=b}.
- **S1** = s1 and s2 of S (env=prod, one group).
- **F1** (no thresholds): x1 lat=1 lon=1 −30, x2 lat=2 lon=2 10, x3 lat=3 lon=3 10.
- **R** (a range result, `reducer: last`): r1 lat=1 lon=1 (0 s: 100, 60 s: 300, 120 s: 250) and r2 lat=2 lon=2
  (0 s: 10, 60 s: 20, 120 s: 30).
- **V:** v1 service_name=checkout and v2 service_name=payments, both cloud_region=eu-west-1.
- **M12:** m01–m12 with lat=10 lon=10, pod p01–p12, value i.
- **N** (`groupBy: env`, unit ms, no thresholds): n00–n18 with env e0–e18; n19–n29 with env e18 and pod
  p19–p29; value i.
- **X** (no thresholds): x1 cloud_region=`a,b` 1; x2 cloud_region=`say "hi"` 2; x3 cloud_region=`x` +
  LF + `y` 3; x4 cloud_region=`=1` −4.

```text
list      cluster:k03 "Cluster of 5, near Mons, worst degraded" · cluster:k07 "Cluster of 2, near 40.7128, -74.0060, worst failing" ·
          k05 "{geo_country_iso_code="jp"}, 60 ms, ok, Japan" · k06 "{iata="sin"}, 40 ms, ok, Singapore" ·
          k14 "{lat="0", lon="0"}, -30 ms, ok, 0.0000, 0.0000"; setsize −1. {[k03]} → item 1 "…, 1 selected"; {[k05]} → "…, Japan, selected"
G3        fit (30.733727227695173, 65.875, 3.1774065828117646): k01 (48.00,56.74), k05 (976.00,215.41), k06 (757.20,455.26), setsize 3;
          pan 200 px north → k06 out, list k01, k05, setsize −1; pan until none in view → placeholder "No marks in view · Fit"
repair    (a) cluster:k03, view (50.45, 3.94, 5) → list k01, k04, k02, k03 → k03; (b) k01, back to fit → cluster:k03;
          (c) k06, refetch without k06 (camera kept) → cluster:k03, cluster:k07, k05, k14 → k14, "{iata="sin"}, 40 ms, ok, Singapore is no longer shown"
keys      on button k05: Shift+← → centre −256 px (Shift+→ is contained at +135.84 px); `+` → zoom 3.6218728064801105, k05 fixed; `0` → fit; a parent sees none
brush     (300,80)–(500,200) at fit → select [k01, k02, k03, k04, k08]; `[]` → no change
targets   O2 legend `other (3)` → select [q7, q8, q9, q10], aggregate members `"other (2)"` {env: "other (2)"} [q7] · `e8` {env: "e8"} [q8, q10]
          · `e9` {env: "e9"} [q9]; entry `e8` → select [q8, q10], group `group:{"present":true,"value":"e8"}` rows `{env="e8", lat="9", lon="9"}` (q8),
          `{env="e8", lat="11", lon="11", pod="b"}` (q10); its entry q10 → marker q10. A refetch dropping q10: group still lists q8, q10
select    G {[k10]} (not placed): relevant → all 5 marks `dimmed`, table row k10 highlighted "Not placed"; {[k03]} → cluster:k03 ring
          "1 selected", the rest dimmed; {[zz, k10]} as {[k10]}; {[zz]} → nothing dims
members   M12 → cluster:m12, shown m01–m08 + "+4 more", resolve `geo:cluster:m12` → 12; entry 10 → marker m11; N `other (12)` → e7–e14
          + "+4 more" → 12; entry 11 (e18) → group with n18–n25 + "+4 more" → 12; its entry 9 → marker n27; a refresh removing
          m11, n27: entries 10, 9 act on the snapshot
inspect   cluster:k03 members k01–k04, k08, Values 75 ms – 210 ms; table k10 → No value, `invalid: coords lat`, Not placed
facts     G {current: {text: "300 ms", series: '{lat="40.7128", lon="-74.0060"}'}, change: null, extent: {-30, 300}, baselineRatio: null};
          G with k13 = 900 → current "900 ms" '{lat="-89.9", lon="0"}' (off the map), extent {-30, 900}; F1 → "10 ms" x2 (higher value, lower
          key), extent {-30, 10}; Cap (§10.4) extent {0, 5002}; R → "250 ms" r1, change {from "100 ms", to "300 ms", atMs 60000}
```

In the list block the cluster of 5 is k01–k04 and k08, seeded by k03 (Mons); the M12 entries read
`{lat="10", lon="10", pod="p01"}` … `{lat="10", lon="10", pod="p08"}`; the N aggregate's members are
e7…e18 (12 groups, 23 series) and e18's rows n18…n29 (n27 = `{env="e18", lat="10", lon="10", pod="p27"}`: a row's name is its series name, every label included).

**CSV G** (the §4.14 header and all 18 rows, in the table order: by name, then key; RFC 4180, through
`csvCell`):

```text
name,key,value,value_status,state,location_status,location_detail,source,code,provider,place,lat,lon,group,group_member,draw_status
"{cloud_provider=""gcp"", cloud_region=""europe-west1""}",k03,210,ok,degraded,placed,,cloud,europe-west1,gcp,Mons,50.45,3.94,"{cloud_provider=""gcp"", cloud_region=""europe-west1""}",,shown
"{cloud_region=""eu-west-1""}",k01,120,ok,ok,placed,,cloud,eu-west-1,aws,Dublin,53.34,-6.25,"{cloud_region=""eu-west-1""}",,shown
"{cloud_region=""eu-west-2""}",k02,97,ok,ok,placed,,cloud,eu-west-2,aws,London,51.5,-0.12,"{cloud_region=""eu-west-2""}",,shown
"{cloud_region=""mars-north-1""}",k09,50,ok,ok,unknownCode,cloud cloud_region=mars-north-1,,,,,,,other (11),"{cloud_region=""mars-north-1""}",notPlaced
"{cloud_region=""westeurope""}",k04,180,ok,watch,placed,,cloud,westeurope,azure,Amsterdam,52.35,4.91,"{cloud_region=""westeurope""}",,shown
"{cloud_region=""xx-dup-1""}",k11,20,ok,ok,ambiguous,providers: ta xx-dup-1; tb xx-dup-1,,,,,,,other (11),"{cloud_region=""xx-dup-1""}",notPlaced
"{geo_country_iso_code=""jp""}",k05,60,ok,ok,placed,,country,JP,,Japan,36,138,"{geo_country_iso_code=""jp""}",,shown
"{geohash=""u4pruydqqvj""}",k08,75,ok,ok,placed,,geohash,u4pruydqqvj,,"57.6491, 10.4074",57.64911063015461,10.407439693808556,other (11),"{geohash=""u4pruydqqvj""}",shown
"{iata=""sin""}",k06,40,ok,ok,placed,,iata,SIN,,Singapore,1.35,103.99,"{iata=""sin""}",,shown
"{lat=""-89.9"", lon=""0""}",k13,5,ok,ok,placed,,coords,,,"'-89.9000, 0.0000",-89.9,0,other (11),"{lat=""-89.9"", lon=""0""}",outsideMap
"{lat=""0"", lon=""0""}",k14,-30,ok,ok,placed,,coords,,,"0.0000, 0.0000",0,0,other (11),"{lat=""0"", lon=""0""}",shown
"{lat=""10"", lon=""10""}",k12,,noValue,unknown,placed,,coords,,,"10.0000, 10.0000",10,10,other (11),"{lat=""10"", lon=""10""}",excluded
"{lat=""20"", lon=""20""}",k16,Infinity,infinite,unknown,placed,,coords,,,"20.0000, 20.0000",20,20,other (11),"{lat=""20"", lon=""20""}",excluded
"{lat=""25"", lon=""25""}",k17,5e-300,outOfRange,unknown,placed,,coords,,,"25.0000, 25.0000",25,25,other (11),"{lat=""25"", lon=""25""}",excluded
"{lat=""40.7128"", lon=""-74.0060"", site=""b""}",k18,150,ok,watch,placed,,coords,,,"40.7128, -74.0060",40.7128,-74.006,other (11),"{lat=""40.7128"", lon=""-74.0060"", site=""b""}",shown
"{lat=""40.7128"", lon=""-74.0060""}",k07,300,ok,failing,placed,,coords,,,"40.7128, -74.0060",40.7128,-74.006,"{lat=""40.7128"", lon=""-74.0060""}",,shown
"{lat=""91"", lon=""0""}",k10,,noValue,unknown,invalid,coords lat,,,,,,,other (11),"{lat=""91"", lon=""0""}",notPlaced
"{service=""web""}",k15,1,ok,ok,noLocation,,,,,,,,other (11),"{service=""web""}",notPlaced
```

**CSV X** (the rows after the header; ⏎ is a real LF inside the quoted cell):

```text
"{cloud_region=""=1""}",x4,-4,ok,,unknownCode,cloud cloud_region==1,,,,,,,"{cloud_region=""=1""}",,notPlaced
"{cloud_region=""a,b""}",x1,1,ok,,unknownCode,"cloud cloud_region=a,b",,,,,,,"{cloud_region=""a,b""}",,notPlaced
"{cloud_region=""say \""hi\""""}",x2,2,ok,,unknownCode,"cloud cloud_region=say ""hi""",,,,,,,"{cloud_region=""say \""hi\""""}",,notPlaced
"{cloud_region=""x\ny""}",x3,3,ok,,unknownCode,"cloud cloud_region=x⏎y",,,,,,,"{cloud_region=""x\ny""}",,notPlaced
```

**Guard** (`csvCell`, T24-026 amended; ⏎ is a real LF):

```text
-1+2 → '-1+2 · 1⏎ → "1⏎" · -1⏎ → "'-1⏎" · 1 U+2028 → unchanged · +1, +Infinity, -Infinity, -6.25, 1e5 → unchanged ·
=SUM(1) → '=SUM(1) · @x → '@x · TAB x → 'TAB x
```

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:geo-list` | charts/geo/GeoMarkList.test.tsx | G; G3 and its pans | the list and G3 blocks; the placeholder focused, marks return → it stays, ↓ → k01 | T24-093 |
| `unit:geo-list-keys` | same | focused buttons | ↓ → cluster:k07 and `setFocusMark('cluster:k07')`; End → k14; Home → item 1; PageDown → k14; Enter on item 1 → the cluster target, heading focused; the keys block; Esc → the ladder | T24-093 |
| `unit:geo-list-repair` | same | repair (a)–(c); focus outside the list | the repair block; outside: focus unmoved; (c) announced once | T24-093 |
| `unit:geo-targets` | charts/GeoMapFrame.test.tsx | G, O2; k05, cluster:k03; the legend `other (3)`; e8, q10 | the select, targets and brush blocks; a marker's `members` null; an empty click → `select(null)`; the T25-016 toggle twice → [k10], null | T24-092, T25-006 |
| `unit:geo-members` | inspector/members.test.ts, charts/GeoMapFrame.test.tsx | M12, N; a refresh; a `bin`; a `stateRun` (8 of 10, 8 of 12) | the members block; entries are buttons (`next`), labels parallel; `bin`, `stateRun`: `next` null, plain, as `unit:inspector-members` | T25-011 |
| `unit:geo-members-fullscreen` | inspector/host.test.tsx, charts/GeoMapFrame.nav.test.tsx, the real host | N on a board panel: `other (12)`, push e18; mount a full screen of that panel; "+4 more" on e18, Back, "+4 more" on the root; close the full screen; both presses again | every press resolves 12 with parallel labels (e18 and its rows n19–n29; the root e7–e18 with `{env: "e7"}` …), the same before, during and after the full screen; never stale | T25-011 |
| `unit:inspector-nav` | inspector/store.test.ts, inspector/host.test.tsx | a fake `next`; push A, then B | `nav` [A, B], selection B's; an old `seq`, a wrong `depth`, or closed → no-op; reopened → the new seq works; `pop {to: 0}` → [] and `req.selection`; close, a matching `originChanged`, `reset` → `nav` []; Esc with no `pre`: pop, pop, clear selection, close (focus `returnFocus`), `post`; a `pre` runs first; Back and the crumb names | T25-007, T25 §4.8 |
| `unit:inspector-viewkey` | inspector/Inspector.test.tsx | a fake `next`; pointer and keyboard opens; push, pop; 3 quick pushes; reduced motion; `point` P, then Q | one inert leaving layer for 150 ms; reduced: none; 3 pushes: ≤ 1 leaving layer, the 3rd on top; the `h2` focused per step. `point` (key `1:0:root`) as today: a pointer open keeps focus, a keyboard open focuses the `h2`; P → Q one leaving layer (reduced: none); each announced, P again later too | T25-008, T25 §4.4 |
| `unit:geo-announce` | charts/GeoMapFrame.test.tsx, the real host, a fake clock | N, 600 ms apart: `other (12)`, e18, n27, Back, Back, e18; then n27, Back, n27 within 100 ms | `Inspector: other (12), 12 groups, 23 series` · `Inspector: Level 2: e18, 12 series` · `Inspector: Level 3: {env="e18", lat="10", lon="10", pod="p27"}, 27 ms` · the 2nd · the 1st · the 2nd (the same text, rewritten); the quick run: only the last, at 500 ms | T25-008 |
| `unit:geo-nav` | charts/GeoMapFrame.test.tsx, the real host | N, by keys: the legend `other (12)` → entry 11 (e18) → entry 9 (n27) → Back → Back → close | one request; the selection 23 keys → 12 (n18–n29) → [n27] → 12 → 23; the breadcrumb `other (12)` › `e18` › n27's name; the `h2` focused per step; close → the legend button | T24-092 |
| `unit:geo-nav-life` | same | at n27: (a) a refresh removing n27; (b) V: cluster:v1 at W1, entry v1, the window → W2; (c) close, a query edit, the panel removed, a route change, a tenant reset; (d) e18 and e17 in one tick; (e) unmount; (f) the aggregate expanded, e18, Back | (a) n27 kept; Back → n18–n29; the resolver `geo:group:{"present":true,"value":"e18"}` → 12; (b) Logs `{service_name="checkout"}` over W1; (c) closed, `nav` [], nothing dispatched; (d) e18 accepted, e17 rejected; (e) disposed; (f) e18: n18–n25 + "+4 more", buttons → their rows; Back: e7–e14 + "+4 more", buttons → the groups | T25-011, T25-012 |
| `unit:geo-inspect` | inspector/model.test.ts | the targets above; k01; the context `f=env=prod` | the inspect block; §4.13; k01 chips: Explore on (naming env); with `f=env=prod` Logs `{env="prod"}` (T25-010: the identity AND the filters); with no filter Logs off "No log stream label on this series (needs service_name or job)" | T25-002, T25-009 to T25-011 |
| `unit:geo-single-group` | charts/GeoMapFrame.test.tsx | S1 | no legend; Tab surface → list → meter; selects | T24-093 |
| `unit:geo-table-csv` | vis/geo/rows.test.ts | G; X; G's table | CSV G and CSV X exactly; the table shows the unguarded values (k13's place `-89.9000, 0.0000`, x3's detail with its LF, x4's `cloud cloud_region==1`); the CSV parsed (RFC 4180) gives the guarded ones (`'-89.9000, 0.0000`) | VIZ-066, T24-094 |
| `unit:list-table-csv` (amended) | widgets/lists/table.test.ts | the guard block | each result | T24-026 |
| `unit:geo-facts` | vis/geo/rows.test.ts | G, G (k13 = 900), F1, Cap, R | the facts block | T22-014, T24-094 |
| `unit:geo-states` | charts/GeoMapFrame.test.tsx | from `ok` G (focus on item 2, selection [k03], cluster:k03 open): (a) a new window, answered at 100 ms; (b) at 400 ms; (c) HTTP 500; (d) k12 `ok`; (e) the basemap 404; (f) 100 × 100, G / 0 rows; (g) 0 series; (h) k09–k11, k15; (i) a refetch failing at 12:31:05; (j) (c) with focus in the board header; (k) (c) with focus in the Inspector | (a) the status, then item 1, no text; (b) an `aria-busy` status, "Loading…" at 300 ms, then item 1, "5 marks"; (c) Retry, "Couldn't load data"; (d) "Invalid map data (value)"; (e) Show table, §10.4's G meter, no query parts; (f) Show table, 18 rows / the header; (g) the `<p>`, `100 %`; (h) the `<p>`, "3 not placed · 1 ambiguous · 1 without a usable value (1 missing)"; (i) "… · stale (12:31:05)", "Couldn't refresh"; (j) no focus move or announcement; (k) focus stays in the Inspector; the selection and the Inspector are kept throughout | T24-095 |
| `e2e:geomap-a11y` | e2e/geomap.spec.ts | a stub BFF, G; states (a)–(h); reduced motion | axe clean; the Tab order; the keys; no transitions | VIZ-068, VL-016 |
| `e2e:geomap` | same | G | a click on cluster:k03 → `Cluster of 5`; Esc ×2 clears, then closes; Shift+T → 18 rows; the CSV = CSV G | VIZ-066, INT-034 |

### 10.6 Part E step 2 tests

Written first in E3a (URL state, sync, the map area, the map-sync spec version) and E3b (auto-vis row 8 and
import) (§11); all fail today: nothing is built yet. The codec, bounds, area and row 8 values below
were computed by a reference implementation of T24-096, T24-098 and `hasGeoFields`.

**Board BD** (layout order): **P1** synced, `boundsFilter`, saved view null, 1024 × 512; **P2**
synced, saved (10, 10, 3), 512 × 256; **P3** unsynced; **P4** unsynced, `boundsFilter`; **L** a line
over **G** (§10.4, 18 series); **K1–K9** unsynced maps (BD9). **EU** = (46, 14, 4); **B** = b1
{job=a}, b2 {job=b}.

```text
codec    G fit (30.733727227695173, 65.875, 3.1774065828117646) → *_30.73373_65.875_3.177, G3 marks ≤ 0.143 px after decoding;
         (51.500004, -0.120004, 13.9995004) → p-2_51.5_-0.12_14, corners ≤ 0.277 px; lon 179.999996 → *_0_-180_1;
         179.999994 → *_0_179.99999_1; -179.999996, -180, 540 → *_0_-180_1; lat ±85.0511, 85.05109999 → ±85.0511; each reads back
reject   *_86_0_2 · *_1_180_2 · *_1_2_15 · *_1_2 · P_1_2_3 · *_1.123456_0_1 · geo *_5_1_5_2 · geo *_1_2_3 · geo 1_2_3_4 (no scope);
         map=*_99_0_1&map=*_1_2_3 → (1, 2, 3); two valid `*` → the first
bounds   EU 1024×512, scope * → geo=*_-31_28.2114_59_59.4808, "Map area: 28.2°N–59.5°N, 31.0°W–59.0°E"; 512×256 → -8.5_37.635_36.5_53.2679;
         (0, 0, 2) → -180_-66.5133_180_66.5133
area     G ∩ EU: in k01 k02 k03 k04 k08; outside 9; unlocated 4 (k09 k10 k11 k15) → "9 outside the map area · 4 without a location";
         gazetteer null: kept k01–k06 k08 k09 k11, outside 7, unlocated 2, unapplied 8 → "… · map area not applied to 8
         (locations unavailable)"; B → 0 kept, "No series in the map area", "2 without a location"; geohash `er` (cell
         −33.75…−22.5, centre −28.125) in; `tr` (56.25…67.5, centre 61.875) outside; a point on w → in
results  heatmap {cloud_region=eu-west-1|us-east-1} × le 0.1, +Inf → eu-west-1 buckets binned, "2 outside the map area";
         log volume {level=error}, {level=info} → empty, "2 without a location"; LogQL `sum by (cloud_region)` eu-west-1,
         us-east-1 → 1 kept; baseline of k01 and k07 → k01 and its baseline, "1 outside the map area"; scalar → notice
```

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:map-params` | state/mapParams.test.ts | codec, reject, bounds; `withArea` with `*`, with `p4`, with null | each text exactly; read(write(x)) = x; `withArea` gives `geo=*_…` / `geo=p4_…` replacing any `geo`, null removes it | T24-096 |
| `unit:board-url-store` | state/boardUrl.test.ts | BD; in one tick: P3 commits V3, P1 commits EU, P4 commits V4, `setFilter(env, prod)`; then a time dispatch | the URL has `map=*…` (EU), `map=p3…`, `map=p4…`, `f=env=prod`, `geo=` = V4's bounds; 4 entries, each cumulative; the time write keeps every pair | T24-096, T24-098 |
| `unit:board-url-queue` | same, data router, loader delayed 50 ms | 4 writes 5 ms apart; then, each with 3 writes pending (one in flight): a POP; a same-board link to `map=p3_20_0_2`; a link to another page | 4 entries in order; `navigate` only after the previous resolves; `latest()` never regresses; POP and link: pending and in-flight writes dropped, `latest()` and the maps = that location, and it stays current (no stale write restores the old state); away: the destination stays current, the store disposed, no navigation back | T24-096 |
| `unit:url-budget` | same | (a) `f=` pairs to 40 bytes under the budget, `map=p4…`; (b) an incoming link: `f=` pairs 4 200 bytes, `map=p3_10_10_3`, no time params, without and with a saved board time; (c) as (b) with time params | (a) a filter add → `p4` evicted, the filter written (today's check passes), the P4 notice; (b) load: one replace adds from/to (default or saved), every other pair kept, the time gate opens, P3 at (10, 10, 3); P3 pans → refused (own scope kept), URL and `history.length` unchanged, camera local, the notice "Link too long — map changes not saved in the link"; a filter add → `p3` evicted, then today's check refuses (`'url.tooLong'`), URL unchanged; a filter removal → written; (c) a time change → `p3` evicted, written as today; P3 keeps its camera, the notice | T24-096 |
| `unit:url-echo` | same, memory router | (a) E0 `map=p3_10_10_3`; P3 commits V (E1); a filter add evicts `p3` (E2); another filter add (E3); back ×3; forward ×3; (b) a fresh E0, E1; an untagged same-board link to `map=p3_20_0_2` (E4); back; forward | (a) after E2, E3 (echoes) P3 stays at V, the notice; back to E2 (a tagged POP, no `p3`) → `options.view`; E1 → V; E0 → (10, 10, 3); forward: V, `options.view`, `options.view`; (b) E4 → P3 moves to (20, 0, 2); back → V; forward → (20, 0, 2) | T24-096 |
| `unit:url-time-init` | boards/boardTime.test.ts, BoardPage.test.tsx | an oversized link: no time params, `map=p3_10_10_3`, `geo=*_…`, `f=` pairs 4 200 bytes | one replace adds from/to only; every map and area pair remains; `latest()` equals the new URL at once; the time gate opens | T24-096 |
| `unit:url-atomic` | same, memory router | entries E1 `*_1_1_2` + `geo` b1, E2 `*_5_5_3` + `geo` b2 (current); a P1 commit refused | the URL still E2; back → (1, 1, 2) and b1 together; forward → (5, 5, 3) and b2; reload at E2 → (5, 5, 3), b2; never the view of one entry with the area of another | T24-096 |
| `unit:geo-history` | charts/GeoMapFrame.test.tsx, memory router | P3 at `p3_51.5_-0.12_14`: the first draw; commits 0.05 px east, then 2 px east; then `+`, `+`, pan, `-` | the first draw writes nothing; 0.05 px → the same encoding, no navigation; 2 px → push A `p3_51.5_-0.11983_14`; then 4 pushes B–E; `Alt+←` ×5 → D, C, B, A, then the initial entry (51.5, −0.12, 14); `Alt+→` ×5 → A–E; in an input → nothing | INT-006 |
| `unit:geo-sync` | pages/board/BoardGeoSync.test.tsx | BD; P2 `tooSmall`, then resized; reduced motion | pan P1 → one `*` push; P2 `setSpec`, no commit or 2nd navigation; P3 unmoved; P2 builds at `*`; a cut; the own echo → the exact `lastView` | VIZ-047, T24-097 |
| `unit:geo-sync-save` | same | (a) no `*`: P1 fitted over G (saved null), P2 at its saved (10, 10, 3): P1 off, P2 off; new data for P1 (G without k07, k18); reload; (b) no `*`: save P2 view (20, 0, 2); P1 commits EU; save P2 view (5, 5, 5); reload without `*`; (c) `*` = EU: P2 off, reload; P2 on; (d) the oversized link of `unit:url-budget` (b) plus `map=*_46_14_4` and `geo=*_…`, P1 the only synced writer: P1 sync off; P1 sync on; back; forward; (e) `geo=p4_…` effective (on BD, then on the oversized link): P1 sync off | (a) `map=p1_…` = P1's displayed fitted view (its `FrameSummary.geo.view`), `map=p2_10_10_3`, both unmoved; the new data does not refit P1; reload: both at those views; (b) P2 moves to (20, 0, 2) at once; EU: both EU; the second save: `*` kept, both stay EU; reload: P1 fit, P2 (5, 5, 5); (c) `map=p2_46_14_4`, P2 unmoved; reload: P2 EU; on: `p2` removed, P2 at `*`; (d) off: `geo=*` removed (written), then `map=p1` refused: the notice, P1 unmoved, new data does not refit it; on: no area (none in the URL), P1 at `*`; back → the link's entry: `*` is a writer again, so its area applies (provenance); forward → no area; (e) `geo=p4_…` kept, P3 and L still filtered, both times | T24-097 |
| `unit:geo-writers` | pages/board/BoardGeoArea.test.tsx | (a) BD; the steps in order; (b) history: P1 commits A (E1 `geo=*_A`), EU (E2); P1 `boundsFilter` off; back; forward; P1 on; back; forward; P1 commits B; (c) the oversized link of `unit:url-budget` (b) plus `geo=*_…`, P1 without `boundsFilter`; (d) BD9 | (a) P4 commits: `geo=p4_…`, P3 and L filtered (P1, P2, P4 are writers); P1 commits: `geo=*_…`; P4 `boundsFilter` off → nothing removed (the area is `*`'s); P1 off → `geo` removed in that update, all unfiltered; P1 on, a commit; delete P1 → removed; (b) off: E2 replaced without `geo`; back to E1: `*` no writer → no chip, nothing filtered, URL unchanged; forward; P1 on: nothing filtered (E2 has no `geo`); back to E1: area A and its chip apply, views at A; forward: none; B → E3, area B; (c) load: nothing filtered, no chip, URL kept; P1 on → the link's `*` area applies, the chip back; (d) K9 local: `boundsFilter` on → the notice; off → none; reload shows its saved view | T24-098 |
| `unit:geo-area` | vis/geo/area.test.ts | the area block | decisions, counts and the meter text exactly | T24-098, T22-006 |
| `unit:geo-area-results` | boards/panelRun.test.ts, charts/GeoMapFrame.test.tsx | the results block; P3 in `mapDataUnavailable`; P1 in `tooSmall` | as listed; P3's table = the kept rows; P1 writes nothing | T24-098 |
| `unit:geo-area-consumers` | pages/board/BoardGeoArea.test.tsx | BD, P1 at EU; a logs panel, a text widget | P1, P2 unfiltered; P3, L filtered; logs "Map area not applied to log lines yet"; the widget unchanged; the chip's remove → `geo` gone (push); Clear map area → restored, focus: the filter bar; `geoData` loading → L `loading` | VIZ-047 |
| `unit:geo-area-scope` | same, a stub BFF | a scoped response with k01 only | L shows k01 and counts only the returned rows; no request has `geo` or `map` | T12-018 |
| `unit:pivot-context` (amended) | inspector/pivots.test.ts | C5: `f=env=prod`, `geo` effective; C6: its scope not a writer, then a writer again | C5: Explore "Filters not applied in Explore yet: env, map area"; logs "Not carried to logs: map area"; no `geo` in the href; C6: no map-area disclosure, then C5's lines back | T25-010 |
| `unit:board-spec-geomap-v8` | boards/spec.test.ts, validate_test.go | `{}`; `sync: 'yes'`; `boundsFilter: 1`; `legacyAuto` on `line`; a doc at the version before map-sync with `auto` and `line`; a map-sync save to a stub of the version before | false defaults; `board.json.type`; `board.vis.legacyAuto.invalid`; the upcast marks only `auto`; 400 with the message; TS = Go | T24-096 |
| `e2e:geomap-sync` | e2e/geomap.spec.ts (Chromium) | a stub BFF; BD | drag P1 → P2 follows; EU → L 5 series; 3 moves, then real keys `page.keyboard.press('Alt+ArrowLeft')` ×3 and `('Alt+ArrowRight')` ×3: after each press the expected distinct URL and camera, the history index ±1 exactly, no second navigation; reload → the same views and area; axe clean | VIZ-047, INT-006 |
| `bench:geo-area` | vis/geo/area.bench.ts | 5 000 series (4 000 `cloud_region` cycling gazetteer ids, 1 000 coordinates); EU; 20 warm-up, 200 timed | the p95 of `applyArea` (§7) | T05 §7.1 |

**Row 8 fixtures:** **A1** 3 series `cloud.region` = eu-west-1, eu-west-2, us-east-1; **A2** 1 of 4
with lat/lon; **A3** 2 × `Region`; **A4** country=fr, country='', iata=lhr, job=x; **A5** 2 × lat
only; **A6** 1 series country=fr, 1 value; **A7** A1 with the rate rewrite applied; **A8** a histogram
with `region`; **A9** A1 with vis `line`.

```text
row8   A1 → geomap (8) · A2 → line (14) · A3 → geomap · A4 → geomap (2 of 4) · A5 → geomap (invalid rows disclosed) ·
       A6 → stat (7) · A7 → line (6) · A8 → heatmap (5) · A9 → line (explicit)
```

**Import fixtures** (`options` given; the outputs list only what differs from M1; notes in order):
- **M1** `{}` → view (0, 0, 1), `sync`/`boundsFilter` false, `wheelZoom` true, location auto, size `{fixed, 5, 5}`, `circle`, `group`, labels `none`, `cluster` false; no notes.
- **M2** view `{id: 'europe', shared: true, lat: 1}`, controls `{mouseWheelZoom: false, showZoom: true}`, a markers layer `{location: {mode: 'lookup', lookup: 'country', gazetteer: 'public/gazetteer/countries.json', latitude: 'x'}, config: {style: {size: {field: 'Value', min: 3, max: 30}, symbol: {fixed: 'img/icons/marker/square.svg'}, text: {field: 'name'}}}}` → view (46, 14, 4), `sync`, `wheelZoom` false, `{lookup, country, country}`, `{value, 3, 30}`, `square`, `auto`; "Option controls.showZoom not mapped".
- **M3** coords lat 90, lon 190, zoom −1 → (85.0511, −170, 0); "Latitude 90 clamped to 85.0511", "Longitude 190 normalised to -170", "Zoom -1 clamped to 0".
- **M4** coords lat `"x"`, lon `1e999`, zoom `null` → (0, 0, 1); malformed `view.lat`, `view.lon`, `view.zoom`.
- **M5** coords lat −85.0511, lon 180, zoom 14 → (−85.0511, −180, 14); no notes. zero with zoom 20 → (0, 0, 14), "Zoom 20 clamped to 14".
- **M6** `{dashboardVariable: true, dashboardVariableName: 'bounds', id: 'fit'}` → `boundsFilter`, view null; "View bounds go to the map area filter, not variable bounds".
- **M7** layers `[{type: 'heatmap'}, {type: 'markers', location: {mode: 'geohash', geohash: 'gh'}}, {type: 'markers'}, 'x', {type: 5}, {type: 'route'}]` → `{geohash, gh}`; "Layer heatmap not mapped yet", "Only the first markers layer kept", "Layer 3 malformed: skipped", "Layer 4 malformed: skipped", "Layer route not mapped yet".
- **M8** lookups `usa-states.json` (field `st`) / `airports.geojson` (`iata`) / `x.json` → `{lookup, st, region, US}` / `{lookup, iata, iata}` / auto + "Gazetteer x.json not available: auto-detected".
- **M9** size field `Value` min 30, max 3 → `{value, 3, 30}`, "Size limits reversed: swapped"; min 1, max 60 → `{value, 2, 40}`, "Size 1–60 clamped to 2–40"; fixed 50 → `{fixed, 40, 40}`, "Size 50 clamped to 40".
- **M10** `{view: 'x', controls: [], tooltip: {mode: 'multi'}, layers: [{type: 'markers', location: 'auto', config: {style: {size: 'big'}}}]}` → M1's options; malformed `view`, `controls`, `tooltip.mode`, `layers[0].location`, `layers[0].config.style.size`.
- **M11** location `{mode: 'wkt'}`; coords with `latitude` only; symbol `{mode: 'field'}`; symbol `star.svg`; color `{fixed: 'red'}`; text `{fixed: 'x'}`; `showLegend: false`; `tooltip.mode: 'none'`; `basemap: {type: 'xyz'}`; `view.minZoom: 2` (ten imports, one per item) → in order: "Location mode wkt not mapped: auto-detected", "Location fields missing (layers[0].location.longitude)", "Symbol mode field not supported; using circle", "Symbol star not mapped: circle used", "Fixed colour not kept: colours follow groups", "Fixed label text not kept: labels show series names", "The legend shows with 2 or more groups", "Tooltips are always shown", "Basemap replaced by the built-in offline map", "Option view.minZoom not mapped".
- **M12** (location, each a separate import) coords `{latitude: 5, longitude: 'lon'}` / `{latitude: '', longitude: 'lon'}` → auto, "Location fields missing (layers[0].location.latitude)"; geohash `{geohash: null}` → "… (layers[0].location.geohash)"; lookup `{lookup: 'iso', gazetteer: 7}` → `{lookup, iso, country}`, "Option layers[0].location.gazetteer malformed: default used"; lookup with `latitude: 'x'` and auto with `geohash: 'gh'` → no notes.
- **M13** (style members) size `{fixed: '5', min: null, field: 3}` → field malformed → fixed mode: `{fixed, 5, 5}`, malformed `size.field`, `size.fixed` (`min` ignored); fixed mode `{fixed: 8, min: 'a', max: []}` → `{fixed, 8, 8}`, no notes; value mode `{field: 'Value', fixed: 'x', min: 3, max: 'y'}` → `{value, 3, 15}`, malformed `size.max` only; color `{field: 'Value', fixed: 7}`, no thresholds → `group`, only "colour field Value not mapped without thresholds; using group colours" (`fixed` ignored); with thresholds → `state`, no notes; symbol `{mode: 'svg'}` → circle, "Symbol mode svg not supported; using circle"; symbol `{fixed: 3}` → circle, malformed `symbol.fixed`; color `{field: 5}` → `group`, malformed `color.field`; text `{mode: 'template', fixed: 'x'}` → `auto`, "Text mode template not supported; using series names" (the paths in the notes are full, `layers[0].config.style.…`).
- **M14** (selected fields) size `{field: 'cpu', fixed: 7}` → `{fixed, 7, 7}`, "size field cpu not mapped; using fixed size 7"; size `{field: 'Value #A'}` → `{value, 2, 15}`; color `{field: 'region'}` → `group`, "colour field region not mapped; using group colours"; color `{field: 'Value'}` with thresholds → `state`; text `{field: 'job'}` → `auto`, "text field job not mapped; using series names"; text `{field: 'name'}` → `auto`, no note.

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:autovis-table` (amended) | vis/autovis.test.ts | the row8 block | each vis and rule | VIZ-065 |
| `unit:autovis-legacy` | boards/panelRun.test.ts, pages/board/PanelEditor.test.tsx | a board stored before the map-sync version: an `auto` panel over A1 | board: line (14); editor opened: preview "Auto (Map)", geomap; saved: `legacyAuto` gone, board geomap (8); a save of another panel or of the layout keeps it a line | VIZ-065, T24-099 |
| `unit:autovis-logql` | boards/panelRun.test.ts, pages/board/PanelEditor.test.tsx | a LogQL `auto` panel, `sum by (cloud_region) (count_over_time({job="x"}[5m]))` answering a range result of 3 series eu-west-1, eu-west-2, us-east-1 (today's stream path); the same stored before the map-sync version; a log-line answer | at the map-sync version or later: board geomap (8), label "Auto (Map)", preview geomap; stored before map-sync (3 series): board line, label Line; editor preview geomap, "Auto (Map)"; cancel → line; save → geomap; log lines: today's stream view | T24-099 |
| `unit:autovis-explore` | pages/explore/MetricsPage.test.tsx | A1 on Explore | line (14) | T24-099 |
| `unit:import-geomap` | import/geomap.test.ts | M1–M14 | options and notes exactly; every output passes `validateBoardSpec` (TS) and `validate.go` | VIZ-060 |
| `unit:import-geomap-fuzz` | same; tools/fixtures/geomap-fuzz.ts; validate_test.go | seed 184 (mulberry32); 500 documents; the §4.19 leaf paths sorted (UTF-16), each independently absent (p ½) or drawn uniformly from {null, true, false, 0, −1, 1.5, 100, 1e300, "", "x", "Value", "img/icons/marker/square.svg", [], {}, [1], {"a": 1}}; a drawn leaf creates its absent parents as objects (`layers[0]` as a one-element array); the generator writes `api/fixtures/import/geomap-fuzz.json` ([{src, options, notes}]) | TS: never throws, regenerating equals the committed file; TS and Go: every `options` valid; a hand-written TS case feeds `Infinity`, `-Infinity` and `NaN` at each numeric path (not representable in JSON), once in each mode: where the mode consumes the path, its malformed note and default; where the mode ignores it (size `min`/`max` in fixed mode, `fixed` in value mode, `view.lat`/`lon` outside `coords`, `view.zoom` outside `zero`/`coords`), no note | VIZ-060 |
| `unit:editor-preview-legacy` | pages/board/PanelEditor.test.tsx | the pre-map-sync board's `auto` panel over A1, the editor open | the preview renders a geomap frame and the label "Auto (Map)"; the board panel behind still renders a line; cancel → no change; save → board geomap | T24-099 |

Every gate is in [T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

## 11. Rollout

Implementation issues, filed after this design merges:

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| A1 — Text, renderer, the widgets spec version (§5.0) | §5.1, §5.2, §5.4, editor, gallery `widget-text`, `widget-text-removals` | #173 | T24-001–009, T24-014–018 |
| A2 — Clock | §5.3, editor, gallery `widget-clock-1`, `widget-clock-4`, `widget-clock-countdown` | A1 | T24-010–015, T24-017 |
| A3 — Image proxy | T18-014 route, rewrite | T18 §4.9 egress guard | T18-014 |

A1 needs #173 (board spec v3) and ships the widgets version, v5. It is split in five parts
(recorded on #198):

| Part | Scope | Gates |
|---|---|---|
| 1, landed | the widgets version (§5.1) in OpenAPI, Go and TS, the zone rules, the panel union (`isWidgetPanel` guards every `query` read), a widget frame showing "not available yet", and the old-binary gate run for every spec version change | `unit:board-spec-widgets`, `unit:board-spec`, `itest:board-crud`, `itest:board-zones-grandfathered`, `itest:board-spec-old-binary` |
| 2a, landed | [ADR-0024](../adr/0024-markdown-runtime-dependencies.md) dependencies and the `parse5-sax-parser/feedback` alias; `classifyUrl`, `toWellFormed`, `findIframes`, the import conversion (§5.4); the `security` ESLint rules (`ci:no-iframe`, the import boundary); the module-graph check on every audited build and the sanitiser size probe (≤ 100 000 bytes brotli) | `unit:classify-url`, `unit:well-formed`, `unit:find-iframes`, `unit:import-text-iframe`, `unit:import-size-error`, `unit:security-lint`, `unit:bundle-modules`, `unit:sanitise-bundle`, `ci:dep-audit` |
| 2b, landed | the renderer (§5.2: `renderMarkdown`, `renderCode`, removals with `depth`, interpolation, the §4.2 walk and flat source lines), the generated XSS corpus and its `--check` gate, an independent URL checker and `checkInvariants`, `fuzz:markdown-nodes` (with the import inverse), `bench:markdown-render` (uncached, report-only); the renderer joins the sanitiser size probe | `unit:markdown-*`, `unit:removal-redaction`, `unit:markdown-xss-corpus`, `unit:xss-corpus-current`, `fuzz:markdown-nodes`, `unit:sanitise-bundle` |
| 3a, landed | the Text view (§5.2a: `TextBody`, the lazy `TextMarkdown` entry, the states and the region, validation first, the overflow tab stop, M0), `widgetVisErrors`, the widget editor with the Text body and the removal list, `textVis`, the registry as a context, `addWidget` / `updateWidget`, "Add widget" and Edit panel, Text variables on the board, the Markdown module rules and the parse5 and commonmark allowlist strings | `unit:text-*`, `unit:widget-add`, `unit:widget-editor`, `unit:widget-spec-roundtrip`, `unit:text-vis-roundtrip`, `unit:widget-registry-generic`, `unit:board-variables`, `unit:bundle-modules`, `ci:dep-audit`, `ci:bundle-size` |
| 3b, landed | the widget gallery (`dev/widgets?page=widget-text`, `widget-text-removals`), the goldens, the e2e (the whole XSS corpus in the browser, one case per context against a committed per-browser load baseline and a generated per-case image list, with canaries), the render measures and `bench:text-widget-render` with the M1 and M2 triggers (§7) | `e2e:widget-text`, `e2e:widget-text-xss`, `e2e:widget-a11y` (Text), `golden:widget-gallery` (Text), `unit:xss-e2e-cases`, `unit:widget-gallery-route`, `bench:text-widget-render` (report-only) |

A1 has landed: Parts 1 to 3b.

The implementation writes
`docs/client/widgets.md` (behaviour, Markdown, URLs, import, Clock) and updates
`docs/client/boards.md`, `docs/user/boards.md`, `docs/server/boards-api.md` and
`docs/client/supply-chain.md` (widget panels, the widgets-version keys, the `markdown` dependencies).

Part B1 implementation issues, filed after this design merges:

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| I1 — BFF: board tags, `/boards` search, `applied`, `truncated` (#215) | §5.5 tags (Go and the client's validator, at the next free spec version), §5.6, §6, migration 4, the itests, `make itest-old-binary`, `docs/server/boards-api.md`, `docs/server/database.md` | — | T24-021, T24-029 |
| I2 — Board list widget, list modules, editor tags field (#216) | Part 1 (landed): §5.5 `boardList` kind and options at v6 (Go and TS), the `Api.ts` pages and filters with old-server decoding, the pure §5.7 modules and `import/boardList.ts`; a stored board list shows the "not available yet" frame. Part 2a (landed): the view (§5.7 Part 2a: sources, the search commit, rows and Show more, states, keys and focus, announcements, the meter, Shift+T through the kit `PanelTable` as a `TableView` and CSV), gallery `widget-board-list`, `widget-board-list-search`, `widget-board-list-states`, `e2e:widget-board-list`, `e2e:widget-lists-a11y`, `golden:widget-gallery`, `bench:widget-lists`; `docs/client/widgets.md`. Part 2b (landed): Add widget → Board list (`BOARD_LIST_DEF`), its editor body (§5.7 Part 2b: the inert preview, `boardListVis`, local texts that block Done and Save), the board tags field, `setTags` and the `/tags` 400 text, the e2e add flow, `docs/user/boards.md`. I2 is complete | I1, #198, #173 | T24-020–029 |
| I3 — Incident-use ranking (needs design) | SRF-026 "used during incidents" | IA-007 | T24-023 |
| I4 — Validate `boards_tags_max` (next release) | §6 `VALIDATE CONSTRAINT`, `itest:board-tags-validate` | I1 released | T24-029 |

I1 writes the new `/boards` parameters, fields and errors, migration 4, the tags freshness and repair
and I4 into the server docs. I2 writes the Board list (modes, options, meter, keys, CSV, mixed server
versions) into `docs/client/widgets.md`, and adding a Board list and board tags into
`docs/user/boards.md`.

Part B2 implementation issues, filed with this design:

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| I5 — BFF: annotation entity, data scope, filters, keyset, `applied` | §5.9, §6, migration 5, `unit:entity-id`, the `itest:annotations-*` tests; `docs/server/annotations-api.md`, `docs/server/database.md` | #215 rolled out | T24-030–032, T24-038, T12-010, T12-018 |
| I6 — Change feed widget, `e=`, the `change` target | §5.8, §5.10, [T25](T25-inspector-and-pivots.md) `change` and `unit:pivot-context` C4 (`e=`), the unit, e2e and golden tests, gallery `widget-change-feed`, `-entity`, `-states`, `-inspector`; `docs/client/widgets.md`, `docs/client/inspector.md`, `docs/client/logs.md` (§4.9), `docs/user/boards.md` | I5, I2, #198, #173 | T24-030–039, T25-002 |
| I7 — Validate `annotations_entity_pair` (next release) | `ALTER TABLE annotations VALIDATE CONSTRAINT annotations_entity_pair`, `itest:annotations-entity-validate` | I5 released | T11-013 |
| L1 — Log panel minimap, JSON tree and prettify (needs design) | §4.9 | — | VIZ-034 |
| L2 — Log panel dedupe and context lines (needs design) | §4.9 | — | VIZ-034 |
| L3 — Log patterns with the NEW badge (needs design) | §4.9 | — | VIZ-035 |
| L4 — Log panel fling across slices at frame rate (needs design) | §4.9 | #136 | VIZ-034 |

I5 writes the entity, the scope, the filters, the cursor and `applied` into
`docs/server/annotations-api.md` (CI posters keep sending `entity`), and migration 5 and I7 into
`docs/server/database.md`. I6 writes the Change feed (sources, `e=`, the meter, keys, CSV, mixed
server versions) into `docs/client/widgets.md`, the `change` target into `docs/client/inspector.md`,
the §4.9 gap record into `docs/client/logs.md`, and adding a Change feed into `docs/user/boards.md`,
with "with scopes, don't name other services in change text".

Part E step 1a implementation issue, filed with this design:

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| E1 — Geo data and resolver | `tools/geo` (`build.py`, `--check`, `test_build.py` and fixtures, `sources.json`, `cloud-regions.csv`, `manifest.json`), the two assets, `client/src/vis/geo` (§5.11), `ci:geo-data`, the `ci:bundle-size` rows, the §10.3 tests; `docs/client/geomap.md` (new), `docs/client/supply-chain.md` | — | T24-080–087 |

E1 writes `docs/client/geomap.md` (the ladder, the statuses, the precision of each source and the
gazetteer's coverage, with the excluded cloud partitions) and adds the sources, digests, licences and
the `--check` procedure to `docs/client/supply-chain.md`. Steps 1b and 2 are designed next under
#184.

Part E step 1b implementation issue, filed with this design (one issue for the frame and its
interaction):

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| E2 — Geomap frame | §5.14 to §5.16 (the ADR-0027 seam in the Canvas 2D engine, `GeoMapFrame`, `planGeo`, `vis/geo/frame.ts`, `targets.ts`, `rows.ts`, `GeoMarkList`), the geomap spec version, the T25 `geo` targets and navigation stack, the `csvCell` exemption, the §10.4 and §10.5 tests, the gallery pages `geomap-markers`, `geomap-groups` and `geomap-states`; `docs/client/geomap.md`, `docs/client/inspector.md`, `docs/user/boards.md` | E1, #173 (T22 I1) | T24-088–095, T24-026 (amended), T25 §4.8, §4.9 |

E2 writes the statuses, the groups, the camera, the targets, the keys, the states and the CSV into
`docs/client/geomap.md`, the navigation stack and the `geo` targets into `docs/client/inspector.md`,
and map inspection into `docs/user/boards.md`. Step 2 (T24-096–099: view sync, the bounds filter,
auto-vis and import) is designed next under #184.

Part E step 2 implementation issues, filed after this design merges:

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| E3a — Map URL state, sync and the map area | §4.15 to §4.18, §5.17 (`state/boardUrl.ts`, `state/mapParams.ts`, `vis/geo/area.ts`, `vis/geo/writers.ts`), the map-sync spec version (§5.15), `Coverage.area` ([T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal)), the T25-010 map-area disclosure, the §10.6 step 2a tests and `bench:geo-area`; `docs/client/geomap.md`, `docs/user/boards.md` | E2 (#234), E1 (#231) | T24-096–098, T24-088 (amended), T25-010 |
| E3b — Auto-vis row 8 and geomap import | §4.19, §5.17 (`hasGeoFields`, `importGeomap`), `legacyAuto` in the panel run, the stream view and the editor, the §10.6 step 2b tests; `docs/client/boards.md`, `docs/client/import.md` (new) | E3a (the map-sync spec version) | T24-099 |

E3a writes the store and its queue, the codecs, the scopes, the URL budget, history, sync, the
roles, the area per result and the limits into `docs/client/geomap.md`, and sync, the map area,
history and the 8-map limit into `docs/user/boards.md`. E3b writes row 8, `legacyAuto` and when it is
dropped into `docs/client/boards.md`, and the geomap mapping, its defaults and notes into the new
`docs/client/import.md`.

## 12. Alternatives considered

Rejected:
- a separate sanitiser ([T08](T08-dom-component-kit.md) §12);
- hand-written HTML scanning;
- one parser mode (the tree or the tokenizer alone each misses a context, §5.2);
- `DOMParser` (a Trusted Types sink, T18-005).

Part B1, rejected:
- client-side board search (it misses boards past 1 000);
- tags read only from the head spec (a list would detoast specs of up to 2 MiB);
- two migrations (an N+1 window problem);
- virtualised list rows (1 000 rows fit plain DOM).

Part B2, rejected:
- `kind:name` entity keys (not unique across bindings or namespaces, and they name the entity in the
  key);
- stripping `entity` from a create for an old server (the change would lose its entity silently);
- paging by moving `to` (rows sharing an `at` are skipped or repeated; the keyset on (`at`, `id`) is
  exact).

Part E step 1b, rejected:
- a neutral marker colour (identity needs a visible second channel, VIZ-067);
- rings as the only state cue (not distinguishable in greyscale at small radii);
- spreading coincident marks apart (it moves marks off their place; clusters and the pick order
  keep each reachable);
- a horizontally repeated world (ADR-0027);
- nested member lists in the Inspector (T25-011 is flat; the aggregate lists its groups, as #154's
  `other` bin);
- inspecting an ordinary group from its legend entry (it selects only; groups open from the
  aggregate's members);
- `aria-activedescendant` for the mark list (a roving tab stop, as T24-025);
- a new host request per navigation step (requests race; the stack lives in one request, T25 §4.8).

Part E step 2, rejected:
- label-matcher rewrites for the map area (there is no matcher form for coordinates);
- an in-memory camera (no link reproduces it);
- a board variable for the bounds (the area is a filter, like `f=`, IA-026);
- wrapped bounds (ADR-0027: one world that never repeats);
- a gazetteer-based row 8 (asynchronous, so the choice would flip when the assets arrive);
- a board-level version gate for row 8 (one panel's save would flip every `auto` panel on the
  board);
- keeping unmapped source values in hidden options (no consumer, unvalidated).

## 13. Open questions

None.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-25 | #153 part A: created: the part map and ID blocks for parts A–K; rules T24-001 to T24-018; the Markdown node table, clock formats and import mapping; board spec v4, the renderer, wall clock and import conversion interfaces; tests and fixtures; the implementation issues A1–A3; [ADR-0024](../adr/0024-markdown-runtime-dependencies.md) |
| 1.1-rc | 2026-11-25 | #181 part B1 (step 1): the part map splits B into B1 (T24-020–029) and B2 (T24-030–039, VIZ-126); T24-002 amended (content widgets; list widgets follow T24-020); rules T24-020 to T24-029 (list widgets, Board list sources, rows, limit and ranking, snapshot and meter, keyboard and focus repair, table, CSV and facts, states and look, import, board tags and compatibility); §4.5 list states, §4.6 Board list import; §5.5 board spec v5, §5.6 the `/boards` contract, §5.7 the client list modules; §6 migration 4 and the repair and list queries; §7–§9, §10.1 tests and fixtures, §11 issues I1–I4, §12. [T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal) gains the optional `Coverage` list members; [T11](T11-postgres-schema.md) §4.3 migration 4 |
| 1.2-rc | 2026-11-25 | #181 part B2 (step 2): rules T24-030 to T24-039 (feed source, entity filter, paging, snapshot and meter, rows, selection and Inspector, keyboard and SR, table, CSV, facts and fields, compatibility, import); T24-020 amended (`changeFeed`; its rows select and inspect); §4.7 Change feed states, §4.8 Change feed import, §4.9 the log panel gap record; §5.8 board spec v6, §5.9 the annotations contract and data scope, §5.10 the client change-feed modules; §6 migration 5 and the list, create and delete statements; §7–§9, §10.2 tests and fixtures, §11 issues I5–I7 and L1–L4, §12. [T12-010](T12-entity-catalogue.md#t12-010--stable-identity-64-bit-wire-id) gains the canonical form and vectors, and T12-018 a free-text note; [T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal) the `paged` reason; [T25-002](T25-inspector-and-pivots.md#t25-002--envelope-and-union) the `change` member; [T11](T11-postgres-schema.md) §4.4 migration 5 |
| 1.3-rc | 2026-11-25 | #184 part E step 1a (geomap data): the intro, §1, §2 (goals, the part map splits E into 1a T24-080–087, 1b T24-088–095 and 2 T24-096–099, VIZ-129 unused; the decisions step 1b starts from) and §3; rules T24-080 to T24-087 (label input, the resolution ladder, coordinates, geohash, lookups, the gazetteer and basemap builds, delivery and validation); §4.10 the auto rules; §5.11 the resolver and loader, §5.12 the asset formats, §5.13 the build tool, cloud regions, sources and notices; §6–§9; §10.3 tests and fixtures; §11 issue E1 |
| 1.4-rc | 2026-11-25 | #184 part E step 1b (geomap frame and interaction): the intro, §1, §2 (goals, non-goals; the part map marks step 1b) and §3; rules T24-088 to T24-095 (host and plan, rows, identity, camera and picking, selection and Inspector, mark list and keys, table, CSV and facts, states); T24-026 amended (the `csvCell` numeric exemption; `unit:list-table-csv` amended); §4.11 orders and coverage, §4.12 states, §4.13 Inspector targets, §4.14 columns; §5.14 the seam and host, §5.15 rows and board spec v7, §5.16 targets, mark list and rows; §6–§9; §10.4 and §10.5 tests and fixtures (code review r1: `unit:geo-inertia`); §11 issue E2; §12. [ADR-0027](../adr/0027-geomap-frame-seam.md); [T22-004](T22-value-categorical-and-table-panels.md#t22-004--colour-and-identity) (grouped spatial marks, JSON quoting, spatial overflow), [T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal) (`Coverage.geo`) and [T22-007](T22-value-categorical-and-table-panels.md#t22-007--click-selects-inspects-filters) amended; [T25](T25-inspector-and-pivots.md) gains the `geo` target and the in-request navigation stack |
| 1.5-rc | 2026-11-25 | #173 Part 1 ([T22](T22-value-categorical-and-table-panels.md) I1): §5.7 `csvCell` is defined in `client/src/data/csv.ts`, shared by the panel tables, and re-exported by `widgets/lists/snapshot.ts` |
| 1.6-rc | 2026-11-25 | #184 part E step 2 (2a: URL state, camera history, view sync and the map area; 2b: auto-vis row 8 and import): the intro, §1, §2 (goals, non-goals; the part map marks step 2) and §3; rules T24-096 to T24-099 (view state and history, sync, the map area, auto-vis row 8 and import); T24-088 amended (the input view of a non-local map is its URL entry); §4.15 the map area per result, §4.16 the writer per state, §4.17 sync and saved views, §4.18 the board URL store, budget and reads, §4.19 the geomap import; §5.15 board spec v8 (`sync`, `boundsFilter`, `legacyAuto`); §5.17 the URL store, codecs, area, roles, `hasGeoFields` and `importGeomap`; §6–§9; §10.6 tests and fixtures; §11 issues E3a and E3b; §12. [T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal) gains `Coverage.area`; [T25-010](T25-inspector-and-pivots.md#t25-010--pivot-context) the map-area disclosure |
| 1.7-rc | 2026-11-26 | #215 (part B1, I1): §5.5 splits the spec change: tags at the next free spec version in I1 (#215), with the client's validator; the `boardList` kind and options, Go and TS, in I2 (#216) after #198. T24-029 and §9: old binaries cannot move "a head saved at the tags version or later" (was "a v5 head"); §6 likewise. §10.1: fixture S adds "Ledger" `[finance, team:payments]`, `itest:board-find` adds the exact-tag and `q`+`tag` cases, the board-tag cases of `unit:board-spec-board-list` are in I1, the itest files are named, and `itest:board-tags-old-binary` runs by `make itest-old-binary` (local). §11: the I1 and I2 rows. New §5.0 (board spec version order): every spec change takes the next free version, with an upcaster from the version before; the versions are named by change (tags, widgets, board-list, change-feed, geomap, map-sync), with v4–v9 if they land in that order (tags v4 landed, so #198's widgets version is v5); §1, §3, §4, §5.1, §5.8, §5.15, §6, §9, §10 and §11 use the names, fixtures are `v‹N›-‹change›.json`, and gate IDs keep their labels; every upcast is from the immediately preceding version, the change-feed and geomap versions depend on no other version and map-sync depends only on geomap, and the auto-vis tests and the import name "before the map-sync version" and "the map-sync version or later"; the widgets version is v5 only if no other spec change lands first |
| 1.8-rc | 2026-11-26 | #198 Part 1 (A1): §5.0 the widgets version landed as v5. §5.1: the zone rule replaces "loadable by `time.LoadLocation`": the form on every parse, existence in Go on writes only against the build's zone set (the toolchain's `zoneinfo.zip` names, generated), a zone the head holds kept on a save; `language` in code mode only; a duplicate zone is the same `tz`; a widget's `thresholds` and `legend` are `board.json.unknownKey`; the `countdown.to` grammar; `v5-widgets.json`. §9: a stored zone is always readable. §10: `Mars/Base` is Go only (`client_fields`). §11: A1 is split in Parts 1–3 |
| 1.9-rc | 2026-11-26 | #216 Part 1 (I2): §5.0 the board-list version landed as v6. §5.5: the rules table (shared `sort` and `mode` per kind, with the reader guards; `query` search-only with the gateway's Cc rule and no minimum; `tag` present iff tag mode; `limit` a whole JSON number 1–50; an invalid mode skips the mode rules). §5.7: `BoardListMode`, `BoardListItem`, the old-server decoding and the stub's filter and truncation; ref rows; `withStale`, `listSetSize`, `repairActive`, `ListTable`/`listCsv`, `boardRowName`, `rankingCaption`, `boardListTable`, `boardListFacts`, `import/boardList.ts`. T24-026: both suffixes. §4.6: the note order. §11: I2 split into Part 1 (spec, API, pure modules) and Part 2 (the view, editor and the rest) |
| 1.10-rc | 2026-11-26 | #198 Part 2a (A1): §5.2 `toWellFormed` before classification, `IframeHit` with `offset` (in `findIframes.ts`), and the SAX half through `ParserFeedbackSimulator` via the `parse5-sax-parser/feedback` alias, because `SAXParser` needs `node:stream`. §5.4 step 3: line ends as commonmark splits them, `\r` inserted after a lone `\r`, the ascending `inserted` order. §10: f11 (CRLF and CR) and f12 (a list item and a block quote); `unit:well-formed`, `unit:security-lint`, `unit:bundle-modules`, `unit:sanitise-bundle`. §11: A1 Part 2 split into 2a (landed) and 2b |
| 1.11-rc | 2026-11-26 | #198 Part 2b (A1): §5.2 the `depth` removal kind, `removalMessage`, `sourceLines`, `MAX_DEPTH` and `toWellFormed` on the source, the values and the entity. §4.2: the tight-list paragraph, `start` only when not 1, the tree walk (post-order, explicit stack) with the pre-scan and the cost table; an over-deep block shows its whole source lines (verbatim, terminators kept) in one span with one `depth`. T24-007: `depth`. T24-018: `/api` and `/auth` images count as external (byte-level decoding, at most three rounds, invalid UTF-8 counted as a route); `ai` external and mailto links are text with host or address until the T18 §4.10 interstitial. §8: no Trusted Types policy. §10: the fuzz sets gain `span`, `class`, `aria-hidden` and depth ≤ `MAX_DEPTH`; the new unit rows, the corpus rows; the uncached bench. §11: Part 2b landed |
| 1.12-rc | 2026-11-26 | #198 Part 3a (A1): new §5.2a (the Text view `TextBody` and its lazy `TextMarkdown` entry, the states, `widgetVisErrors`, `textVis`, the registry and its context, `addWidget` and `updateWidget`, the module rules). T24-008: a Markdown Text's references join the board's variables. T24-014: the view validates first; the preview shows "Preview unavailable". T24-015: the Text widget uses the Compact metrics until VL-013. §10: the Part 3a unit rows. §11: A1 Part 3 split into 3a (landed) and 3b |
| 1.13-rc | 2026-11-26 | #198 Part 3b (A1): §7 `bench:text-widget-render` (the `markdown:render:<bucket>` measures in stub and dev builds, board P, the steps, the measured numbers) and the M0, M1 and M2 rungs with their triggers. §10: `e2e:widget-text` adds the Add widget flow and the named region; `e2e:widget-text-xss` runs the whole corpus in the browser (the generated case list with digests, skip reasons and image request paths; one case per fresh context against a committed per-browser load baseline; the exact CSP; a Trusted Types canary) with canaries; `e2e:widget-a11y` gains the Text rows; `golden:widget-gallery` lands the two Text pages; new `unit:xss-e2e-cases` and `unit:widget-gallery-route`. §11: Part 3b landed, A1 landed |
| 1.14-rc | 2026-11-26 | #222 (part B2, I5): §5.9 `orgWide` only with `entity`, repeated values, upper-case ids and repeated single parameters → 400, a missing cursor partner reported on its own pointer; the 403 bodies (`scope_denied`, "data scope denied" without fields, "outside your data scope" with `/entity` `annotations.entity.scope` or `annotations.scope`); `orgWideHidden` is a count the BFF sends null when scoped. §6: `P` with `@>` and `jsonb_build_array`, byte-identical in list and delete; `org_wide_hidden` computed unconditionally. §10.2: `unit:entity-id` in `entity/entity_test.go`, the itests in `annotations/annotations_itest_test.go`, and `itest:annotations-old-binary` runs by `make itest-old-binary` (local) |
| 1.15-rc | 2026-11-26 | #231 (part E step 1a, E1): §5.11 the `types.ts` interfaces, `GeoData`, `geoLoader`, the `aliases.ts` exports (`normKey`, `GEO_AUTO_RULES`, `GEO_ALIAS_KEYS`), the decoders in `decode.ts` re-exported by `assets.ts`, the URLs of `urls.ts` and the `geo-assets` build input. §5.12: the assets' keys are in the listed order (`v`, `q`, then the data members), not sorted, as the §10.3 RT bytes already were. §5.13: the shapes of `sources.json` and `manifest.json`, and `--notices`; the cloud list's coverage rule (each provider's published list, azure restricted-access regions included) and the example rows reconciled with the lists of 2026-11-26 (gcp `europe-west1` is St. Ghislain; a country or state location becomes a curated city) |
| 1.16-rc | 2026-11-27 | #173 Part 3b ([T22](T22-value-categorical-and-table-panels.md) §4.5): T24-099 (§4.1) — the map-sync spec version's `legacyAuto` covers auto-vis rows 8 and 11 together: pre-map-sync panels keep the legacy set, panels saved at map-sync or later get both rows; #237 implements it, and #173 adds no spec version |
| 1.17-rc | 2026-11-27 | #234 Part 1 (E2): §5.0 the geomap version landed as v7 (before the change-feed version, so the change-feed and map-sync versions take the next free numbers). §5.15: `GeoGroup` gains `memberLabels` (the final labels, parallel to `members`) and `GeoRowSet` `groupBy`; `geoRowSet` takes the result's `source` and the panel's `Thresholds` (lines lack the direction) and `validateGeoRows` takes `Thresholds \| null`; a null and an absent `groupBy` or `view` are one stored value. §5.16: `GeoInspectorTarget` gains `set`. T24-091: the `map-water`, `map-land`, `map-coast` and `map-border` values (the light strokes in the hairline ink) |
| 1.18-rc | 2026-11-27 | #234 Part 2 (E2): T24-091 records the inertia's release velocity as the spring's initial velocity (D = 2v/ω), which T02-022's rest form does not fix. §5.14 names the mark tokens `pattern-ink` and `category-other` with their values. §10.4: the File column of `unit:geo-radius-project`, `unit:geo-camera`, `unit:geo-ownership`, `unit:geo-keys-engine`, `unit:geo-inertia` and `unit:geo-marks` moves from `engine/canvas2d/geo/` to `engine/controller/geo/` (the renderer-free half any engine reuses, [ADR-0031](../adr/0031-gpu-engine-default-renderer.md); gate IDs unchanged). §10.4 and §10.5 keys: at G's fit the world's east edge is 135.84 px from the centre, so containment caps Shift+→; the 256 px pan is Shift+← |
| 1.19-rc | 2026-11-27 | #216 Part 2a (I2): the Board list view. T24-021: Esc's clear commits `''` at once. T24-023: the clamp of the shown count is kept per answer (an empty answer starts again at `limit`). T24-025: the count is announced only for a search the user committed; a row's chips and time are its link's description. T24-026: the facts are the list's description; the table caption `‹n› boards · ‹d› shown` and "Show list (Shift+T)". §4.5: the failed-refresh notice shows the rows' fetch time. §5.7: the Part 2a modules. §11: Part 2a landed, Part 2b next |
| 1.20-rc | 2026-11-27 | #234 Part 3 (E2, the host): T24-088 records `panelView` → `{kind: 'geomap'}` (after the blocked rows; `notMetric` for a LogQL log answer), `framePlan` → `notice: 'geomap'`, `PanelRun.placeholder` and `retry()`, and `planGeo`'s `{seq, motion}` (and `staleAtMs` for a kept refetch failure). §5.14: `thresholds: Thresholds \| null`, the component's optional `geoData`, `inspectorSource` and `onLoadFailed`, `ChartFrameProps.onSummary`, the Canvas 2D producer contract of the failure summary and `GeoMapBody`'s host-chunk boundary with Retry, then Reload. §5.16: `GeoMarkListProps` += `seq`, `rowSet`, `onActive`, `announce`; `geoMarkName` takes `thresholds`; `PanelTable` += `toggle`, `onInspectRow`, `rowNote`; the host answers `geo:` member ids from the request (no frame registers). §7: the `geoInRoute` bundle rule. §10.5: `unit:geo-inspect`'s k01 Logs chip follows T25-010 (with `f=env=prod` it is `{env="prod"}`; off with no filter) |
| 1.21-rc | 2026-11-27 | #216 Part 2b (I2): §5.2a: the registry holds `TEXT_DEF` and `BOARD_LIST_DEF` (4 × 8, `{kind: 'boardList'}`); `WidgetEditorBodyProps.onLocalInvalid`. §5.7: `boardListVis`, `BoardListEditorBody` (the inert, link-free preview over the debounced draft, Show, Search text or Tag, Rows, Order), `useDebounced`, `addTags`, `tagError`. T24-021: the editor's Search text refuses Cc and more than 100 code points locally and writes nothing; Done and Save wait for it. T24-029: the tags field, `setTags` deleting the key when the head had none, lower-casing on add, and the `/tags` text in the field too. §11: Part 2b landed, I2 complete |
| 1.22-rc | 2026-11-27 | #234 Part 4 (E2, the navigation stack): §5.16 records that the host answers `geo:` member ids from the open request's top view (`resolveGeoMembers`, pure) at any depth, replacing a per-frame registration ([T25](T25-inspector-and-pivots.md) §4.8); §10.5 gains `unit:geo-members-fullscreen`, and its O2 and N rows give the rows' names as the series names (lat and lon included) |
| 1.23-rc | 2026-11-27 | #290: §5.0 adds the units version (`vis.unit`, [T22](T22-value-categorical-and-table-panels.md) §6.2), the next free number (v8 or later) |
