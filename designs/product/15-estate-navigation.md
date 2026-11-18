# 15 — Estate navigation: from the whole landscape down to a container

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc2 · 2026-11-18 |
| **Requirement area** | `EST` |
| **Source draft** | plans/15-estate-navigation.md (not tracked) |
| **Depends on** | [02 Information architecture](02-information-architecture.md) · [03 Interaction model](03-interaction-model.md) · [04 Surfaces](04-surfaces.md) · [05 Visualisation catalogue](05-visualisation-catalogue.md) · [07 Alerting](07-alerting.md) · [09 Performance contract](09-performance-contract.md) · [11 Enterprise](11-enterprise.md) · [01a Audiences & perspectives](01a-audiences-and-perspectives.md) |
| **Technical designs** | [T02 Vis engine](../technical/T02-vis-engine.md) · [T06 BFF architecture](../technical/T06-bff-architecture.md) · [T07 Scene query planner](../technical/T07-scene-query-planner.md) · [T11 Postgres schema](../technical/T11-postgres-schema.md) · [PulsusDB requirements](../technical/pulsusdb-requirements.md) · T12 entity catalogue (draft) · T13 local analytics engine (draft) · T14 layout engines (draft) |
| **Decisions** | [ADR-0012](../adr/0012-derived-state-in-postgres.md) (D2) · assumption A1 · open decision O1, [ADR-0013](../adr/0013-metrics-data-scopes.md) |
| **Mockups** | [01-landscape-map](../mockups/01-landscape-map.svg) · [22-topology-3d](../mockups/22-topology-3d.svg) · [03-infra-cluster](../mockups/03-infra-cluster.svg) · [04-segments-matrix](../mockups/04-segments-matrix.svg) · [05-service-lens](../mockups/05-service-lens.svg) · [15-command-palette](../mockups/15-command-palette.svg) · [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg) · [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg) · [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg) · [21-floors-3d](../mockups/21-floors-3d.svg) · [22-topology-3d](../mockups/22-topology-3d.svg) · [23-semantic-zoom-flight](../mockups/23-semantic-zoom-flight.svg) · [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg) |

Section numbers §1–§12 are kept identical to the source draft because other documents cite them
(e.g. "15 §3.3").

## 0. Purpose & scope

How a user sees **everything they run** in one place and zooms, without ever losing their place,
down to one region, cluster, node, pod, host or process; and how they cross between **where things
run** (infrastructure) and **what calls what** (applications).

**Space is 3D, signals are 2D.** The estate is a GPU-rendered 3D world that the user navigates like
a game: an orbiting camera over a ground plane on which regions are plateaus, clusters are districts,
nodes are buildings and pods are the floors inside them, with the application topology floating as
an upper floor above. Time series, distributions, tables, logs, trace waterfalls and flame graphs
stay 2D and dock beside the scene, linked to it (EST-055, EST-064). Every 3D view has a 2D
equivalent on `T`, which is also the accessibility and reduced-motion fallback (EST-063).

This document is normative for the estate experience. It consolidates and extends the Atlas
([04](04-surfaces.md) §4.1), semantic zoom ([03](03-interaction-model.md) §5), the entity model
([02](02-information-architecture.md) §1.1) and the alert views ([07](07-alerting.md) §3); those
sections point here. Everything in this document lands in **M-UI3** unless a requirement says
otherwise.

**Questions the estate must answer**

| Question | Who |
|---|---|
| What do we run, where, and is it healthy? | Everyone; NOC; Business (execs) |
| Is the problem everywhere or in one place? | NOC, SRE |
| What runs on this node / what does this service run on? | Platform, SRE |
| Which infrastructure is this application's problem sitting on, and who else shares it? | Engineer, Platform |
| Where are we over- or under-provisioned, and what does it cost? | Platform (incl. FinOps) |
| Which parts of the estate are blind (no logs / traces / profiles)? | Platform, SRE leads |
| What versions are running where (app, k8s, OS, kernel, runtime)? | Platform, Security, Release |

**Definitions**

| Term | Meaning |
|---|---|
| **Landscape** | Level 0: the whole estate framed at once (§2) |
| **Ladder** | An ordered sequence of zoom levels: the infrastructure ladder L0–L5 and the application ladder A0–A5 (§3) |
| **Floor** | The app floor (dependency graph) or the infra floor (the containment city), stacked on the height axis with the app floor above (§3.3) |
| **3D world** | The perspective scene in which the estate is drawn by default: a ground plane carrying regions as plateaus, clusters as districts, nodes as buildings, pods as slabs and containers as cells (§3.4) |
| **Building** | The 3D mark of a node or host: footprint ∝ capacity, height ∝ utilisation or load |
| **Beacon** | A vertical light column rising from the probable origin ⊕ of an incident |
| **Altitude ladder** | The on-screen indicator of the camera's current level L0–L5 ([03](03-interaction-model.md) INT-043) |
| **2D equivalent** | The flat projection of a 3D view reached with `T` (e.g. hex grid for Infra, layered graph for Topology) |
| **Runs-on thread** | A line dropping from an app-floor entity to the buildings or pod slabs it runs on, drawn only for the selection |
| **Crossing chip** | An Inspector chip that moves the camera across the ladders (e.g. "runs on 14 pods / 6 nodes") |
| **View** | One of the six synced projections of the landscape (§5) |
| **Layer** | A preset of colour, size and badge bindings shared by all views (§7) |
| **Container (spatial)** | Any entity that has children on a ladder (region, cluster, node…) |
| **Care score** | Ranking of entities by how much attention they need ([01a](01a-audiences-and-perspectives.md) §2.3) |

## 1. The landscape model: one entity set, three graphs

The entity model is one set of entities connected by three kinds of relationship, plus the runs-on
bridge between them. Every view in this document is a projection of one or more of them.

| Graph | Shape |
|---|---|
| **Containment** (where it runs) | Planet → Region / Data centre → Zone / Hall → Cluster or Cloud account → Node pool, ASG or Rack → Node or Host → Pod or VM → Container or Process |
| **Dependency** (who calls whom) | Directed call graph, e.g. gateway → checkout → payments → psp-api, with checkout → pg-orders and → kafka:orders |
| **Ownership** (whose / what for) | Business unit → Team → Service; Journeys span services; Customer / plan (optional) |
| **Runs-on** (cross-links) | service ⇄ workload ⇄ pods ⇄ nodes; managed DB instance ⇄ services using it; LB ⇄ backends |

**Table 15-1 — Relationship derivation**

| Relationship | Derived from (zero config, OTel semconv) | Notes |
|---|---|---|
| Containment | `cloud.provider`, `cloud.account.id`, `cloud.region`, `cloud.availability_zone`, `k8s.cluster.name`, `k8s.node.name`, `k8s.namespace.name`, `k8s.pod.name`, `container.name`, `host.name`, `process.pid`; on-prem DC/rack from configurable attributes or CMDB import | Configurable entity schema; on-prem and non-k8s estates supported. For metrics, resource attributes sit on `target_info`, not on each series, so they are joined ([R16](../technical/pulsusdb-requirements.md)) |
| Dependency | PulsusDB `service_graph` (rpc + messaging), `peer.service`, `db.system`/`db.name`, `messaging.destination.name`, `server.address` for external APIs | Edges carry calls, failed, latency ([04](04-surfaces.md) §4.1) |
| Ownership | `service.namespace`, team labels/annotations, CODEOWNERS / Backstage catalogue import, Journey definitions ([04](04-surfaces.md) §4.14) | Drives routing ([07](07-alerting.md) §6) |
| **Runs-on** | Co-occurrence of `service.name` with `k8s.pod.name` / `k8s.node.name` / `host.name` in the same resource | The bridge between the two ladders (§3.3). Needs the entity inventory to return attribute *combinations*, not just values ([R3](../technical/pulsusdb-requirements.md)) |

#### EST-001 — Zero-config relationship derivation
**MUST** · M-UI3 · Platform, SRE, Engineer

Dash MUST derive containment, dependency, ownership and runs-on relationships from the sources in
Table 15-1 with no configuration when OTel semantic-convention attributes are present. The entity
schema MUST be configurable so that on-prem and non-Kubernetes estates (DC, hall, rack, host) are
represented.

*Acceptance:* Given a fixture estate emitting OTel semconv attributes for 3 clusters and 1 on-prem DC
with rack attributes mapped in the schema, when the Atlas opens, then every pod appears under its
node, cluster, zone and region; every host appears under its rack and DC; and service dependency
edges match `service_graph`.

#### EST-002 — Runs-on from co-occurrence
**MUST** · M-UI3 · Platform, SRE, Engineer

Runs-on links MUST be derived from co-occurrence of `service.name` with pod, node or host attributes
in the same resource, and MUST track first/last seen.

*Acceptance:* Given checkout running on 14 pods across 6 nodes, when checkout is selected, then its
crossing chip reads "runs on 14 pods / 6 nodes" and the pod set matches the inventory.

#### EST-003 — Entity kinds on the landscape
**MUST** · M-UI3 · Platform, SRE, NOC

The landscape MUST show these entity kinds:
- compute: cluster, node, pod, container, VM/host, process, serverless function;
- data: managed databases, caches, queues/streams, object storage;
- network: load balancers / ingress / API gateways, CDN, DNS, NAT/egress;
- external SaaS dependencies (e.g. PSP, auth provider), drawn **outside the estate boundary**;
- telemetry pipeline entities (collectors, PulsusDB itself), so that "the monitoring is the problem"
  is visible.

