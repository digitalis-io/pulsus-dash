# 02 — Information architecture

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Requirement area** | `IA` |
| **Source draft** | plans/02-information-architecture.md (not tracked) |
| **Depends on** | [01a](01a-audiences-and-perspectives.md), [03](03-interaction-model.md), [04](04-surfaces.md), [06](06-ai-copilot.md), [07](07-alerting.md), [11](11-enterprise.md), [13](13-core-flow-storyboard.md), [15](15-estate-navigation.md), [T11](../technical/T11-postgres-schema.md) |
| **Mockups** | [01-landscape-map](../mockups/01-landscape-map.svg), [22-topology-3d](../mockups/22-topology-3d.svg), [05-service-lens](../mockups/05-service-lens.svg), [09-alert-lens](../mockups/09-alert-lens.svg), [10-alerts-list-timeline](../mockups/10-alerts-list-timeline.svg), [13-investigation](../mockups/13-investigation.svg), [14-board](../mockups/14-board.svg) |

## 1. Purpose & scope

This document defines the small vocabulary of objects that every screen is composed of, the entity
model that is the backbone of the product, the navigation model (one space plus a few rooms), the
global chrome, the URL and state model, and the rules by which Context propagates across views.
How each surface uses these objects is in [04](04-surfaces.md); how the user moves is in
[03](03-interaction-model.md).

## 2. Definitions: core objects

The UI is built on these objects. The **Persisted** column is normative (IA-001).

| Object | Definition | Persisted |
|---|---|---|
| **Entity** | A thing that emits telemetry: region, cluster, namespace, service, deployment, pod/instance, host, database, queue, endpoint/route. Derived from OTel resource attributes + Prometheus `job`/`instance` + service-graph edges. Has a type, identity labels, parents and neighbours. | Derived catalogue, cached in PostgreSQL; user overrides (names, owners, tiers) in PostgreSQL |
| **Context** | The sticky tuple **(entity set, time window, filters, comparison baseline)** that every view reads. The single most important piece of UI state. | In the URL; saved with Boards and Investigations |
| **Scene** | Anything rendered on the GPU canvas: the Atlas, a Lens, a Board, a workbench. A scene is a tree of Viewports, each with a camera and a visualisation. | Boards and Lenses persist their scene definition |
| **Viewport** | One visualisation inside a scene (a "panel" in classic dashboard tools). Has a data binding (signal query or entity-relative template), vis type, camera/axes and overlays. | As part of its scene |
| **Lens** | An auto-generated, entity-type-specific scene: what you see when you focus a service (or a host, a pod, a DB). Templates are versioned and customisable per org/team. | Lens templates in PostgreSQL |
| **Edge Lens** | A Lens on a relationship (client → server edge): calls, failures, latency, spans, logs and changes of that interaction, in A/B mode. Opened by double-clicking an Atlas edge ([13](13-core-flow-storyboard.md) F3). | Template, like Lens |
| **Board** | A curated, hand-arranged scene (= a classic dashboard). Lives in a folder; has owners, versions and variables. | PostgreSQL |
| **Investigation** | A collaborative, time-ordered workspace for an incident: pinned evidence (snapshots of viewports with their Context), notes, AI findings, participants, status. Becomes the post-mortem. | PostgreSQL; snapshot payloads in object storage when configured, otherwise PostgreSQL |
| **Waypoint** | A saved camera position + Context ("bookmark a place in the space"). Personal or shared. | PostgreSQL |
| **Alert rule** | A condition over a query or an entity-relative template, with routing ([07](07-alerting.md)). | PostgreSQL; alert history and state in PostgreSQL |
| **Journey** | A business-level entity: a user-facing flow (Sign-in, Checkout) defined by entry routes/spans, success criteria, steps and optional business metrics (order value). Bridges altitude 5 ↔ 3 ([01a](01a-audiences-and-perspectives.md) §5.5). | PostgreSQL |
| **Perspective** | A named bundle of presentation defaults (home, layout, encodings, vocabulary, detail ceiling, …) for a role: NOC, SRE, Platform, Engineer, Business, Support, Exec ([01a](01a-audiences-and-perspectives.md) §7). | Built-ins + org overrides in PostgreSQL |
| **Incident** | A group of correlated alerts (by topology + time) with an owner, severity, probable origin and status. The unit of work for NOC and business users; links to an Investigation. | PostgreSQL |
| **Change** | Anything that changed: deploy/version transition, config, feature flag, scaling, failover, new log pattern, new error type. Feeds the Change Feed. | Ingested events, and Dash-derived change events in PostgreSQL |
| **Annotation / Event** | A point or range on the time axis: deploys, config changes, incidents, alert transitions, user notes. | PostgreSQL + ingested events |