*Acceptance:* Given a fixture with one entity of each kind, when the Landscape opens, then each kind is
drawn with its glyph, external SaaS sit outside the estate boundary, and the PulsusDB entity has a
health state.

#### EST-004 — Inventory connectors and inventory-only entities
**SHOULD** · M-UI5 · Platform, Admin

Dash SHOULD offer optional inventory connectors (AWS Config, Azure Resource Graph, GCP Asset
Inventory, a CMDB, Backstage), run in the BFF, for cloud inventory absent from telemetry. Derivation
from telemetry MUST remain the default. An entity seen only through a connector MUST be drawn outlined,
not filled, with an "inventory only, no telemetry" mark, and MUST count as a coverage finding (§7).

*Acceptance:* Given an AWS Config connector reporting an idle RDS instance with no clients, when the
Landscape opens, then the instance is drawn outlined with the inventory-only mark and is counted in
the estate strip's "blind" total.

## 2. Level 0: the Landscape (the starting point)

Mockups: [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg) (default 3D),
[01-landscape-map](../mockups/01-landscape-map.svg) (2D equivalent under `T`).

**Landscape regions**

| Region | Contents |
|---|---|
| Top bar | "Atlas · Landscape", environment scope (e.g. "all environments ▾"), view switcher (Map · Topology · City · Infra · Segments · Explorer), ⌘K |
| Layer bar | Layer selector (Health · Capacity · Cost · Change · Versions · Coverage · Traffic) and Floors toggle (App · Infra) |
| Scene | The 3D world in an Orbit camera: provider groups (e.g. cloud A, cloud B, on-prem) as islands on the ground plane, each carrying region/DC plateaus placed by geography; the outside-the-estate ring of external dependencies on the horizon |
| Camera aids | Orbit gizmo / compass and altitude ladder L0–L5 ([03](03-interaction-model.md) INT-043, INT-044) |
| Estate strip | Totals by kind (clusters, nodes, pods, hosts, services, DBs, incidents, blind); every number is a filter |
| Minimap, Time Ribbon | As in every space |

#### EST-005 — Home frames the whole estate
**MUST** · M-UI3 · NOC, SRE, Platform

Opening the Atlas with no Context, or pressing `Home`, MUST frame the whole estate at Level 0 in the
default Orbit pose of the 3D world (EST-055). When the estate has only one region, it MUST open
directly at Level 1 for that region.

*Acceptance:* Given a multi-region estate, when the user presses `Home` from a pod Lens, then the
camera flies up the altitude ladder in one continuous flight (EST-060) and frames every provider
group in the Orbit pose; and given a single-region estate, the Atlas opens on that region's
L1 view.

#### EST-006 — Grouped by provider, then geography
**MUST** · M-UI3 · NOC, Platform

The Landscape MUST group regions and data centres by provider (cloud or on-prem), then by geography.
When the estate spans more than one region, the Map view MUST be the default view unless the
Perspective sets another (§10). The Map view MUST be the 3D world with each provider group drawn as
an island and each region or DC as a plateau placed by geography on a low-relief ground plane
([05](05-visualisation-catalogue.md) §3, §7), seen through the Orbit camera; its flat geographic
map is the 2D equivalent under `T`.

*Acceptance:* Given cloud A (3 regions), cloud B (1) and on-prem (2 DCs), when the Landscape opens
with no Perspective default, then the Map view shows three islands carrying six plateaus placed
geographically, in perspective with the Orbit camera; and `T` shows the same groups on the flat map.

#### EST-007 — Region and DC tiles
**MUST** · M-UI3 · NOC, Platform, SRE

Each region or DC plateau (tile in the 2D equivalent) MUST show its worst health state, incident
count, entity counts by kind, and a sparkline of the active layer's headline metric (e.g. error rate,
utilisation, $/h). In 3D these MUST be carried by a billboard label (EST-059); the plateau's top face
MUST carry the health colour (EST-058).

*Acceptance:* Given us-east-1 degraded with one incident, when the Landscape renders, then its
plateau is tinted `degraded` and its label shows the degraded glyph, "⚠1", its cluster and pod counts, and a sparkline that changes when the
layer changes.

#### EST-008 — Outside-the-estate ring
**MUST** · M-UI3 · NOC, SRE

External dependencies the estate calls MUST be drawn outside the estate boundary (in 3D, as a ring
of markers at the edge of the ground plane joined to their callers by arcs), each with its health as
seen from our client spans.

*Acceptance:* Given client spans to `psp-a` failing at 20 %, when the Landscape renders, then psp-a
outside the boundary shows a failing state derived from those spans.

#### EST-009 — Estate strip numbers are filters
**MUST** · M-UI3 · NOC, Platform, SRE

The estate strip MUST show totals by kind, plus incidents and blind entities, and clicking any number
MUST highlight the entities it counts.

*Acceptance:* Given "3 blind" in the strip, when the user clicks it, then exactly three entities are
highlighted on the Landscape and the rest are dimmed.

## 3. Two zoom ladders and where they cross

### 3.1 Infrastructure ladder ("where it runs")

**Table 15-2 — Infrastructure ladder**

| Level | Container platform | Cloud managed | VM / on-prem | Default vis (3D; 2D equivalent under `T`) | Typical on screen |
|---|---|---|---|---|---|
| L0 Landscape | providers + regions | providers + regions | data centres | Map: 3D world of islands and plateaus (§2); 2D: flat map | 5–50 plateaus |
| L1 Region / DC | zones → clusters | zones → accounts | halls/rooms → racks | Region plateau with zone terraces and cluster districts (§4.1); 2D: zone columns | 10–200 |
| L2 Cluster / Account / Room | node pools / namespaces | service types (managed DB, stream, cache…) | rack row | **Infra city**: buildings grouped into blocks ([05](05-visualisation-catalogue.md) §3; §4.2); 2D: infra grid (hexbin wall) | 100–100k buildings |
| L3 Node / Instance / Rack | pods on node | DB instance, replicas, shards | rack (U-slots) | **Building cut-away**: pods as floor slabs (§4.3); racks as cabinets (§4.4); 2D: packing bar / rack elevation | 10–300 |
| L4 Pod / VM / Host | containers | — | processes | Lens (USE, logs, profiles) | 1 entity |
| L5 Container / Process | — | — | — | Lens + profiles | 1 |

### 3.2 Application ladder ("what calls what")

**Table 15-3 — Application ladder**

| Level | What | Default vis |
|---|---|---|
| A0 Estate | environments → domain/team territories | Topology with super-nodes ([04](04-surfaces.md) SRF-006) |
| A1 Territory | services of a team/domain + boundary edges | Topology |
| A2 Service | service Lens: RED, logs, span scatter, dependencies | Lens ([04](04-surfaces.md) §4.2) |
| A3 Workload / version | per-version compare, rollout state | Lens + Release compare ([04](04-surfaces.md) §4.15) |
| A4 Instance | one pod/process as the service sees it | Lens |
| A5 Operation → Request → Code | route → trace waterfall → flame | [03](03-interaction-model.md) §5 |

#### EST-010 — Both ladders with their default vis
**MUST** · M-UI3 · Platform, SRE, Engineer, NOC

Zooming MUST move through the levels of Tables 15-2 and 15-3, and each level MUST open in its listed
default vis. Container-platform, cloud-managed and VM/on-prem estates MUST each follow their column
of Table 15-2. L0–L3 MUST open in their 3D default vis unless the 2D fallback of EST-063 is in force.

*Acceptance:* Given a container-platform estate, when the user dives from L0 to L5 on one container,
then the scenes are the 3D world of plateaus, the region plateau with cluster districts, the infra
city, the node's building cut-away, pod Lens and container Lens in order, as one continuous flight
(EST-060); and given a team territory at A1, diving reaches the service Lens at A2.

### 3.3 Crossing the ladders: the two floors

The relationship between applications and infrastructure is the most important missing link in most
tools, and the place where 3D earns its keep: the height axis encodes a real dimension, the layer of
the stack. The **infra floor** is the 3D city on the ground plane; the **app floor** is the
application topology floating as an upper floor above it; **runs-on threads** drop from services to
the buildings and pod slabs they run on, for the current selection only. Mockup:
[21-floors-3d](../mockups/21-floors-3d.svg).

#### EST-011 — `V` flips between floors
**MUST** · M-UI3 · Engineer, Platform, SRE

Pressing `V` on a service MUST move the camera down to the infra floor, framed on the buildings of
the nodes running it, with its pod slabs highlighted. Pressing `V` on a node MUST move the camera up
to the app floor with the services hosted there highlighted.

*Acceptance:* Given checkout focused, when the user presses `V`, then the infra floor shows the 6
nodes running checkout framed with its 14 pods highlighted; pressing `V` on one of those nodes shows
the app floor with its hosted services highlighted.

#### EST-012 — Hold `V` shows both floors
**MUST** · M-UI3 · Engineer, Platform, SRE

Holding `V` MUST show both floors at once joined by runs-on threads for the current selection only,
never for all entities. By default the camera MUST pull back and tilt to show the **3D floors**: the
app floor floating above the infra city, with each thread dropping from the selected service to the
buildings, nodes or pods it runs on. When the 2D equivalent is in force (`T`, or the fallback of
EST-063), both floors MUST instead be shown as a split view, app topology above and infra grid below,
with the same threads and linked highlighting. Releasing `V` MUST return to the prior floor and pose.

*Acceptance:* Given checkout selected, when the user holds `V`, then within 250 ms the camera shows
the app floor above the infra city with threads only from checkout to its 6 buildings and 14 pod
slabs; after `T`, holding `V` shows the split view with the same threads; and releasing `V` returns
to the prior floor at its previous pose.

#### EST-013 — Crossing chips
**MUST** · M-UI3 · Platform, SRE, Engineer

Every Inspector MUST show crossing chips that fly the camera across the ladders:
- service: "runs on N pods / M nodes";
- node: "hosts N pods of M services";
- DB instance: "used by N services";
- load balancer: "fronts N services".

*Acceptance:* Given a node Inspector reading "hosts 23 pods of 9 services", when the chip is clicked,
then the camera moves to the app floor with exactly those 9 services highlighted.

#### EST-014 — Noisy-neighbour detection
**MUST** · M-UI3 · SRE, Platform, Engineer

When a service is degraded and its pods share nodes with a saturated co-tenant, its crossing chip MUST
say so (e.g. "2 of 6 nodes CPU-saturated by `batch-etl`"). The same signal MUST be available to RCA
stage 1 ([06](06-ai-copilot.md)).

*Acceptance:* Given payments degraded and `batch-etl` using 3.1× its CPU request on 2 of payments' 6
nodes, when payments is selected, then the chip reads "2 of 6 nodes CPU-saturated by batch-etl" and
the RCA stage 1 evidence includes it.

### 3.4 The estate as a 3D world

Containment is drawn as one continuous 3D world ([05](05-visualisation-catalogue.md) VIZ-074).
Mockups: [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg),
[20-city-cluster-3d](../mockups/20-city-cluster-3d.svg),
[23-semantic-zoom-flight](../mockups/23-semantic-zoom-flight.svg).

**Table 15-9 — Containment as a 3D world**

| Entity | 3D form | Encodings |
|---|---|---|
| Provider | Island on the ground plane | Outline only; label |
| Region / DC | Raised plateau, placed by geography where coordinates are known | Top-face health colour; zone terraces |
| Cluster / account | City district on the plateau | Block boundary hairline; control-plane health on its label |
| Node / host | Building | Footprint ∝ capacity (allocatable CPU); height ∝ utilisation or the layer's load metric |
| Pod / VM | Floor slab, or stacked block, inside its building; shown by cut-away on focus | Slab thickness ∝ CPU request; fill ∝ usage |
| Container / process | Cell within a slab | Health colour |
| Rack / data hall (physical-layout variant) | Rack cabinet in rows on the hall floor; hosts as U-slot blocks | As node / host |

**Table 15-10 — 3D encodings**