#### IA-001 — Object vocabulary and persistence
**MUST** · M-UI1 · Admin, Platform

Every screen MUST be composed of the objects in §2, and each object MUST be persisted as stated in
the table. Dash-derived state (alert history and state, baselines, anomaly scores, derived change
events, fallback pyramids) MUST be stored in PostgreSQL and MUST NOT be written into PulsusDB
(decision D2, [ADR-0012](../adr/0012-derived-state-in-postgres.md); schema in
[T11](../technical/T11-postgres-schema.md)).

*Acceptance:* A schema review maps every persisted object in §2 to a PostgreSQL table (or, for
Investigation snapshot payloads, to object storage when configured); an end-to-end run of the
storyboard sends no write request from Dash to PulsusDB other than Dash self-telemetry and the
configured audit export.

#### IA-002 — Context is the one state every view reads
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every view MUST read its entity set, time window, filters and comparison baseline from the current
Context, and Context MUST be saved with every Board and Investigation evidence item.

*Acceptance:* Changing any of the four Context members updates every open viewport in the scene;
re-opening a saved Board or pinned evidence item restores its saved Context exactly.

#### IA-003 — Scenes are trees of viewports
**MUST** · M-UI1 · Platform, Engineer, SRE

Every GPU surface (Atlas, Lens, Board, workbench) MUST be a scene composed of a tree of viewports,
each with its own data binding (signal query or entity-relative template), visualisation type,
camera/axes and overlays.

*Acceptance:* Inspecting any scene lists its viewports with these four properties; a viewport moved
between scenes keeps them.

#### IA-004 — Lens templates
**MUST** · M-UI2 · SRE, Engineer, Platform, Admin

Focusing an entity MUST open the Lens generated from the template for its entity type. Lens
templates MUST be versioned and customisable per organisation and per team.

*Acceptance:* Focusing a service, a host, a pod and a database each opens a different template;
a team-level edit to the service template creates a new version used by that team only, and the
previous version can be restored.

#### IA-005 — Edge Lens
**MUST** · M-UI3 · SRE, Engineer

Double-clicking an Atlas edge MUST open an Edge Lens for that client → server relationship, showing
its calls, failures, latency, spans, logs and changes in A/B mode.

*Acceptance:* On the storyboard replay, double-clicking the payments → `psp-api` edge opens an Edge
Lens with the six listed elements, comparing the current window with the baseline.

#### IA-006 — Boards
**MUST** · M-UI5 · Platform, Engineer, NOC, Business

A Board MUST live in a folder and MUST have owners, a version history and variables.

*Acceptance:* Creating a Board in a folder, editing it twice and opening its history shows three
versions with author and time, each restorable; its variables appear in the Board header.

#### IA-007 — Investigations
**MUST** · M-UI4 · IC, SRE, Engineer, Platform

An Investigation MUST hold, in time order: pinned evidence (snapshots of viewports with their
Context), notes, AI findings, participants and status, and MUST be exportable as the post-mortem.

*Acceptance:* In INV-2041, pinning a viewport, adding a note and accepting an AI finding produce
three time-ordered items; re-opening the evidence restores its Context; "Export post-mortem"
produces a document containing all items.

#### IA-008 — Waypoints
**MUST** · M-UI3 · SRE, Platform, Engineer, NOC

A Waypoint MUST save a camera position and Context, and MUST be either personal or shared.

*Acceptance:* Saving a waypoint and later recalling it restores the same camera and Context; a shared
waypoint appears for other members of the team, a personal one does not.

#### IA-009 — Incident and investigation identifiers
**MUST** · M-UI4 · NOC, SRE, IC, Business, Support

An Incident MUST be identified as `INC-n`, and its Investigation MUST share the number as `INV-n`.

*Acceptance:* Opening an investigation from incident INC-2041 shows INV-2041, and `INV-2041` in the
command palette opens that investigation.

### 2.1 Entity model

```
Organisation
 └─ Tenant (PulsusDB `X-Scope-OrgID`; `X-Pulsus-Database` optionally selects an alternate ClickHouse database)
     └─ Environment (prod, staging…)            ← resource attr deployment.environment
         └─ Region / Zone                        ← cloud.region / cloud.availability_zone
             └─ Cluster                          ← k8s.cluster.name
                 └─ Namespace                    ← k8s.namespace.name
                     └─ Service                  ← service.name (+ service.namespace)
                         ├─ Workload / Deployment← k8s.deployment.name, service.version
                         │   └─ Instance / Pod   ← k8s.pod.name / service.instance.id
                         │       └─ Container / Process
                         └─ Operation / Route    ← span name, http.route
 Host / Node (cross-cuts: pods run on nodes)      ← host.name, k8s.node.name
 Journeys (business flows) ─ span over services ← entry routes / spans + success rules
 Customers / tenants (optional) ← enduser.id / tenant.id attributes (configurable, PII-governed)
 Dependencies (DBs, queues, external APIs)        ← peer.service, db.system, messaging.system
 Edges: service → service (rpc | messaging)       ← PulsusDB /api/traces/v1/service_graph
```

The infrastructure ladder and the crossing between application and infrastructure floors are in
[15](15-estate-navigation.md).

#### IA-010 — Entities are derived from telemetry
**MUST** · M-UI2 · SRE, Platform, Engineer, Admin

The entity catalogue MUST be derived from OTel resource attributes, Prometheus `job`/`instance` and
PulsusDB service-graph edges, using the default mapping above. Users MUST be able to override
display names, owners and tiers, stored in PostgreSQL.

*Acceptance:* On a seeded tenant with OTel-instrumented Kubernetes workloads and no entity
configuration, the catalogue contains the environment, region, cluster, namespace, service,
deployment, pod and route levels and the service → service edges; renaming a service and setting its
owner persists across reload.

#### IA-011 — Configurable entity schema
**MUST** · M-UI2 · Platform, Admin

An organisation MUST be able to define its entity schema (which attributes form which levels),
including hierarchies without Kubernetes. The OTel-semconv defaults above MUST ship out of the box.

*Acceptance:* An admin defines a schema of Environment → DC → Host → Process from custom attributes;
the catalogue and breadcrumb follow it, and a new tenant with no schema gets the default above.

#### IA-012 — Every signal row maps to an entity
**MUST** · M-UI2 · SRE, Engineer, Platform

Every metric series, log line, span and profile MUST map to an entity through its resource
attributes, so that focusing an entity shows its logs, traces and profiles with zero configuration.

*Acceptance:* On the seeded tenant, focusing `checkout` shows its logs, spans and profiles without
any per-service configuration; a row whose attributes match no entity is listed under "unmapped" in
the Coverage layer ([15](15-estate-navigation.md)).

#### IA-013 — Entities outside the user's scope
**MUST** · M-UI6 · Admin, NOC, SRE

Entities a user cannot see under RBAC MUST be rendered either as anonymous shapes or not at all,
according to the tenant's policy ([11](11-enterprise.md)), and MUST NOT reveal their name, labels or
telemetry.

*Acceptance:* With the policy set to "anonymous", a user without access to `payments` sees an
unlabelled shape in its place, with no tooltip content; with "hidden", the node and its edges are
absent.

## 3. Navigation model

Navigation is a space plus a few rooms, not a tree of pages.

```
                         ┌───────────────────────────────────────────────┐
                         │                 THE SPACE                      │
   ⌘K Command palette    │                                                │
   (go anywhere)  ─────► │   Atlas  ──zoom──►  Lens  ──zoom──►  Detail    │
                         │  (estate)         (entity)        (span/frame) │
                         │      ▲  pivot ◄──────────────►  Workbenches     │
                         │      │          Metrics · Logs · Traces · Prof │
                         └──────┼────────────────────────────────────────┘
                                │ pin / share
          ┌─────────────────────┼──────────────────────────────┐
          │              ROOMS (DOM-heavy, form-ish)            │
          │  Boards library · Investigations · Alerts · Admin   │
          └─────────────────────────────────────────────────────┘
```

[mockup](../mockups/01-landscape-map.svg)

#### IA-014 — The Space: camera transitions, never page loads
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

The Space (Atlas, Lenses, Boards in view mode, workbenches) MUST be GPU-rendered. Movement between
its scenes MUST be an animated camera transition of ≤ 250 ms (PRF-007 in
[09](09-performance-contract.md)), never a page load, and the previous scene MUST stay resident so
that "back" is instant.