| Channel | Encodes |
|---|---|
| Height | Load or utilisation (the active layer's size metric, Table 15-5) |
| Footprint | Capacity |
| Colour | Health, using the state tokens of [08](08-visual-language.md); healthy entities are near-monochrome neutral grey |
| Glow / bloom | ∝ anomaly score ([08](08-visual-language.md) VL-004) |
| Vertical light beacon | Probable origin ⊕ ([08](08-visual-language.md) VL-005) |
| Desaturation + dashed ground ring | Victim |
| Arc with traffic particles | Edge (calls, replication, cross-zone traffic) |
| Billboard label with leader line | Name and headline value, LOD-culled, never overlapping |

## 4. Per-level design

### 4.1 L1: Region / DC

**Regions:** a header (region name, zone/cluster/account/pod counts); one terrace per zone across the
region plateau (one column per zone in the 2D equivalent); clusters as districts and managed-service
groups (e.g. "managed DB ×12") as blocks within zones; a footer for cross-zone and
cross-region traffic (e.g. "cross-zone 3.1 GB/s, $412/day"; "to us-east-1: replication lag 0.8 s").

#### EST-015 — Zones as columns, clusters as bands
**MUST** · M-UI3 · NOC, Platform, SRE

At L1, zones MUST be drawn as parallel terraces across the region plateau (columns in the 2D
equivalent), and a cluster that spans zones MUST be drawn as one district band across those terraces,
so that a zonal failure appears as one stripe. Cross-zone and cross-region traffic MUST be drawn as
arcs with traffic particles carrying the cost and latency layers.

*Acceptance:* Given prod-eu-1 spanning three zones with zone 1b failing, when L1 renders, then the
cluster is one district band across three terraces with only the 1b segment in failing state, and
`T` shows the same as one band across three columns; and the Cost
layer labels the cross-zone arc with $/day.

### 4.2 L2: Cluster: the infra city

By default a 3D city: one building per node, grouped into blocks by the chosen dimension. Its 2D
equivalent under `T` is the hexbin wall specified for alerts ([07](07-alerting.md) §3.3), in all its
modes. Mockups: [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg) (3D),
[03-infra-cluster](../mockups/03-infra-cluster.svg) (2D equivalent).

#### EST-016 — Infra grid grouping and cells
**MUST** · M-UI3 · Platform, NOC, SRE

The infra city MUST group buildings into blocks by node pool, zone, namespace, workload, instance
type, or platform/kernel version. A building MUST be a node by default; when zoomed past the
expansion threshold (§6) or after `Enter` on a node, the building MUST cut away to show its pods as
floor slabs. Building colour, footprint and height MUST follow the active layer (§7, Table 15-10); the
default is health colour, footprint = allocatable CPU and height = CPU utilisation. In the 2D
equivalent the same rules apply to grid cells (a node cell; pod cells when expanded; colour and size
from the layer).

*Acceptance:* Given prod-eu-1, when the user groups by instance type, then buildings regroup into new
blocks with an animated tween; `Enter` on a node cuts its building away to show its pod slabs; and
after `T` the hex grid shows the same grouping with node cells.

#### EST-017 — Cluster header strip
**MUST** · M-UI3 · Platform, SRE

The infra city (and its 2D grid) MUST show a cluster header strip with control-plane health (API server latency, etcd,
scheduler queue), version, autoscaler activity and pending pods, so that an unhealthy cluster is
visible even when every node is fine.

*Acceptance:* Given healthy nodes but API server p99 at 4 s, when L2 renders, then the header strip
shows the control plane degraded.

#### EST-018 — Lasso and Compare across cells
**MUST** · M-UI3 · Platform, SRE

Lassoing buildings (cells in the 2D equivalent) and pressing `B` MUST run Universal Compare across
them against the rest of the cluster. In 3D the lasso MUST select every building whose screen
footprint lies inside it, including those partly occluded.

*Acceptance:* Given failing nodes that are all `m6i.4xlarge` in eu-west-1b on kernel 6.8.0-1021, when
the user lassoes them and presses `B`, then those three attribute values rank top in Different.

### 4.3 L3: Node: the building cut-away and packing view

By default the node's building is cut away to show one floor slab per pod; the packing bar below is
the 2D equivalent and is also shown in the node's Inspector.

**Regions:** a header (node name, instance type, zone, pool, kernel, health); CPU and memory bars
showing requested and used; the packing bar of pods; a conditions line (disk, network, conntrack,
restarts with reasons such as OOMKilled); and actions.

#### EST-019 — Packing bar
**MUST** · M-UI3 · Platform, SRE

The node packing view MUST show one segment per pod with width ∝ CPU request and fill ∝ usage, with
the limit marked, and MUST flag pods using more than their request. Node CPU and memory MUST be shown
as requested vs used. In the 3D cut-away the same rules MUST apply to the pod slabs (thickness ∝
request, fill ∝ usage, an overflowing slab bulging past the building's wall with ▲), and the packing
bar MUST be shown in the node's Inspector.

*Acceptance:* Given ip-10-4-7-21 with batch-etl using 3.1× its request, when L3 renders, then
batch-etl's segment overflows its request width with ▲ and the label "3.1× its request", and the CPU
bar shows 78 % requested and 91 % used.

#### EST-020 — Node conditions and actions
**MUST** · M-UI3 · Platform, SRE

The packing view MUST show disk, network, conntrack and restart counts with reasons (e.g. "payments-7f9
OOMKilled ×3"), and MUST offer: `V` to the services on this node; "Compare with pool peers" (`B`
against the node's siblings); "Cordon…" as an audited action ([11](11-enterprise.md)); and "Open host
Lens" (`Enter`).

*Acceptance:* Given the node, when the user chooses "Compare with pool peers", then Compare runs with
the node as selection and the rest of pool general as baseline; and "Cordon…" requires confirmation
and writes an audit entry.

### 4.4 L3 (on-prem): Rack elevation

#### EST-021 — Rack elevation
**MAY** · M-UI5 · Platform, NOC

For data-centre estates, Dash MAY provide the physical-layout variant of the 3D world: each rack a
cabinet standing in its row on the hall floor, each host a U-slot block at its position, coloured by
the active layer, with PDU/power and top-of-rack switch health from SNMP/Redfish telemetry when
present. At L2, rows of racks MUST then stand side by side so the hall reads like the real floor. The
front-of-rack elevation is its 2D equivalent.

*Acceptance:* Given a rack with hosts in U10–U30 and Redfish telemetry, when L3 renders, then each host
sits at its U position, PDU health is shown, and the label "rack 14, U22" identifies a host.

### 4.5 L4–L5: Pod / VM / Host / Container / Process

#### EST-022 — Workload Lenses with crossing chips
**MUST** · M-UI3 · Platform, SRE, Engineer

L4–L5 MUST be Lenses ([04](04-surfaces.md) §4.2) showing USE, logs, events (k8s events, restarts,
OOM), profiles and the processes or containers inside, with crossing chips up (service) and down
(node/host). Kubernetes object state MUST be shown as a state timeline
([05](05-visualisation-catalogue.md) §1) covering spec vs status, rollout history, HPA decisions and
probe failures.

*Acceptance:* Given a pod with 3 OOM restarts and an HPA scale-up, when its Lens opens, then the state
timeline shows the restarts and the HPA decision, and chips link to its service and its node.

## 5. Six synced views of the same landscape

**Table 15-4 — Estate views**

| View | Key | Best for | Shows | Built on | Mockup |
|---|---|---|---|---|---|
| **Map** | `Alt+1` | "Where in the world?", NOC wall | 3D world placed by geography: islands, plateaus, DCs; 2D flat map under `T` | [05](05-visualisation-catalogue.md) §3, §7 | [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg), [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg); 2D [01-landscape-map](../mockups/01-landscape-map.svg) |
| **Topology** | `Alt+2` | Dependencies, causal paths | App floor: 3D layered graph (depth by tier) for large graphs; flat 2D layered under `T` | [04](04-surfaces.md) §4.1, [05](05-visualisation-catalogue.md) VIZ-073 | [22-topology-3d](../mockups/22-topology-3d.svg); 2D [22-topology-3d](../mockups/22-topology-3d.svg) |
| **City** | `Alt+3` | "Find the tall red tower"; size vs load at a glance | Containment as a 3D city of districts and buildings, laid out by size (no geography); treemap under `T` | [05](05-visualisation-catalogue.md) VIZ-074 | [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg) |
| **Infra** | `Alt+4` | Fleet state, capacity, cluster detail | Infra floor: 3D infra city, building cut-away, rack variant; hex grid / packing / elevation under `T` | §4.2–4.4 | [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg); 2D [03-infra-cluster](../mockups/03-infra-cluster.svg) |
| **Segments** | `Alt+5` | Comparing slices (region × tier, team × env) | 2D matrix over any two dimensions (3D columns variant opt-in, [05](05-visualisation-catalogue.md) VIZ-080) | [07](07-alerting.md) §3.2 | [04-segments-matrix](../mockups/04-segments-matrix.svg) |
| **Explorer** | `Alt+6` | Precise search, inventory, keyboard work, accessibility | 2D tree + table | §5.1 | — |

#### EST-023 — Six views with fixed keys
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

The Atlas MUST offer the six views of Table 15-4 on `Alt+1`…`Alt+6`. The Alerts room MUST use the same
keys for the alert-focused variant of each view, plus `Alt+7` for Timeline ([07](07-alerting.md) §3).
A key MUST mean the same view everywhere.

*Acceptance:* Given the Atlas, when the user presses `Alt+1`…`Alt+6`, then each view opens in order;
and in the Alerts room the same keys open the alert variants and `Alt+7` opens Timeline.

#### EST-024 — One Context across views
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Filters, time window, A/B comparison and layer MUST be shared by all views; switching view MUST NOT
reset them.

*Acceptance:* Given filter `team=payments`, window 12:00–13:00 and the Capacity layer in Infra, when
the user switches to Map, then the same filter, window and layer apply.

#### EST-025 — One focus across views
**MUST** · M-UI3 · NOC, SRE, Platform

The focused entity MUST be kept across views. Switching to Map MUST fly to the focused entity's region
with its marker highlighted; switching to Explorer MUST expand the tree to it.

*Acceptance:* Given node ip-10-4-7-21 focused in Infra, when the user presses `Alt+1`, then Map flies
to eu-west-1 with the node's marker highlighted; and `Alt+6` expands the Explorer tree to that node
with its row selected.

#### EST-026 — One selection across views
**MUST** · M-UI3 · NOC, SRE, Platform

A selection MUST be shared by all views: a lasso in the Infra grid MUST highlight the same entities in
Topology (via runs-on), in Segments (the cells containing them) and in Explorer (selected rows).

*Acceptance:* Given 12 nodes lassoed in Infra, when the user switches to Topology, then the services
running on them are highlighted; in Segments the containing cells are highlighted; in Explorer the 12
rows are selected.

#### EST-027 — Animated morph between views
**MUST** · M-UI3 · NOC, SRE, Platform

Switching view MUST tween the positions of every entity present in both views
([T02](../technical/T02-vis-engine.md) §2), within the camera-transition budget of
[09](09-performance-contract.md) (≤ 250 ms).

*Acceptance:* Given a focused service, when the user switches from Topology to City, then its mark
moves continuously to its building over ≤ 250 ms; and switching from 3D Infra to 2D Segments
flattens the buildings into their containing cells over ≤ 250 ms.

#### EST-028 — Split screen of two views
**MUST** · M-UI3 · NOC, Platform

`\` MUST show any two views side by side with live linking of focus and selection.

*Acceptance:* Given Explorer and Map split, when the user selects a row in Explorer, then Map
highlights and frames that entity.

### 5.1 Explorer (tree + table)

**Regions:** left, a filter field and the containment tree with a state glyph and incident count per
node; right, a table of the selected node's children with a breadcrumb title, group-by and sort
controls, kind-specific columns, an aggregate footer, and actions (Show on Map, Show in Infra,
Compare `B`, Export CSV).

#### EST-029 — Explorer tree
**MUST** · M-UI3 · Platform, SRE, NOC

The Explorer tree MUST be a virtualised DOM tree following the configurable containment schema, with a
state glyph and incident count per node. It MUST be re-rootable by any ownership dimension (e.g.
team → service → workload) and switchable to the application ladder.

*Acceptance:* Given 10k nodes, when the tree is scrolled end to end, then it stays responsive; and
re-rooting by team shows team → service → workload.

#### EST-030 — Explorer table
**MUST** · M-UI3 · Platform, SRE, NOC

The Explorer table MUST be a [05](05-visualisation-catalogue.md) §6 table listing the children of the
selected tree node, with columns that depend on the entity kind, a footer of aggregates (e.g. mean
CPU, p95, NotReady and NoData counts), and the actions Show on Map, Show in Infra, Compare (`B`) and
Export CSV.

*Acceptance:* Given prod-eu-1 › nodes (612) selected, then the table shows 612 rows (virtualised) with
state, name, pool, zone, CPU, memory, pods and version; the footer shows mean CPU, p95, NotReady and
NoData counts; and "Show on Map" flies Map to the selection.

#### EST-031 — One filter language
**MUST** · M-UI3 · Platform, SRE, NOC

The Explorer filter MUST use the same language as Atlas find/hide (e.g. `p99 > 1s and team =
payments`, `type:node pool:gpu cpu>80%`), with autocomplete from the entity catalogue.

*Acceptance:* Given `type:node pool:gpu cpu>80%`, when entered in Explorer and in the Atlas filter bar,
then both return the same entity set; typing `pool:` offers pool names.

#### EST-032 — Explorer is the accessible equivalent
**MUST** · M-UI3 · Platform, SRE, NOC, Admin

Every action available in a spatial view MUST have a keyboard path in Explorer.

*Acceptance:* Given the list of spatial-view actions (select, compare, dive, cross floors, change
layer, act), when each is performed in Explorer with the keyboard only, then each succeeds with the
same result.

## 6. Navigation mechanics

#### EST-033 — Screen-size semantic-zoom thresholds
**MUST** · M-UI3 · SRE, Platform, NOC

A spatial container MUST expand into its children when its on-screen footprint (in 3D, the projected
screen area of its top face, as an equivalent square side) exceeds an expansion
threshold (default 120 px) and collapse below a collapse threshold (default 60 px); the gap is
hysteresis that prevents flicker. Both thresholds MUST be a per-user setting. Expansion MUST crossfade
children in over 150 ms, with their data pre-fetched on approach ([03](03-interaction-model.md) §5).

*Acceptance:* Given default settings, when a cluster grows past 120 px, then its children crossfade in
over 150 ms ± one frame with no loading state; when it shrinks to 90 px, it stays expanded; at 59 px it
collapses; and setting the threshold to 200 px changes the expansion point.

#### EST-034 — Collapsed containers summarise children
**MUST** · M-UI3 · NOC, Platform, SRE

A collapsed container MUST show its children's worst state, incident count, counts by kind, and a
mini-histogram of the active layer's metric across them.

*Acceptance:* Given a collapsed cluster of 312 nodes with 3 hot, then it shows the worst state, its
counts and a histogram whose right tail holds 3 nodes ("3 hot of 312").

#### EST-035 — Ways to move
**MUST** · M-UI3 · SRE, Platform, NOC, Engineer

The user MUST be able to zoom by scroll or pinch anchored on the cursor, dive with double-click, rise
exactly one level with `Esc`, and return to the Landscape with `Home`.

*Acceptance:* Given a node at L3, when the user presses `Esc` once, then the camera returns to the
cluster at L2 at its previous framing; and `Home` frames L0.

#### EST-036 — Ways to jump
**MUST** · M-UI3 · SRE, Platform, NOC, Engineer

The user MUST be able to jump by ⌘K ("go to node ip-10-4-7-21", "prod-eu-1 gpu pool";
[15-command-palette](../mockups/15-command-palette.svg)); by `/` find, which highlights matches and
flies to each in turn with `n` / `N`; by breadcrumb siblings ([02](02-information-architecture.md)
§2.1); by `Tab` cycling the worst-N in view by care score; and by waypoints (saved camera + Context).

*Acceptance:* Given 5 matches for `/ pool:gpu`, when the user presses `n` five times, then the camera
visits each match once in order and `N` reverses; and `Tab` visits entities in descending care score.

#### EST-037 — Minimap
**MUST** · M-UI3 · SRE, Platform, NOC

Every estate view MUST show a minimap of the whole Landscape with a viewport rectangle (in 3D, the
camera's view footprint on the ground plane, with a heading tick); clicking or dragging in it MUST
move the camera.

*Acceptance:* Given a node at L3, when the user clicks another region on the minimap, then the camera
flies there and the footprint follows; after `Q` rotates the camera, the heading tick rotates too.

#### EST-038 — Depth gauge breadcrumb
**MUST** · M-UI3 · SRE, Platform, Engineer

The breadcrumb MUST show the current position on the relevant ladder or ladders, e.g.
`prod › eu-west-1 › prod-eu-1 › pool general › ip-10-4-7-21` on the infra floor and
`prod › payments team › payments › v2.31` on the app floor.

*Acceptance:* Given the user presses `V` on payments v2.31, then the breadcrumb switches from the app
path to the infra path of the framed nodes.

#### EST-039 — Deep links
**MUST** · M-UI3 · SRE, Platform, NOC, Engineer

Every level, view, focus and layer MUST be URL-addressable, e.g.
`/space/landscape?e=node:ip-10-4-7-21&view=infra&layer=capacity`.

*Acceptance:* Given that URL opened in a new session, then the Infra view opens focused on the node
with the Capacity layer.

## 7. Layers: the landscape beyond incidents

Layers are presets of colour, size and badge bindings, shared across all six views. The Health layer
is for incidents; the others make the landscape a daily tool.

**Table 15-5 — Layers**

| Layer | Colour | Size | Badges | Primary users | Milestone |
|---|---|---|---|---|---|
| **Health** (default) | Five-state health ([01a](01a-audiences-and-perspectives.md) §2.2) | Traffic / capacity | ⚠ incidents, salience ring | Everyone | M-UI3 |
| **Capacity** | Utilisation vs request (diverging: idle ← fit → over) | Allocatable | Pending pods, throttling, OOM | Platform | M-UI3 |
| **Cost** | $/h (sequential) or waste $ (request − usage) | Spend | Idle ≥ 7 d, unattached | Platform (incl. FinOps) | M-UI5 |
| **Change** | Time since last change (recent = bright) | — | ◆ deploys, ⚙ config, ⬆ k8s/OS upgrades in progress | SRE, Release | M-UI3 |
| **Versions** | Categorical by chosen attribute (app version, k8s, kernel, runtime, OS image) | — | EOL / CVE-flagged versions (if a vulnerability feed is connected) | Platform, Security | M-UI5 |
| **Coverage** | Signals present: metrics / logs / traces / profiles (4-part glyph) | — | "blind" marker, inventory-only entities | Platform, SRE leads | M-UI3 |
| **Traffic** | Request rate | Request rate | Hot edges | SRE | M-UI3 |

#### EST-040 — Layers shared across views
**MUST** · M-UI3 · Platform, SRE, NOC

Each layer in Table 15-5 MUST be available from its milestone and MUST apply the listed colour, size
and badge bindings in all six views.

*Acceptance:* Given the Capacity layer, when the user cycles through `Alt+1`…`Alt+6`, then every view
colours entities by utilisation vs request on the diverging scale and shows pending-pod, throttling
and OOM badges.

#### EST-041 — Coverage layer shows where you cannot see
**MUST** · M-UI3 · Platform, SRE

The Coverage layer MUST show for each entity which of metrics, logs, traces and profiles are present
as a 4-part glyph, MUST mark entities missing signals as "blind", and MUST mark inventory-only
entities. It MUST use the same coverage model as the per-viewport coverage meter
([05](05-visualisation-catalogue.md) VIZ-027).

*Acceptance:* Given a service with metrics and logs but no traces or profiles, when the Coverage layer
is on, then its glyph shows two of four parts filled and it carries the blind marker.

> **Rationale:** no competitor shows **where you can't see** as a first-class map.

#### EST-042 — Cost layer with a visible formula
**MUST** · M-UI5 · Platform, Business

The Cost layer MUST take prices from a cloud billing export or from a per-instance-type price table
in PostgreSQL, and MUST show the formula behind every cost figure, as for business impact
([12](12-roadmap.md) Q9).

*Acceptance:* Given a price table entry for `m6i.4xlarge`, when the user hovers a node's cost, then the
tooltip shows price × hours and, for waste, (request − usage) × unit price.

## 8. Data and fetch plan per level

**Table 15-6 — Fetch plan**

| Level | Fetched | Source | Size budget | When |
|---|---|---|---|---|
| L0 Landscape | Entity inventory (top levels) + health/capacity/cost rollups per region/cluster | [R3](../technical/pulsusdb-requirements.md) inventory, [R4](../technical/pulsusdb-requirements.md) pyramids (fallback: label values + recording rules, and Dash fallback pyramids in PostgreSQL per [ADR-0012](../adr/0012-derived-state-in-postgres.md)) | ≤ 200 KB | On open; cached in IndexedDB, then refreshed |
| L1 Region | Cluster/account/rack list + rollups; cross-zone/region edges | Same + service graph aggregated by region | ≤ 500 KB | Pre-fetch on approach |
| L2 Cluster | Every node (and pods when expanded): state + one value per active layer | Inventory + kube-state/kubelet/host metrics via PromQL rollups | 100k cells × ~16 B ≈ 1.6 MB | On approach; a layer switch fetches only the new value column |
| L3 Node | Pods on the node, requests/limits/usage, node conditions, events | PromQL instant + range; k8s events from logs | small | On dwell (> 300 ms) |
| L4–L5 | Lens queries | All signals | Per Lens template | On dive |
| Runs-on threads | service ⇄ pod ⇄ node mapping for the selection | Inventory combinations (R3) | small | On selection |

#### EST-043 — Fetch plan budgets and timing
**MUST** · M-UI3 · Platform, SRE, NOC

Each level MUST fetch only what Table 15-6 lists, within its size budget, at the listed moment.

*Acceptance:* Given the Large estate of Table 15-7, when the user opens the Landscape cold, then the
payload is ≤ 200 KB; when the user switches layer at L2, then only one value column is fetched; and
dwelling < 300 ms on a node issues no L3 query.

#### EST-044 — Cached Landscape
**MUST** · M-UI3 · NOC, SRE, Platform

The L0 payload MUST be cached in IndexedDB and shown, marked stale, on the next open while it is
refreshed ([09](09-performance-contract.md) §4).

*Acceptance:* Given a previous session, when the Atlas is opened with the BFF unreachable, then the
cached Landscape is drawn with stale hatching.

#### EST-045 — Replay without queries
**MUST** · M-UI3 · SRE, NOC, IC

Health of every entity MUST come from summary pyramids held in the browser, so that scrubbing the Time
Ribbon replays the landscape at 60 fps from the local engine without new queries.

*Acceptance:* Given the Landscape with a 6 h window loaded, when the user scrubs end to end, then no
network request is issued during the scrub and frame rate holds 60 fps median on reference hardware (a).

#### EST-046 — Entity graph cache and ephemeral history
**MUST** · M-UI3 · Platform, SRE

The BFF's entity graph cache MUST refresh from inventory every 60 s. Ephemeral entities (e.g. pods)
MUST be tracked with first/last seen so that history replays show entities that no longer exist.
First/last-seen records MUST be kept for 30 days in PostgreSQL (Dash-derived state,
[ADR-0012](../adr/0012-derived-state-in-postgres.md)); older history MUST be reconstructed from
PulsusDB queries.

*Acceptance:* Given a pod that existed from 12:00 to 12:20 yesterday, when the user replays 12:10
yesterday, then the pod is drawn in its node; and a new pod appears in the landscape within 60 s of
first being reported.

## 9. Scale targets

**Table 15-7 — Estate scale targets**

| Estate | Entities | Drawn at once (after LOD) | Target |
|---|---|---|---|
| Medium | 2 000 services, 20k pods | ≤ 20k marks | 60 fps on iGPU laptop |
| Large | 10k services, 200k pods, 10k nodes | ≤ 100k marks | 60 fps on discrete GPU, ≥ 30 fps on iGPU |
| Very large | 1M containers across 100 clusters | ≤ 100k marks (aggregate cells above L2) | Same as Large; L0–L1 never draw individual pods |

These are consistent with [09](09-performance-contract.md) and the Atlas target of 10k nodes / 50k
edges. The edge target relies on assumption A1 (PulsusDB `service_graph` cap ≥ 50 000).

#### EST-047 — Estate scale targets
**MUST** · M-UI3 · NOC, Platform, SRE

The estate views MUST meet the targets of Table 15-7, drawing no more than the listed number of marks
after LOD.

*Acceptance:* Given the Large fixture, when the user pans and zooms each of the six views, then no more
than 100k marks are drawn, median frame rate is 60 fps on reference hardware (c) and ≥ 30 fps on (b).

#### EST-048 — L0–L1 never draw individual pods
**MUST** · M-UI3 · NOC, Platform

At L0 and L1, pods and containers MUST be drawn only as aggregates.

*Acceptance:* Given the Very large fixture, when L0 and L1 render, then the scene contains no pod or
container marks.

#### EST-049 — Truncation is shown, never silent
**MUST** · M-UI3 · NOC, Platform, SRE

When inventory, rollup or service-graph data for a view is truncated or incomplete, the view's
coverage meter MUST show what was dropped (e.g. edge count over the PulsusDB cap) and the view MUST
still render what it has.

*Acceptance:* Given a `service_graph` response truncated at 1 000 edges, when Topology renders, then
the coverage meter reads "edges truncated" with the count and the truncated graph is drawn.

## 10. Perspective defaults

**Table 15-8 — Perspective defaults**

| Perspective | Starts at | Default view | Default layer |
|---|---|---|---|
| NOC | L0 Landscape | Map (wall) + Segments (region × tier) | Health |
| SRE | A0 Estate | Topology | Health |
| Platform | L2 of their clusters | Infra | Capacity |
| Engineer | A2 their services | Lens; `V` to see where it runs | Health |
| Platform — FinOps preset | L0 | City | Cost |
| Business — Exec preset | L0 | Map, simplified (regions + Journeys) | Health |
| Business / Support | Journeys ([04](04-surfaces.md) §4.14) | — | — |

#### EST-050 — Perspective sets the starting point
**MUST** · M-UI5 · NOC, SRE, Platform, Engineer, Business, Support

Opening the estate MUST start at the level, view and layer of the user's Perspective in Table 15-8.
The user MUST be able to change all three, and the change MUST NOT alter the Perspective defaults for
others.

*Acceptance:* Given a Platform user owning prod-eu-1, when they open Dash, then it lands on L2 of
prod-eu-1 in Infra with the Capacity layer; given a Support user, it lands on Journeys.

## 11. RBAC on the landscape

Data scopes on metrics depend on open decision O1 ([ADR-0013](../adr/0013-metrics-data-scopes.md)):
where resource attributes are not labels, scope enforcement on metrics follows whatever ADR-0013
decides (the recommendation is to enforce on labels and fail closed per metric family).

#### EST-051 — Out-of-scope entities follow org policy
**MUST** · M-UI6 · Admin, Platform, NOC

Entities outside a user's data scope ([11](11-enterprise.md)) MUST, according to org policy, either be
shown as anonymous counts inside their container (e.g. "+38 entities you can't view") so that totals
and aggregates stay honest, or be removed entirely with totals adjusted. Where scope cannot be
evaluated for an entity's metrics (ADR-0013), the entity MUST be treated as out of scope (fail
closed).

*Acceptance:* Given a user scoped to team payments and policy "anonymous counts", when they view
prod-eu-1, then other teams' pods appear only as "+N entities you can't view" with correct totals;
under policy "remove", they are absent and totals exclude them.

#### EST-052 — Runs-on never leaks hidden co-tenants
**MUST** · M-UI6 · Admin, Platform

Runs-on threads, crossing chips and noisy-neighbour messages MUST NOT reveal the name of an entity
outside the user's scope; a hidden co-tenant MUST be shown as "another workload (restricted)".

*Acceptance:* Given payments' node shared with an out-of-scope `batch-etl` that saturates it, when a
payments-scoped user selects payments, then the chip reads "2 of 6 nodes CPU-saturated by another
workload (restricted)" and no API response to that user contains `batch-etl`.

## 12. Storyboard: Lee's Monday capacity review (non-incident)

1. **Lee opens Pulsus** (Platform Perspective). It lands on L2 for their clusters, in the 3D Infra
   city with the Capacity layer. The cluster header strip shows `prod-eu-1`: 82 % CPU requested, 41 % used.
2. **Group by pool, colour by waste.** The `memory` pool's block is mostly blue (idle) and low-rise. The Cost layer puts it
   at $9.2k/month of unused requests.
3. **Lasso the idle nodes, then `B`.** Compare shows that 90 % of the waste is `search-indexer`
   requesting 16 GiB and using 3.
4. **`V` up to the app floor.** `search-indexer` is highlighted, owned by team search. The Inspector
   shows its memory over 30 days next to its request line (the request is 5× the p99).
5. **Action:** "Propose right-size" drafts a PR to the team's Helm values (an audited action,
   [11](11-enterprise.md)). The AI attaches the evidence chart.
6. **Lee pins a waypoint** "eu idle memory" to the Platform board for next week.

No queries typed, about 2 minutes. The same landscape served Sam's incident in
[13](13-core-flow-storyboard.md).

#### EST-053 — Propose right-size
**SHOULD** · M-UI6 · Platform, Engineer

From a workload whose requests exceed usage, Dash SHOULD offer "Propose right-size", which drafts a
change (e.g. a PR to the owning team's Helm values) with the evidence chart attached, as an audited
action ([11](11-enterprise.md)).

*Acceptance:* Given `search-indexer` requesting 16 GiB with p99 usage 3 GiB, when Lee chooses
"Propose right-size", then a PR draft with a lower request and the 30-day evidence chart is created,
and an audit entry records it.

#### EST-054 — Capacity review without typing a query
**MUST** · M-UI5 · Platform

Steps 1–4 and 6 of the storyboard above MUST be completable without typing a query. Step 5 is
covered by EST-053.

*Acceptance:* Given the storyboard fixture, when a tester performs steps 1–4 and 6 with pointer and
shortcuts only, then every step succeeds without the query editor being opened, in under 2 minutes.

## 12a. 3D-first estate

This section consolidates the 3D-first rules that §2–§6 rely on. The rendering and mark rules are
in [05](05-visualisation-catalogue.md) §3, the 3D visual language in [08](08-visual-language.md)
§10, the camera in [03](03-interaction-model.md) §3, and the frame budgets in
[09](09-performance-contract.md) PRF-043 to PRF-045.

#### EST-055 — 3D-first estate views
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer, Business

The Landscape (L0–L2) in the Map view, the City view and the Infra view MUST default to GPU-rendered
3D perspective scenes with the Orbit camera ([03](03-interaction-model.md) INT-001). The Topology
view MUST default to the 3D layered graph when the graph exceeds the size threshold of
[05](05-visualisation-catalogue.md) VIZ-073, and to the flat 2D layered graph otherwise. Segments and
Explorer MUST be 2D. Every 3D view MUST have its 2D equivalent on `T` (Table 15-2), and `T` MUST
keep focus, selection, layer and Context. A user's `T` choice MUST persist per view for that user;
it MUST NOT change the default for others.

*Acceptance:* Given a fresh user and a multi-region estate, when the user presses `Alt+1`, `Alt+3`
and `Alt+4` in turn, then each opens as a perspective 3D scene in Orbit mode; `Alt+2` on a
2 000-service graph opens the 3D layered graph and on a 40-service graph the 2D layered graph;
`Alt+5` and `Alt+6` open 2D; pressing `T` in Infra shows the hex grid with the same focus and
selection, and after reload Infra opens in 2D for that user only.

#### EST-056 — Containment as a 3D world
**MUST** · M-UI3 · Platform, NOC, SRE

The 3D estate MUST draw containment as in Table 15-9: provider as an island, region or DC as a raised
plateau on the ground plane placed by geography where coordinates are known, cluster as a district,
node as a building (footprint ∝ capacity, height ∝ utilisation or the layer's load metric), pod as a
floor slab or stacked block inside its building shown by cut-away on focus, and container as a cell
within a slab. On-prem estates with rack attributes MUST be able to use the physical-layout variant
(EST-021).

*Acceptance:* Given the EST-001 fixture, when the user flies from L0 to one container, then the
scene shows islands, plateaus, districts, buildings, pod slabs (after the cut-away) and container
cells in that order; and a node with twice the allocatable CPU of its neighbour has twice its
footprint area (±5 %).

#### EST-057 — Causal paths cross floors
**MUST** · M-UI3 · SRE, Engineer, Platform

When an incident's causal path ([06](06-ai-copilot.md)) runs through both applications and
infrastructure, the 3D floors MUST draw it as one continuous path that may cross floors: along
dependency arcs on the app floor and down runs-on threads to the buildings or pod slabs involved. The
2D split view MUST draw the same path across its two panes.

*Acceptance:* Given payments degraded by a saturated co-tenant (EST-014), when the user holds `V`
with the incident focused, then one highlighted path runs gateway → checkout → payments on the app
floor and down a thread to the 2 saturated buildings, and the same path appears in the split view
after `T`.

#### EST-058 — 3D encodings
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

The 3D estate MUST use the encodings of Table 15-10: height = load or utilisation; footprint =
capacity; colour = health using only the state tokens of [08](08-visual-language.md) VL-003, with
healthy entities drawn in near-monochrome neutral grey so that a calm estate reads almost
monochrome; glow ∝ anomaly score (VL-004); the probable origin ⊕ marked by a vertical light beacon;
victims desaturated with a dashed ground ring (VL-005); edges as arcs with traffic particles
([05](05-visualisation-catalogue.md) VIZ-075). Bindings for height, footprint and colour MUST follow
the active layer (Table 15-5).

*Acceptance:* Given a healthy estate, when the infra city renders, then no building face carries a
state hue other than neutral grey; given the storyboard incident, then psp-api's building carries a
beacon, the victims are desaturated with dashed ground rings, and the glow intensity ratio of two
entities with anomaly scores 0.4 and 0.8 is 1 : 2 (±10 %).

#### EST-059 — Billboard labels never overlap
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Labels in 3D estate scenes MUST be screen-aligned billboards joined to their entity by a leader
line, MUST be culled by level of detail and care score ([01a](01a-audiences-and-perspectives.md)
§2.3) so that labels never overlap one another, and MUST always show the focused, selected and
origin entities ([05](05-visualisation-catalogue.md) VIZ-076).

*Acceptance:* Given the Large fixture of Table 15-7, when the user orbits the infra city for 30 s,
then no frame contains two overlapping labels, and the focused building's label is present in every
frame.

#### EST-060 — Semantic zoom is one continuous flight
**MUST** · M-UI3 · SRE, Platform, NOC, Engineer

Semantic zoom through the infrastructure ladder MUST be one continuous camera flight: globe → region
plateau → cluster district → node building → pod slab → container cell, with no cut between levels
except under the reduced-motion fallback (EST-063). Each programmatic leg (dive, rise, `Home`, ⌘K
jump) MUST complete within the ≤ 250 ms camera-transition budget ([09](09-performance-contract.md)
PRF-007), and the next level's data MUST be pre-fetched on approach (PRF-029) so it is present on
arrival. Double-clicking an entity MUST dive into it (EST-035). Mockup:
[23-semantic-zoom-flight](../mockups/23-semantic-zoom-flight.svg).

*Acceptance:* Given the Large fixture, when the user double-clicks a region, a cluster, a node and
a pod in turn, then each leg completes in ≤ 250 ms, every frame of the capture shows the scene (no
blank or loading frame), no leg waits on a request, and the altitude ladder ([03](03-interaction-model.md)
INT-044) advances L1 → L2 → L3 → L4.

#### EST-061 — Camera aids in every 3D estate view
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Every 3D estate view MUST show the orbit gizmo / compass ([03](03-interaction-model.md) INT-043),
the altitude ladder L0–L5 (INT-044), the minimap (EST-037) and the depth-gauge breadcrumb (EST-038).

*Acceptance:* Given each of Map, City, Infra and 3D Topology, when it renders, then the gizmo,
altitude ladder, minimap and breadcrumb are all visible and each responds to a click.

#### EST-062 — 3D estate at scale
**MUST** · M-UI3 · NOC, Platform, SRE

The 3D City and Infra scenes MUST meet [09](09-performance-contract.md) PRF-043 (10 000 buildings and
50 000 pod blocks) on WebGPU and PRF-044 on the WebGL2 tier.

*Acceptance:* As PRF-043 and PRF-044.

#### EST-063 — 2D fallback
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer, Business, Support, Admin

Every estate view MUST remain fully usable in its 2D equivalent. The estate MUST open in the 2D
equivalent instead of 3D when `prefers-reduced-motion` is set, when the user sets the "2D estate"
preference, or when the device cannot meet PRF-044 on its GPU tier. Explorer and Segments are 2D and
MUST remain the keyboard- and screen-reader-accessible paths (EST-032).

*Acceptance:* Given `prefers-reduced-motion: reduce`, when the Atlas opens, then Map, City and Infra
open in their 2D equivalents and `T` still shows 3D on request with instant cuts; given the "2D
estate" preference, the same holds without reduced motion; and every action in EST-032 succeeds in
the 2D equivalents.

#### EST-064 — Space is 3D, signals are 2D, and both are linked
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer, Business

Spatial views (the estate, global views, infrastructure, service maps and topology) MUST default to
3D (EST-055). Signal views (time series, distributions, tables, logs, trace waterfalls and flame
graphs) MUST default to 2D, because reading precise values matters there; 3D signal views are
opt-in or auto-chosen only where a third dimension carries meaning
([05](05-visualisation-catalogue.md) §3.1); the canonical example is the fleet line stack
([05](05-visualisation-catalogue.md) VIZ-085), which lays the 2D series of every member of a group
side by side along depth. The two MUST be linked:
- a 2D chart MUST be dockable beside or inside every 3D scene;
- selecting or hovering an entity in 3D MUST drive the docked 2D chart to that entity's slice;
- brushing in a 2D chart MUST highlight the matching entities in 3D;
- both MUST share the one global time cursor ([03](03-interaction-model.md) INT-026).

`T` MUST still flatten any 3D scene to its 2D equivalent.

*Acceptance:* Given the infra city with a CPU-utilisation chart docked, when the user hovers a
building, then the chart shows that node's series within one frame; when the user brushes the
chart's top decile of CPU at 12:20, then exactly the buildings above it at 12:20 are highlighted;
moving the time cursor in the chart changes building heights to that instant; `T` flattens the
scene while the docked chart stays; and "Show all nodes as lines" on a district opens the fleet line
stack of its nodes, sharing the same time cursor.

### 12a.1 The Earth globe

> **Note:** The globe is the top altitude of the Map view and the first leg of the semantic-zoom flight. It answers "where in the world is it hurting?" for NOC, Platform and Business users. Mockup: [01-landscape-map.svg](../mockups/01-landscape-map.svg) (flat equivalent: [01-landscape-map-2d.svg](../mockups/01-landscape-map-2d.svg)).

#### EST-065 — The Earth globe is the top of the Map view
**MUST** · M-UI3 · Platform, NOC, SRE, Business

The Map view (`Alt+1`) MUST open at its highest altitude as a 3D Earth globe, rendered on the GPU with the 3D visual language of [08](08-visual-language.md) §10 (calm, near-monochrome, colour only for health). As the camera descends, the globe MUST flatten continuously into the ground plane of the 3D estate world (region plateaus, then cluster districts), with no cut or reload.

*Acceptance:* Given the Map view at default altitude, then a globe is shown with all placed sites. When the user zooms toward eu-west-1, the surface curvature flattens into the eu-west-1 plateau within one continuous flight (≤ 250 ms per leg, EST-060). No frame shows a blank or loading scene.

#### EST-066 — What is placed on the globe
**MUST** · M-UI3 · Platform, NOC, SRE

The globe MUST place, at their geographic coordinates: cloud and on-prem regions, data centres, edge locations and external dependencies (e.g. the payment provider). Each site MUST be an extruded marker or district with height = load, footprint = capacity and colour = worst health ([Table 15-10](#34-the-estate-as-a-3d-world)). The origin MUST carry the ⊕ beacon. Entities with no known location MUST be listed in an "Unplaced" tray beside the globe, never silently dropped.

*Acceptance:* Given 6 regions, 2 data centres and 1 external provider with locations, and 3 clusters without location, then 9 sites appear at the right coordinates (±50 km) and the tray reads "Unplaced: 3"; eu-west-1 shows Failing with the ⊕ beacon during INC-2041.

#### EST-067 — Great-circle arcs
**MUST** · M-UI3 · Platform, SRE, NOC

Cross-site traffic, replication and calls to external dependencies MUST be drawn as great-circle arcs lifted above the surface (arc height proportional to distance). Width = volume, particles = flow direction and rate, colour = health of those calls (red only where calls fail). Hovering an arc MUST show volume, error rate and latency between the two ends, and a docked 2D chart of the selected arc over time.

*Acceptance:* Given checkout in eu-west-1 calling the provider with 38% failures, then that arc is red with particles flowing out; hovering it shows rate, error % and p95, and selecting it docks a 2D error-rate chart for the arc.

#### EST-068 — User geography layer
**SHOULD** · M-UI5 · Business, Support, SRE

A **Users** layer SHOULD show where requests and users originate, from client geo attributes in telemetry (e.g. country or city resource/span attributes), as surface heat or extruded country cells. Colour = experience (error rate or latency vs baseline), so "which customers are hurting, where" is visible on the globe.

*Acceptance:* Given client spans with country attributes, when the Users layer is on during INC-2041, then countries with elevated checkout failures are tinted Degraded/Failing and selecting one shows its affected-request count and a 2D trend.

#### EST-069 — Built-in offline basemap
**MUST** · M-UI3 · Admin, Platform

The globe MUST render from a basemap shipped with Dash (low-resolution vector landmasses and borders, drawn as dot-matrix or hairlines). It MUST work air-gapped and MUST NOT call external tile or map services by default. An operator MAY configure their own tile source.

*Acceptance:* Given an air-gapped deployment with no outbound network, then the globe renders landmasses and borders, and the browser makes no request outside the Dash origin.

#### EST-070 — Globe camera
**MUST** · M-UI3 · All

On the globe, drag MUST rotate the Earth (north-up locked by default, `Q`/`E` to unlock and rotate), wheel MUST change altitude, double-click on a site MUST fly to it, and `Home` MUST return to the whole-globe view. On walls and TV mode the globe SHOULD auto-rotate slowly when idle and MUST stop auto-rotating on any input or when an incident needs attention, turning to face it.

*Acceptance:* Given the globe idle on a wall, then it rotates slowly; when INC-2041 starts, it turns to bring eu-west-1 to the front within 2 s and stops rotating; any key or pointer input stops rotation immediately.

#### EST-071 — Time of day
**MAY** · M-UI5 · NOC, Platform

A day/night layer MAY shade the night side of the globe and label each site's local time, to support follow-the-sun operations and to explain diurnal load. It MUST be off by default and MUST NOT use colour reserved for health.

*Acceptance:* Given the layer is on at 12:31 UTC, then the night side is dimmed and eu-west-1 is labelled with its local time.

#### EST-072 — Flat map equivalent
**MUST** · M-UI3 · All

`T` MUST flatten the globe to a 2D equal-area world map with the same sites, arcs, layers and selection, and the flat map MUST be used under `prefers-reduced-motion` and on the reduced renderer tier.

*Acceptance:* Given the globe with eu-west-1 selected, when the user presses `T`, then a flat world map shows the same sites, arcs and selection within 250 ms.

#### EST-073 — Globe at scale
**MUST** · M-UI3 · All

The globe MUST render 500 sites and 5 000 arcs with particles at ≥ 60 fps on reference hardware (a) and ≥ 45 fps p99 on (b) ([09](09-performance-contract.md)).

*Acceptance:* Gate `bench:globe-sites-arcs`: the seeded scene of 500 sites and 5 000 arcs, orbiting for 10 s, meets 60 fps median on (a) and 45 fps p99 on (b).

## 13. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| EST-001 | Zero-config relationship derivation | MUST | M-UI3 |
| EST-002 | Runs-on from co-occurrence | MUST | M-UI3 |
| EST-003 | Entity kinds on the landscape | MUST | M-UI3 |
| EST-004 | Inventory connectors and inventory-only entities | SHOULD | M-UI5 |
| EST-005 | Home frames the whole estate | MUST | M-UI3 |
| EST-006 | Grouped by provider, then geography | MUST | M-UI3 |
| EST-007 | Region and DC tiles | MUST | M-UI3 |
| EST-008 | Outside-the-estate ring | MUST | M-UI3 |
| EST-009 | Estate strip numbers are filters | MUST | M-UI3 |
| EST-010 | Both ladders with their default vis | MUST | M-UI3 |
| EST-011 | `V` flips between floors | MUST | M-UI3 |
| EST-012 | Hold `V` shows both floors | MUST | M-UI3 |
| EST-013 | Crossing chips | MUST | M-UI3 |
| EST-014 | Noisy-neighbour detection | MUST | M-UI3 |
| EST-015 | Zones as columns, clusters as bands | MUST | M-UI3 |
| EST-016 | Infra grid grouping and cells | MUST | M-UI3 |
| EST-017 | Cluster header strip | MUST | M-UI3 |
| EST-018 | Lasso and Compare across cells | MUST | M-UI3 |
| EST-019 | Packing bar | MUST | M-UI3 |
| EST-020 | Node conditions and actions | MUST | M-UI3 |
| EST-021 | Rack elevation | MAY | M-UI5 |
| EST-022 | Workload Lenses with crossing chips | MUST | M-UI3 |
| EST-023 | Six views with fixed keys | MUST | M-UI3 |
| EST-024 | One Context across views | MUST | M-UI3 |
| EST-025 | One focus across views | MUST | M-UI3 |
| EST-026 | One selection across views | MUST | M-UI3 |
| EST-027 | Animated morph between views | MUST | M-UI3 |
| EST-028 | Split screen of two views | MUST | M-UI3 |
| EST-029 | Explorer tree | MUST | M-UI3 |
| EST-030 | Explorer table | MUST | M-UI3 |
| EST-031 | One filter language | MUST | M-UI3 |
| EST-032 | Explorer is the accessible equivalent | MUST | M-UI3 |
| EST-033 | Screen-size semantic-zoom thresholds | MUST | M-UI3 |
| EST-034 | Collapsed containers summarise children | MUST | M-UI3 |
| EST-035 | Ways to move | MUST | M-UI3 |
| EST-036 | Ways to jump | MUST | M-UI3 |
| EST-037 | Minimap | MUST | M-UI3 |
| EST-038 | Depth gauge breadcrumb | MUST | M-UI3 |
| EST-039 | Deep links | MUST | M-UI3 |
| EST-040 | Layers shared across views | MUST | M-UI3 |
| EST-041 | Coverage layer shows where you cannot see | MUST | M-UI3 |
| EST-042 | Cost layer with a visible formula | MUST | M-UI5 |
| EST-043 | Fetch plan budgets and timing | MUST | M-UI3 |
| EST-044 | Cached Landscape | MUST | M-UI3 |
| EST-045 | Replay without queries | MUST | M-UI3 |
| EST-046 | Entity graph cache and ephemeral history | MUST | M-UI3 |
| EST-047 | Estate scale targets | MUST | M-UI3 |
| EST-048 | L0–L1 never draw individual pods | MUST | M-UI3 |
| EST-049 | Truncation is shown, never silent | MUST | M-UI3 |
| EST-050 | Perspective sets the starting point | MUST | M-UI5 |
| EST-051 | Out-of-scope entities follow org policy | MUST | M-UI6 |
| EST-052 | Runs-on never leaks hidden co-tenants | MUST | M-UI6 |
| EST-053 | Propose right-size | SHOULD | M-UI6 |
| EST-054 | Capacity review without typing a query | MUST | M-UI5 |
| EST-055 | 3D-first estate views | MUST | M-UI3 |
| EST-056 | Containment as a 3D world | MUST | M-UI3 |
| EST-057 | Causal paths cross floors | MUST | M-UI3 |
| EST-058 | 3D encodings | MUST | M-UI3 |
| EST-059 | Billboard labels never overlap | MUST | M-UI3 |
| EST-060 | Semantic zoom is one continuous flight | MUST | M-UI3 |
| EST-061 | Camera aids in every 3D estate view | MUST | M-UI3 |
| EST-062 | 3D estate at scale | MUST | M-UI3 |
| EST-063 | 2D fallback | MUST | M-UI3 |
| EST-064 | Space is 3D, signals are 2D, and both are linked | MUST | M-UI3 |
| EST-065 | The Earth globe is the top of the Map view | MUST | M-UI3 |
| EST-066 | What is placed on the globe | MUST | M-UI3 |
| EST-067 | Great-circle arcs | MUST | M-UI3 |
| EST-068 | User geography layer | SHOULD | M-UI5 |
| EST-069 | Built-in offline basemap | MUST | M-UI3 |
| EST-070 | Globe camera | MUST | M-UI3 |
| EST-071 | Time of day | MAY | M-UI5 |
| EST-072 | Flat map equivalent | MUST | M-UI3 |
| EST-073 | Globe at scale | MUST | M-UI3 |

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. ASCII diagrams replaced by region tables and SVG mockups; open questions E1–E5 resolved (below) |
| 1.0-rc2 | 2026-11-18 | 3D-first estate per owner brief: R4 reversed; EST-005, EST-006, EST-007, EST-008, EST-010, EST-011, EST-012, EST-015, EST-016, EST-017, EST-018, EST-019, EST-021, EST-027, EST-033, EST-037 edited in place; §3.4, Tables 15-9 and 15-10 and §12a (EST-055 to EST-064) added; Tables 15-2 and 15-4 updated; mockups 19–24 referenced (R13–R16) |
| 1.0-rc3 | 2026-11-18 | Earth globe specified (owner question): §12a.1, EST-065 to EST-073 |

## Resolved during formalisation

| # | Issue in draft | Resolution |
|---|---|---|
| R1 | E1: expansion threshold and tunability open | Defaults 120 px expand / 60 px collapse, per-user setting (EST-033) |
| R2 | E2: inventory connectors v1 or later | SHOULD at M-UI5; telemetry derivation is the default (EST-004) |
| R3 | E3: rack elevation in v1 | MAY at M-UI5, to be raised if an on-prem design partner needs it (EST-021) |
| R4 | E4: two-floor 3D vs split 2D as the default | *Revised in 1.0-rc2:* the **3D floors** are the default for hold-`V` (app floor above the infra city, runs-on threads dropping to buildings and pods); split 2D is the `T` and EST-063 fallback (EST-012). The A/B test of the floors stays a research item |
| R5 | E5: ephemeral entity retention | 30 days of first/last seen in PostgreSQL per D2, older from PulsusDB (EST-046) |
| R6 | The landscape wireframe listed an "Inventory" layer that is not in §7 | Inventory-only entities are part of the Coverage layer; no separate layer |
| R7 | Perspectives "FinOps" and "Exec" are not audiences in 01a | Kept as presets of the Platform and Business Perspectives (Table 15-8) |
| R8 | Roadmap puts only Health/Capacity/Coverage layers in M-UI3 | Health, Capacity, Change, Coverage and Traffic at M-UI3 (Change needs the M-UI3 change feed; Traffic is the Topology default); Cost and Versions at M-UI5 |
| R9 | Fallback for pyramids when PulsusDB R4 is missing was "recording rules" only | Also Dash fallback pyramids in PostgreSQL per D2 / ADR-0012 |
| R10 | Draft did not say what happens to metrics whose scope cannot be evaluated | Fail closed, following O1's recommendation; final behaviour follows ADR-0013 |
| R11 | Draft allowed the scale table and the topology cap (1 000 edges) to conflict | Targets stand per A1; truncation is shown by the coverage meter (EST-049) |
| R12 | Lee's storyboard depends on Cost and Platform Perspective (M-UI5) and on an audited write action | The storyboard acceptance (EST-054, steps 1–4 and 6) is M-UI5; the right-size action (EST-053) is SHOULD at M-UI6 with the audit work |
| R13 | 1.0-rc2: the spec had drifted to 2D defaults (split 2D floors, hex grid for Infra, flat Map), contrary to the owner's brief of 3D GPU-rendered infrastructure with game-like navigation | Landscape L0–L2, City and Infra default to 3D Orbit scenes; Topology 3D above the VIZ-073 threshold; 2D is the `T` equivalent and the EST-063 fallback (EST-055, EST-063) |
| R14 | 1.0-rc2: no spatial metaphor was fixed for containment in 3D | Region plateau, cluster district, node building, pod slab, container cell; racks as a physical-layout variant (Table 15-9, EST-056) |
| R15 | 1.0-rc2: the owner clarified that the product is a combination of 2D and 3D | Space is 3D, signals are 2D, both linked through docked charts, shared selection and one time cursor (EST-064) |
| R16 | 1.0-rc2: vendor and orchestrator names in edited requirements | Replaced by generic terms in the edited rows and requirements (Table 15-2, EST-006, EST-010, EST-016) |