*Acceptance:* Diving from the Atlas into a Lens and pressing `Esc` triggers no document navigation;
each transition completes in ≤ 250 ms, and the returning scene shows its previous data in the first
frame with no new query.

#### IA-015 — Rooms are conventional, accessible DOM
**MUST** · M-UI1 · Admin, Platform, Engineer, SRE

Rooms (Boards library, Investigations, Alerts, Admin) MUST be accessible DOM UIs that are fast and
fully keyboard-operable; they are not spatial.

*Acceptance:* Every control in every room is reachable and operable by keyboard alone, and the rooms
pass the WCAG 2.2 AA automated checks of [08](08-visual-language.md).

### 3.1 Global chrome

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◉ Pulsus  prod ▾ › eu-west-1 › k8s-core › checkout ▾        ⌘K Search…   ⚠ 3  ✦ AI  ☺ │ ← top bar (32 px)
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                  ( G P U   C A N V A S )                             │
│                                                                             ┌──────┐ │
│                                                                             │minimap│ │
│                                                                             └──────┘ │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ◀◀ ▶ LIVE  │▁▂▃▅▂▁▁▂▇█▆▃▂▁▁▁▂▃▂▁▁▁▁▂▃▂▁[====window====]▁▂▁│ -1h … now  ⟲ vs -7d   │ ← Time Ribbon (40 px)
└──────────────────────────────────────────────────────────────────────────────────────┘
```

| Element | Behaviour | Requirement |
|---|---|---|
| Top bar (32 px) | Logo menu, breadcrumb, command palette, alerts count, AI dock, avatar (Perspective switcher) | IA-016 |
| Breadcrumb | Depth gauge; each crumb is a dropdown of siblings | IA-017 |
| ⚠ n | Firing alerts relevant to the current Context; click → Alert drawer | IA-018 |
| ✦ AI | Copilot dock ([06](06-ai-copilot.md)) | IA-019 |
| Minimap | Landscape with viewport rectangle ([15](15-estate-navigation.md)) | IA-016 |
| Time Ribbon (40 px) | Global time control, always visible, a GPU chart ([03](03-interaction-model.md) §6) | IA-020 |
| No left sidebar | Rooms via ⌘K, logo menu or `g` chords | IA-021 |

#### IA-016 — Minimal global chrome
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

The Space MUST show only: a 32 px top bar (logo menu, breadcrumb, command palette entry, alert count,
AI dock toggle, avatar menu), the GPU canvas with a minimap in Space scenes that have a camera
extent, and a 40 px Time Ribbon.

*Acceptance:* At 1440×900, the top bar is 32 px high and the Time Ribbon 40 px, with the elements
listed; no other persistent chrome is shown.

#### IA-017 — Breadcrumb is a depth gauge
**MUST** · M-UI2 · SRE, Platform, Engineer, NOC

The breadcrumb MUST show where the camera is in the entity hierarchy, updating as the camera moves,
and each crumb MUST be a dropdown of that level's siblings so the user can jump laterally without
zooming out. Where both ladders apply it MUST show both ([15](15-estate-navigation.md)).

*Acceptance:* With the camera on `checkout`, the breadcrumb reads `prod › eu-west-1 › k8s-core ›
checkout`; opening the `checkout` crumb lists sibling services, and choosing one flies there without
passing through the cluster level.

#### IA-018 — Context-relevant alert count
**MUST** · M-UI4 · SRE, NOC, Engineer, Platform

The chrome MUST show two distinct alert indicators. The **global** `⚠ n` counts un-acked incidents for
the user's teams ([ALR-042](07-alerting.md#alr-042--global-incident-counter)). The **Context badge** on
the scene header counts firing alerts relevant to the current Context (its entity set and their
dependencies), not all alerts in the tenant. Clicking the Context badge MUST open the Alert drawer.

*Acceptance:* With 3 firing alerts on `checkout` and its dependencies and 20 elsewhere, focusing
`checkout` shows a Context badge of 3; clicking it opens the drawer listing those 3. The global
`⚠ n` is unaffected by focus.

#### IA-019 — AI dock in the chrome
**MUST** · M-UI4 · SRE, Engineer, Platform, IC, Business

The ✦ AI control MUST open and close the copilot dock ([06](06-ai-copilot.md)) from every Space
scene and every room.

*Acceptance:* ✦ toggles the dock in the Atlas, a Lens, a Board and each room, keeping the dock's
conversation.

#### IA-020 — Time Ribbon is always visible
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

The Time Ribbon MUST be visible in every Space scene, and MUST be a GPU chart showing an overview of
anomaly density and alert events across a long range, with the active window as a brush
([03](03-interaction-model.md) §6).

*Acceptance:* In every Space scene the Ribbon is present; its overview strip shows anomaly density
and alert glyphs beyond the active window, and dragging the brush changes the Context time.

#### IA-021 — No left navigation sidebar
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

There MUST be no left navigation sidebar by default. Rooms MUST be reachable through the command
palette, the logo menu and `g` chords (`g b` Boards, `g a` Alerts, `g i` Investigations; the full set
is in [03](03-interaction-model.md) §4.2).

*Acceptance:* A fresh user session shows no left sidebar; each room is reachable by `⌘K`, by the
logo menu and by its `g` chord.

## 4. URL & state model

Every view is deep-linkable and reproducible. The URL encodes Context + scene + camera.

| Pattern | Opens |
|---|---|
| `/t/{tenant}/space/{scene}?e={entityRef,...}&from=…&to=…&cmp=-7d&f={filters}&cam={compact camera}&persp={perspective}` | A Space scene (Atlas, Lens, Edge Lens, workbench) with Context and camera |
| `/t/{tenant}/board/{boardUid}?var-x=…&from=…&to=…&vp={focusedViewport}` | A Board with variables, time and focused viewport |
| `/t/{tenant}/inv/{investigationId}#evidence-{n}` | An Investigation, scrolled to evidence item n |
| `/t/{tenant}/incident/{incidentId}` | The Alert Lens (RCA card) for the incident |
| `/t/{tenant}/alerts/{view}?…` | The Alerts room, `view` = `map` \| `topology` \| `city` \| `infra` \| `segments` \| `list` \| `timeline` |

`persp` is present only when the sender pinned a Perspective ([01a](01a-audiences-and-perspectives.md)
AUD-048).

#### IA-022 — Deep links reproduce the view
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every Space scene, Board, Investigation, Incident and Alerts-room view MUST have a URL of the
patterns above that, when opened by another user with the same access, reproduces the same Context,
scene, focused viewport and camera.

*Acceptance:* For each pattern, copying the link and opening it in a fresh session renders the same
entities, window, filters, baseline, scene, focus and camera pose (position, zoom, 3D angle).

#### IA-023 — Shared links pin absolute time
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, IC

"Copy link" MUST convert relative time (e.g. `now-1h`) to absolute by default, and MUST offer an
option to keep it relative.

*Acceptance:* With the window "last 1 h" at 13:03, "Copy link" yields `from`/`to` of 12:03–13:03 as
absolute timestamps; with "keep relative" selected, the link carries `now-1h`.

#### IA-024 — Compact camera encoding
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

The camera MUST be encoded compactly in the `cam` parameter (base64 of a small struct) so that a
shared link opens exactly the same view, zoom and 3D angle.

*Acceptance:* The `cam` value is ≤ 64 characters for every camera mode, and decoding it restores the
pose to within one pixel of the original at the same viewport size.

#### IA-025 — Browser history is camera history
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

Browser back/forward MUST step through camera history, and `Alt+←` / `Alt+→` MUST do the same while
focus is inside the canvas ([03](03-interaction-model.md)).

*Acceptance:* After three committed camera moves, browser back three times returns through each pose
in reverse; `Alt+←` in the canvas does the same.

## 5. Context propagation rules

| Action | Entity set | Time | Filters | Baseline |
|---|---|---|---|---|
| Zoom into child entity | narrows to child | kept | kept (if applicable) | kept |
| Pivot to another signal | kept | kept | translated (label ⇄ attribute names) | kept |
| Brush a time range on any chart | kept | **set to brush** (with undo) | kept | kept |
| Click a span / log line | narrows to its instance | **keeps window**, adds a *focus instant* marker | adds `trace_id` | kept |
| Open a Board | Board's variables, seeded from Context where names match | kept unless the Board pins time | Board's | kept |
| Pin to Investigation | snapshot of all four | snapshot | snapshot | snapshot |

#### IA-026 — Context propagation
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Each action in the table above MUST change the four Context members exactly as the table states. A
time change from a brush MUST be undoable ([03](03-interaction-model.md) §9).

*Acceptance:* For each row, a scripted test performs the action and asserts each Context member's
resulting value; brushing then `⌘Z` restores the previous window.

#### IA-027 — Label ⇄ attribute translation
**MUST** · M-UI2 · SRE, Engineer, Platform, Admin

Filters MUST be translated between signal vocabularies on pivot using a per-tenant mapping table
(e.g. OTel `service.name` ⇄ PulsusDB metrics `job` in `namespace/name` form, with other resource
attributes only on `target_info` ⇄ Loki label `service_name`). The table MUST be pre-seeded from the
OTLP translation rules PulsusDB implements, and MUST be editable per tenant.

*Acceptance:* A filter `service.name=checkout` on traces pivots to metrics as `job=~".*/checkout"`
(or the tenant's mapped form) and to logs as `service_name="checkout"`; adding a custom mapping
changes the translation on the next pivot.

## 6. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| IA-001 | Object vocabulary and persistence | MUST | M-UI1 |
| IA-002 | Context is the one state every view reads | MUST | M-UI1 |
| IA-003 | Scenes are trees of viewports | MUST | M-UI1 |
| IA-004 | Lens templates | MUST | M-UI2 |
| IA-005 | Edge Lens | MUST | M-UI3 |
| IA-006 | Boards | MUST | M-UI5 |
| IA-007 | Investigations | MUST | M-UI4 |
| IA-008 | Waypoints | MUST | M-UI3 |
| IA-009 | Incident and investigation identifiers | MUST | M-UI4 |
| IA-010 | Entities are derived from telemetry | MUST | M-UI2 |
| IA-011 | Configurable entity schema | MUST | M-UI2 |
| IA-012 | Every signal row maps to an entity | MUST | M-UI2 |
| IA-013 | Entities outside the user's scope | MUST | M-UI6 |
| IA-014 | The Space: camera transitions, never page loads | MUST | M-UI1 |
| IA-015 | Rooms are conventional, accessible DOM | MUST | M-UI1 |
| IA-016 | Minimal global chrome | MUST | M-UI1 |
| IA-017 | Breadcrumb is a depth gauge | MUST | M-UI2 |
| IA-018 | Context-relevant alert count | MUST | M-UI4 |
| IA-019 | AI dock in the chrome | MUST | M-UI4 |
| IA-020 | Time Ribbon is always visible | MUST | M-UI1 |
| IA-021 | No left navigation sidebar | MUST | M-UI1 |
| IA-022 | Deep links reproduce the view | MUST | M-UI1 |
| IA-023 | Shared links pin absolute time | MUST | M-UI1 |
| IA-024 | Compact camera encoding | MUST | M-UI1 |
| IA-025 | Browser history is camera history | MUST | M-UI1 |
| IA-026 | Context propagation | MUST | M-UI1 |
| IA-027 | Label ⇄ attribute translation | MUST | M-UI2 |

## 7. Resolved during formalisation

1. **Where derived state lives.** The draft said Change is "ingested events + derived" without a
   store. Under D2, derived change events, alert history and state, baselines and anomaly scores are
   in PostgreSQL and never written to PulsusDB (IA-001).
2. **Entity catalogue cache.** The draft said "derived (cached catalogue)" without a location. It is
   cached in PostgreSQL (detailed in [T12](../technical/T12-entity-catalogue.md)).
3. **Investigation snapshot payloads.** The draft put them in "object store". Object storage is
   optional ([ADR-0009](../adr/0009-optional-object-storage.md), Proposed); without it, payloads are
   stored in PostgreSQL.
4. **Pinned Perspective in links.** [01a](01a-audiences-and-perspectives.md) lets a sender pin a
   Perspective, but the draft URL had no parameter for it. Added `persp`.
5. **Lens and workbench routes.** The draft had no distinct route for Lens, Edge Lens or workbench;
   they are Space scenes under `/space/{scene}`.
6. **Alerts-room view names.** The URL `list` view is the Explorer with alert columns
   (`Alt+6` in [03](03-interaction-model.md)); `timeline` is `Alt+7`, which exists in the Alerts room.
7. **Minimap scope.** The chrome sketch shows a minimap always; a minimap is meaningless on a single
   chart workbench, so IA-016 requires it only in scenes with a camera extent (Atlas, estate views,
   Boards).
8. **`job` translation example.** The draft example's `job` format is `namespace/name`; the
   acceptance criterion uses a regex match on the name part, or the tenant's mapped form.

## 8. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft |
