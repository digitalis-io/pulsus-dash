# 16 — Infrastructure model: clouds, Kubernetes and generic components in 3D

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Requirement area** | `INF` |
| **Source draft** | none (written directly from the owner brief, 2026-11-18) |
| **Depends on** | [02 Information architecture](02-information-architecture.md) · [05 Visualisation catalogue](05-visualisation-catalogue.md) · [08 Visual language](08-visual-language.md) · [09 Performance contract](09-performance-contract.md) · [15 Estate navigation](15-estate-navigation.md) |
| **Technical designs** | [T12 Entity catalogue](../technical/T12-entity-catalogue.md) · [T02 Vis engine](../technical/T02-vis-engine.md) · [T11 Postgres schema](../technical/T11-postgres-schema.md) · [T18 Security](../technical/T18-security.md) |
| **Mockups** | [28-multicloud-estate-3d](../mockups/28-multicloud-estate-3d.svg) · [29-k8s-workloads-3d](../mockups/29-k8s-workloads-3d.svg) · [30-network-layer-3d](../mockups/30-network-layer-3d.svg) · [31-datacentre-hall-3d](../mockups/31-datacentre-hall-3d.svg) |

## 1. Purpose & scope

The owner brief: **every major cloud, every Kubernetes deployment and generic infrastructure
components, visualised in 3D.** [15](15-estate-navigation.md) defines how a user moves through the
estate: the globe, the 3D world of islands, plateaus, districts and buildings, the floors and the six
views. This document defines **what the estate is made of**:

- one **canonical class taxonomy**, so that a managed database in any cloud, a self-hosted database
  on a VM and a database on bare metal are the same kind of thing (§3);
- one **shape grammar** in 3D, a shape family per class family (§4);
- how each **cloud** maps onto the taxonomy (§5);
- the **Kubernetes** object model and its 3D Workload arrangement (§6);
- **networks** as a 3D layer (§7);
- **on-prem and generic** components: hypervisors, network devices, storage, facilities (§8).

It does not change the six views, the floors or the camera of [15](15-estate-navigation.md). The
Workload arrangement is a grouping of the Infra view, and the Network layer is a layer
([15](15-estate-navigation.md) §7). The entity catalogue that implements the taxonomy is
[T12](../technical/T12-entity-catalogue.md).

**Design stance.** Telemetry is the default source of truth ([15](15-estate-navigation.md) EST-001),
and cloud and platform APIs fill in what telemetry cannot see (EST-004). No class is drawn
differently because of who sells it: the provider is an *identity* of the entity, not a style.

## 2. Definitions

| Term | Meaning |
|---|---|
| **Class** | One of the canonical infrastructure classes of Table 16-1, e.g. `compute.vm`, `data.relational`. Every entity has exactly one class |
| **Class family** | The first segment of a class (`compute`, `container`, `serverless`, `data`, `messaging`, `storage`, `network`, `edge`, `security`, `facility`, `external`, `other`). A family has one shape family (§4) |
| **Provider** | Who operates the entity: a public cloud, a private cloud platform, `on-prem`, or `self` for software the customer runs |
| **Native type** | The provider's own resource type string, e.g. a cloud's managed-database type or a Kubernetes `kind`. Kept as an attribute; never used to choose a shape directly |
| **Mapping pack** | A versioned, data-driven table mapping native types and telemetry attributes to classes ([T12](../technical/T12-entity-catalogue.md)) |
| **Managed** | Operated by the provider (the customer does not run the software). Shown by a badge, not by a different shape |
| **Arrangement** | A layout of the Infra view chosen by its grouping (EST-016): by node (default), or by workload (§6) |

## 3. Canonical classes

**Table 16-1 — Canonical infrastructure classes**

| Family | Classes | Typical native types (examples, not exhaustive) |
|---|---|---|
| `compute` | `compute.vm`, `compute.bare_metal`, `compute.hypervisor_host`, `compute.autoscaling_group`, `compute.process` | Cloud VMs and scale sets; physical hosts; hypervisor hosts; OS processes |
| `container` | `container.cluster`, `container.control_plane`, `container.node_pool`, `container.node`, `container.namespace`, `container.workload`, `container.pod`, `container.container`, `container.service_endpoint`, `container.ingress`, `container.volume_claim`, `container.autoscaler`, `container.task_service` | Kubernetes objects (§6); non-Kubernetes container services (task/service schedulers, managed container apps) |
| `serverless` | `serverless.function`, `serverless.app` | Function platforms; managed app platforms |
| `data` | `data.relational`, `data.document`, `data.key_value`, `data.wide_column`, `data.cache`, `data.search`, `data.warehouse`, `data.timeseries`, `data.graph` | Managed and self-hosted databases, caches, search and analytics engines |
| `messaging` | `messaging.queue`, `messaging.stream`, `messaging.topic`, `messaging.event_bus` | Queues, log-structured streams, pub/sub topics, event routers |
| `storage` | `storage.object`, `storage.block`, `storage.file`, `storage.array`, `storage.backup_vault` | Buckets, disks and volumes, file shares, SAN/NAS arrays, backup vaults |
| `network` | `network.virtual_network`, `network.subnet`, `network.security_boundary`, `network.gateway`, `network.load_balancer`, `network.peering`, `network.transit_hub`, `network.vpn`, `network.interconnect`, `network.dns_zone`, `network.switch`, `network.router`, `network.firewall` | Virtual networks, subnets, security groups and firewall rule sets, NAT / internet / private-endpoint gateways, load balancers (cloud and appliance), peering, transit hubs, VPN tunnels, dedicated interconnects, DNS zones, physical network devices |
| `edge` | `edge.cdn`, `edge.api_gateway`, `edge.waf` | CDNs, API gateways, web application firewalls |
| `security` | `security.identity_provider`, `security.key_vault`, `security.certificate` | Identity providers, key and secret stores, certificates (expiry) |
| `facility` | `facility.site`, `facility.hall`, `facility.rack`, `facility.pdu`, `facility.ups`, `facility.cooling` | Data centres, halls, racks, power and cooling |
| `external` | `external.saas`, `external.api` | Third-party dependencies outside the estate (EST-008) |
| `other` | `other.unknown` | Any native type with no mapping (INF-003) |

The containment levels of [15](15-estate-navigation.md) Table 15-2 are unchanged. The account level
is made explicit by INF-007, and Kubernetes objects between node and pod by INF-013.

#### INF-001 — Canonical infrastructure classes
**MUST** · M-UI3 · Platform, SRE, NOC

Every infrastructure entity in the catalogue (every entity other than environments, hierarchy
levels such as region or zone, and services) MUST resolve to exactly one class of Table 16-1, through the shipped
mapping packs or an organisation's overrides. It MUST keep its provider, native type and `managed`
flag as attributes. The Explorer, filters, layers, Segments dimensions and alert scopes MUST accept a
class or a class family wherever they accept an entity kind.

*Acceptance:* Given the mixed-estate fixture (INF-032), when the Explorer is filtered by
`class=data.relational`, then it lists the managed relational databases of every cloud, the
self-hosted relational databases on VMs and the one on bare metal, each with its provider, native type
and managed flag; and `family=messaging` in Segments gives one row per messaging class.

> **Rationale:** a user asks "are any of our databases unhealthy?", not "are any of our
> provider-specific database products unhealthy?". The taxonomy is the vocabulary that makes the
> question answerable across clouds.

#### INF-002 — One shape grammar per class family
**MUST** · M-UI3 · Everyone

In every 3D view, each class family MUST be drawn with the shape family of Table 16-3, and the
encodings of [15](15-estate-navigation.md) Table 15-10 (height, footprint, colour, glow, beacon,
victim ring) MUST apply to every shape. Shapes MUST be distinguishable in silhouette alone, without
colour. The 2D equivalent MUST use the glyphs of Table 16-3.

*Acceptance:* Given the mixed-estate fixture in the Map view with colour disabled (greyscale
golden), then an observer can tell compute, data, messaging, storage, network and serverless entities
apart by silhouette (golden `golden:inf-shape-grammar-greyscale`); and every shape carries the
height, colour and glow bindings of the active layer.

#### INF-003 — Unknown resource types are drawn, never dropped
**MUST** · M-UI3 · Platform, SRE

An entity whose native type has no mapping MUST be classed `other.unknown`, drawn as the generic box
shape with the Unknown hatch, labelled with its native type, and counted in the Coverage layer
([15](15-estate-navigation.md) EST-041) and the estate strip as "unknown types". An admin MUST be able
to map a native type to a class without a release; the mapping MUST apply at the next catalogue
refresh.

*Acceptance:* Given a resource of a native type absent from every mapping pack, when the Landscape
renders, then it appears as a hatched generic box labelled with the type, and the strip reads
"1 unknown type"; when an admin maps the type to `serverless.app`, then within one refresh (≤ 60 s)
it is redrawn as a serverless shape and the counter returns to 0.

#### INF-004 — Provider is identity, not style
**MUST** · M-UI3 · Everyone

The provider MUST be shown by grouping (the provider island, EST-006) and by a small monochrome text
badge. Dash MUST NOT colour, texture or shape an entity by provider, and MUST NOT draw provider logos.
State colours MUST remain reserved for health ([08](08-visual-language.md) VL-003).

*Acceptance:* Given two healthy managed relational databases in two clouds, when they render, then
both have the same shape, the same neutral colour and differ only in their provider text badge and
the island they stand on.

> **Rationale:** colour already means health. Vendor colours would make a healthy estate look like
> a patchwork and compete with the one signal that matters.

## 4. The shape grammar

**Table 16-3 — Shape families**

| Family | 3D shape | Size channels | 2D glyph |
|---|---|---|---|
| `compute` | Building (EST-056); hosts in a rack are U-slot blocks; a scale group is a block of identical buildings | Footprint ∝ capacity, height ∝ load | Square |
| `container` | Cluster: district; node: building; pod: floor slab; workload: tower of replica blocks (§6); service endpoint and ingress: arch gate; control plane: hall building | As above; tower height = replicas | Square (node), small square (pod), stacked bars (workload) |
| `serverless` | Swarm of small floating cubes over the plateau; density ∝ concurrency | Swarm size ∝ invocations, cube count ∝ concurrency | Dotted square |
| `data` | Cylinder (tank); cache: short squat cylinder; warehouse: wide low cylinder | Diameter ∝ allocated capacity, fill level ∝ used | Circle |
| `messaging` | Tube ribbon laid on the plateau between producers and consumers; queue depth as a bulge | Length fixed, thickness ∝ throughput, bulge ∝ lag or depth | Capsule |
| `storage` | Low wide vault slab with a grid top; block volume: disc under its consumer; array: wide cabinet | Area ∝ capacity, fill ∝ used | Rectangle |
| `network` | Virtual network: glass enclosure; subnet: floor tile; security boundary: inner wall; gateway and load balancer: arch gate; peering, VPN and interconnect: bridge; transit hub: hexagonal platform; switch, router and firewall: thin rack slab or gate | Gate width ∝ throughput; bridge thickness ∝ bandwidth | Diamond |
| `edge` | Arch gate on the outside-the-estate ring | Width ∝ requests | Diamond with bar |
| `security` | Small locked block next to its consumers | — | Shield |
| `facility` | Site plateau, hall floor, rack cabinet, power bar on the rack side | Power bar fill ∝ load | Hall: outline; rack: tall rectangle |
| `external` | Ring marker at the ground edge (EST-008) | — | Ring |
| `other` | Plain box with the Unknown hatch | Footprint fixed | Hatched square |

A **managed** entity carries a small "managed" badge on its label. A self-hosted equivalent (e.g. a
relational database on a VM) has the same shape without the badge, with a runs-on thread to its host.

#### INF-031 — Self-hosted and managed share one shape
**MUST** · M-UI3 · Platform, SRE

Self-hosted components identified from telemetry (database, cache, queue or stream, search, web
server or proxy, from `db.system`, `messaging.system`, server and process attributes) MUST be drawn
with the shape of their class, without the managed badge, and linked by runs-on to the VM, pod or host
that runs them. Managed equivalents MUST carry the managed badge.

*Acceptance:* Given a self-hosted relational database on a VM and a managed one in a cloud, when both
render, then both are cylinders; only the managed one has the badge; and selecting the self-hosted
one highlights its runs-on thread to the VM's building.

## 5. Clouds

### 5.1 Cloud hierarchy

Every cloud has the same four levels, with different names:

**Table 16-4 — Cloud hierarchy levels**

| Canonical level | `aws` | `azure` | `gcp` | Others |
|---|---|---|---|---|
| Organisation | Organization / OU | Management group / tenant | Organization / folder | Tenancy / compartment root |
| Account | Account | Subscription (+ resource group as a tag) | Project | Compartment / resource group / project |
| Region | Region | Region | Region | Region |
| Zone | Availability zone | Availability zone | Zone | Availability / fault domain |

The mapping packs (§5.2) name the concrete terms per provider; the UI shows the provider's own term
as secondary text next to the canonical one ("Account · Subscription").

#### INF-007 — Account, subscription and project as fenced lots
**MUST** · M-UI3 · Platform, SRE, NOC

The cloud hierarchy of Table 16-4 MUST be part of containment. On a region plateau, each account
(account, subscription, project or compartment) MUST be drawn as a fenced lot, a hairline dashed
fence enclosing its districts and resources, labelled with the account name and the provider's term.
Grouping, filters and Segments MUST offer organisation and account as dimensions. A resource
spanning accounts (e.g. a shared network) MUST be drawn in its owning account with bridges to the
accounts that use it.

*Acceptance:* Given cloud A with two accounts in eu-west-1, when the region plateau renders, then two
fenced lots are drawn with their names and "Account"; a filter `account=prod-payments` dims every
other lot; and in Segments, account × class shows one row per account.

### 5.2 Provider coverage

**Table 16-2 — Provider coverage**

| Provider (OTel `cloud.provider`) | Telemetry mapping (OTel `cloud.platform` and resource attributes) | Cloud metrics (via collector receivers or exporters into PulsusDB) | Inventory connector (EST-004) | Milestone |
|---|---|---|---|---|
| `aws` | `aws_ec2`, `aws_ecs`, `aws_eks`, `aws_lambda`, `aws_elastic_beanstalk`, `aws_app_runner`, `aws_openshift` | Cloud monitoring metrics joined on `cloud.resource_id` (ARN) | AWS Config | Telemetry M-UI3; connector M-UI5 |
| `azure` | `azure_vm`, `azure_aks`, `azure_container_apps`, `azure_container_instances`, `azure_functions`, `azure_app_service`, `azure_openshift` | Azure Monitor metrics joined on the resource id | Azure Resource Graph | Telemetry M-UI3; connector M-UI5 |
| `gcp` | `gcp_compute_engine`, `gcp_kubernetes_engine`, `gcp_cloud_run`, `gcp_cloud_functions`, `gcp_app_engine`, `gcp_bare_metal_solution`, `gcp_openshift` | Cloud Monitoring metrics joined on the full resource name | Cloud Asset Inventory | Telemetry M-UI3; connector M-UI5 |
| `oracle_cloud` | `oracle_cloud_compute`, `oracle_cloud_oke` | Monitoring metrics joined on the OCID | Resource search | M-UI5 |
| `alibaba_cloud` | `alibaba_cloud_ecs`, `alibaba_cloud_fc`, `alibaba_cloud_openshift` | Cloud monitor metrics joined on the resource id | Resource Center | M-UI5 |
| `ibm_cloud`, `tencent_cloud` | `ibm_cloud_openshift`; `tencent_cloud_cvm`, `tencent_cloud_eks`, `tencent_cloud_scf` | Joined on the resource id | — (telemetry only) | M-UI6 |
| Private cloud: OpenStack | Host and VM attributes; project as account | Compute and network service metrics | Compute / network API | M-UI5 |
| Private cloud: VMware vSphere | `host.*`, `vcenter.*` receiver attributes; datacenter → cluster → host → VM | Hypervisor receiver metrics | vCenter API | M-UI5 |
| `on-prem` (no provider) | Configurable schema (IA-011): site, hall, rack, host | Host, SNMP and device metrics (§8) | CMDB import | M-UI3 (hosts); M-UI5 (devices) |

#### INF-005 — The three largest public clouds out of the box
**MUST** · M-UI3 · Platform, SRE, NOC

Dash MUST ship mapping packs for providers `aws`, `azure` and `gcp` (Table 16-2) that, from
telemetry alone, place every entity carrying OTel cloud attributes under provider → account → region
→ zone and give it a class. Cloud monitoring metrics stored in PulsusDB MUST join to entities by
`cloud.resource_id` (or the provider's equivalent identifier) with no per-resource configuration.
Each class MUST have the headline metrics of Table 16-5 bound for each of the three providers.

*Acceptance:* Given the mixed-estate fixture, when the Landscape opens, then VMs, Kubernetes
clusters, functions, managed databases and queues from all three providers sit on their provider's
island, under the right account, region and zone, with their class shape; and the Health layer on a
managed relational database in each provider shows the Table 16-5 headline metrics from that
provider's cloud metrics.

#### INF-006 — Further public and private clouds
**SHOULD** · M-UI5 · Platform

Dash SHOULD ship mapping packs for `oracle_cloud`, `alibaba_cloud`, OpenStack and VMware vSphere at
M-UI5, and for `ibm_cloud` and `tencent_cloud` at M-UI6. Every provider MUST work through the same
mapping-pack mechanism, so a provider without a shipped pack MUST still be placed on its own island
from `cloud.provider`, with its resources classed by INF-003 until mapped.

*Acceptance:* Given telemetry with `cloud.provider=examplecloud` (no pack), when the Landscape
renders, then an "examplecloud" island appears with its regions, and its resources are generic boxes
counted as unknown types; and given the OpenStack pack, projects are drawn as fenced lots.

#### INF-008 — Managed services are first-class entities
**MUST** · M-UI3 · Platform, SRE, Engineer

Managed services (databases, caches, queues and streams, object storage, functions, container
services, load balancers, API gateways and CDNs) MUST be entities with containment (account, region,
zone where zonal), dependency edges from the services that call them (`db.*`, `messaging.*`,
`server.address`, `peer.service`), health from their cloud metrics, and a Lens with the class
template of Table 16-5. A multi-zone managed service MUST be drawn once, spanning its zones, with
replicas as segments.

*Acceptance:* Given checkout calling a managed relational database with one primary and two
replicas in three zones, when the region plateau renders, then one cylinder spans the three zone
terraces with three segments; checkout's dependency arc ends on it; and its Lens shows connections,
CPU, storage used and replica lag.

**Table 16-5 — Headline metrics per class (Health layer and Lens template)**

| Class | Headline metrics |
|---|---|
| `compute.vm`, `compute.bare_metal`, `container.node` | CPU %, memory %, disk %, network in/out, status checks |
| `compute.hypervisor_host` | CPU %, CPU ready %, memory ballooning, datastore latency |
| `container.workload` | Ready / desired replicas, restarts, rollout progress, CPU and memory vs request |
| `serverless.function` | Invocations, errors %, duration p95, throttles, concurrency, cold starts |
| `data.*` | Connections, CPU %, storage used %, read/write latency, replica lag, cache hit % (`data.cache`) |
| `messaging.*` | Throughput in/out, depth or consumer lag, oldest message age, dead-letter count |
| `storage.object` / `.block` / `.file` / `.array` | Requests, errors, size / used %, IOPS, latency |
| `network.load_balancer`, `network.gateway`, `edge.*` | Requests or flows, 4xx/5xx %, latency, healthy targets, port allocation (NAT) |
| `network.vpn`, `network.interconnect`, `network.peering` | Tunnel or link state, bandwidth %, latency, drops |
| `network.switch` / `.router` / `.firewall` | Interface utilisation, errors, discards, CPU, sessions (firewall) |
| `facility.pdu` / `.ups` / `.cooling` | Load %, battery runtime, inlet temperature |

#### INF-009 — Unmapped cloud metrics are visible
**MUST** · M-UI3 · Platform

A cloud metric series whose resource identifier matches no entity MUST be listed under "unmapped" in
the Coverage layer (IA-012) with its resource identifier and metric name, so that a missing mapping
or connector is visible.

*Acceptance:* Given cloud metrics for a resource absent from telemetry and connectors, when the
Coverage layer opens, then the unmapped list shows that resource identifier and its metric names.

#### INF-010 — A read-only connector for each supported cloud
**SHOULD** · M-UI5 · Platform, Admin

For every provider with a connector in Table 16-2, Dash SHOULD offer an inventory connector under
EST-004 that uses read-only credentials, held per [T18](../technical/T18-security.md), discovers
accounts, networks, subnets, security boundaries, gateways and resources absent from telemetry, and
enriches matched entities (tags, owner, cost centre, instance size). A connector MUST NOT require
write permissions, and Dash MUST refuse to start a connector whose credentials it can verify are
broader than read-only.

*Acceptance:* Given a connector configured with read-only credentials, when it polls, then
inventory-only resources appear outlined and networks become available to the Network layer (INF-024);
and given credentials that can be verified to allow writes, the connector refuses to start and says
why.

#### INF-011 — The same service in several clouds
**SHOULD** · M-UI5 · SRE, Platform

When one service (same `service.name` and `service.namespace`) runs in more than one provider or
region, its Lens SHOULD offer a cross-location compare (Universal Compare) with one column per
location, and the Topology view SHOULD draw it as one node with one segment per location.

*Acceptance:* Given checkout in cloud A eu-west-1 and cloud B westeurope, when the checkout Lens opens,
then a "2 locations" chip opens a compare with one column per location; and in Topology checkout is
one node with two segments.

#### INF-012 — Hybrid links as bridges
**SHOULD** · M-UI5 · Platform, NOC, SRE

VPN tunnels, dedicated interconnects and cross-cloud peering SHOULD be drawn, when known, as bridges
between the islands or plateaus they join, with thickness ∝ bandwidth, traffic particles, and
their health (tunnel state, latency, drops, bandwidth %), from connectors and network-device
telemetry.

*Acceptance:* Given a 2-tunnel VPN between cloud A eu-west-1 and on-prem lon-dc1 with one tunnel down,
when the Map view renders, then a bridge joins the two with the Degraded state and the label
"VPN 1/2 up".

## 6. Kubernetes

### 6.1 Object model

**Table 16-6 — Kubernetes objects**

| Object | Class | Derived from (zero config) | Shown as |
|---|---|---|---|
| Cluster | `container.cluster` | `k8s.cluster.name` / `.uid`; `cloud.platform` for the distribution | District on the plateau |
| Control plane (API server, etcd, scheduler, controller manager) | `container.control_plane` | Control-plane metrics where scraped; API-server health and latency otherwise | Hall building at the district edge |
| Node pool | `container.node_pool` | Node labels for the pool (provider label or configured) | Block of buildings |
| Node | `container.node` | `k8s.node.name` / `.uid` | Building |
| Namespace | `container.namespace` | `k8s.namespace.name` | Sub-district (Workload arrangement) |
| Workload: Deployment, StatefulSet, DaemonSet, Job, CronJob, bare pod | `container.workload` | `k8s.deployment.name`, `k8s.statefulset.name`, `k8s.daemonset.name`, `k8s.job.name`, `k8s.cronjob.name`; owner chain from cluster-state metrics (pod → ReplicaSet → Deployment; Job → CronJob) | Tower (§6.2) |
| ReplicaSet (revision) | attribute of the workload | `k8s.replicaset.name`; revision from cluster-state metrics | Band in the tower |
| Pod | `container.pod` | `k8s.pod.name` / `.uid`; phase, conditions and reasons from cluster-state metrics | Replica block; floor slab in a building |
| Container | `container.container` | `k8s.container.name`, `container.id`; restarts, last terminated reason | Cell |
| Service, EndpointSlice | `container.service_endpoint` | Cluster-state metrics (service info, endpoint addresses); trace `server.address` | Arch gate with arcs to ready pods |
| Ingress, Gateway, HTTPRoute | `container.ingress` | Cluster-state metrics; ingress controller metrics | Arch gate at the district edge |
| PersistentVolumeClaim, PersistentVolume | `container.volume_claim`, `storage.block` | Cluster-state metrics (claim info, volume info, storage class) | Anchor line to a disc |
| HorizontalPodAutoscaler | `container.autoscaler` | Cluster-state metrics (min, max, current, desired, target) | Ghost envelope over the tower |
| Event | change event, not an entity | Kubernetes events ingested as logs | Change Feed entries and badges (INF-022) |
| Custom resources | `other.unknown` until mapped | Cluster-state metrics for custom resources when configured | Generic box (INF-003) |

"Cluster-state metrics" means the series exported by a standard cluster-state exporter or the
collector's Kubernetes cluster receiver; the mapping packs cover both. Non-Kubernetes container
schedulers (task and service schedulers, managed container apps) map to `container.task_service`
and use the same tower shape.

#### INF-013 — Kubernetes object model
**MUST** · M-UI3 · Platform, SRE, Engineer

The catalogue MUST derive the objects of Table 16-6 and their relationships (owner chain, pod → node
runs-on, Service → ready pods, PVC → PV → backing volume, HPA → workload) from OTel Kubernetes
attributes and cluster-state metrics, with no configuration. A pod MUST be reachable from its
workload, its node and its namespace.

*Acceptance:* Given a fixture cluster with one of each workload kind, an HPA, a Service, an Ingress
and a StatefulSet with PVCs, when the Explorer opens on the cluster, then each object appears with its
class; checkout's pods list their ReplicaSet and Deployment; a pod of the CronJob lists its Job and
CronJob; and each PVC links to its PV and backing volume.

#### INF-014 — Any conformant distribution
**MUST** · M-UI3 · Platform

Dash MUST support any conformant Kubernetes distribution, managed or self-managed, through the same
model. The distribution and version MUST be attributes of the cluster (shown on its label and usable
in the Versions layer), and no core feature of this section may depend on one distribution. Where a
managed control plane hides its components, the control-plane hall MUST show what is observable
(API-server latency and errors) and mark the rest "managed by provider".

*Acceptance:* Given fixture clusters of a managed distribution in each of the three clouds, one
enterprise distribution on-prem and one lightweight edge distribution, when the Landscape renders,
then all five are districts with the same Workload arrangement; each label names its distribution
and version; and the managed ones show "managed by provider" for the hidden control-plane
components.

### 6.2 The Workload arrangement

Grouping the Infra view by **workload** (EST-016) switches from buildings (nodes) to the Workload
arrangement: the cluster district divides into namespace sub-districts, and each workload stands as
a **tower of replica blocks**. The node buildings remain, ghosted, on the floor below, with runs-on
threads from each replica block to its node. Mockup:
[29-k8s-workloads-3d](../mockups/29-k8s-workloads-3d.svg).

**Table 16-7 — Workload arrangement encodings**

| Element | 3D form |
|---|---|
| Deployment, ReplicaSet-owned pods | Tower of stacked replica blocks, one block per pod |
| Rollout | Tower banded by revision: new revision on top (accent outline), old below (muted); progress label "6/10" |
| StatefulSet | Blocks numbered by ordinal, with anchor lines from each block to its volume disc below the plateau |
| DaemonSet | Thin ribbon of tiny blocks running along every node row |
| Job, CronJob | Translucent blocks that fade on completion; failed runs stay as Failing blocks until acknowledged or 24 h |
| HPA | Wireframe ghost blocks above the tower up to max replicas; a mark at min |
| Pending pods | Blocks hovering above the namespace in an "Unscheduled" cloud, with the scheduler's reason |
| Service, Ingress, Gateway | Arch gates at the sub-district edge with arcs into ready blocks only |
| Control plane | Hall building at the cluster edge |

#### INF-015 — Workload arrangement in 3D
**MUST** · M-UI3 · Platform, SRE, Engineer

Grouping the Infra view by workload MUST show the Workload arrangement of Table 16-7: namespace
sub-districts, workload towers, ghosted node buildings below with runs-on threads, and the encodings of
[15](15-estate-navigation.md) Table 15-10 on every block. `Enter` on a tower MUST open the workload
Lens (EST-022). The 2D equivalent under `T` MUST be a workload grid: one row per workload, one cell
per replica, banded by revision.

*Acceptance:* Given prod-eu-1 with 120 workloads in 9 namespaces, when the user groups by workload,
then the buildings tween into 9 sub-districts with 120 towers whose block counts equal ready +
not-ready pods; selecting a tower lights its runs-on threads to the nodes below; and `T` shows the
workload grid with the same selection.

#### INF-016 — Rollouts are visible
**MUST** · M-UI3 · SRE, Engineer, Platform

A workload whose pods span more than one revision MUST be drawn banded by revision with its progress
(updated / desired) and its state: progressing, paused, stalled (no progress within the workload's
progress deadline) or rolled back. Each rollout MUST be a change event in the Change Feed (◆) with
its start, end and revisions. Replay MUST animate the bands.

*Acceptance:* Given checkout rolling rev 41 → 42 at 6/10, when the Infra view shows the Workload
arrangement, then the checkout tower has 6 accent-outlined rev-42 blocks above 4 muted rev-41 blocks
and reads "rollout 6/10"; the Change Feed lists the rollout from 12:19; and replaying 12:15–12:35
animates the bands.

#### INF-017 — Scheduling and failure states
**MUST** · M-UI3 · Platform, SRE

Pods MUST show their scheduling and failure states with the reason text from the platform: Pending
(with the scheduler's reason, e.g. insufficient memory), CrashLoopBackOff, OOMKilled, image pull
errors, evicted, and not ready. Pending pods MUST hover above their namespace (Table 16-7), not be
placed on a node. The cluster header strip (EST-017) MUST count each state.

*Acceptance:* Given 3 pods Pending for insufficient memory and one container in CrashLoopBackOff
after OOMKilled, when the Workload arrangement renders, then 3 blocks hover in the Unscheduled cloud
with the reason, the crash-looping block is Failing with "CrashLoopBackOff · OOMKilled" and its restart
count, and the header strip reads "3 pending · 1 crash-looping".

#### INF-018 — Autoscaling envelope
**SHOULD** · M-UI3 · Platform, SRE

A workload with a horizontal autoscaler SHOULD show its envelope: ghost blocks to max replicas, a
min mark, and the current metric against its target. A workload at max replicas with its metric
above target SHOULD carry a "scaling limit" badge. Node additions and removals by a cluster
autoscaler SHOULD appear as Change Feed events and as buildings rising or sinking in replay.

*Acceptance:* Given checkout at 10 replicas, max 16, CPU 82 % against a 70 % target, then 6 ghost blocks
sit above the tower and the label shows "82 % / 70 %"; at 16 replicas with CPU still above target the
tower carries the "scaling limit" badge.

#### INF-019 — Storage attachment
**SHOULD** · M-UI5 · Platform, SRE

PVCs SHOULD be drawn as anchor lines from their pods to volume discs, through the PV to the backing
volume (a cloud block volume or an array LUN, §8), with capacity, used % and latency on the disc.

*Acceptance:* Given pg-orders with 3 PVCs of 200 GiB on cloud block volumes, when its tower is
selected, then three anchor lines run from blocks 0, 1 and 2 to three discs, each showing size and
used %, and selecting a disc opens the backing volume's Lens.

#### INF-020 — Service and ingress paths
**MUST** · M-UI3 · SRE, Engineer, Platform

Services, Ingresses and Gateways MUST be drawn as gates with arcs to their **ready** endpoints only. A
Service with zero ready endpoints MUST be Failing with the label "0 ready endpoints". Traffic MUST
follow the Traffic layer (particles ∝ request rate where request metrics exist).

*Acceptance:* Given payments-api with 0 ready endpoints out of 3 pods, when the namespace renders,
then its gate is Failing, labelled "0 ready endpoints", and no arc is drawn to the 3 not-ready blocks.

#### INF-021 — Control-plane health
**MUST** · M-UI3 · Platform, SRE

The control-plane hall MUST show the health of the API server (request latency, error rate), etcd
(leader changes, fsync latency, database size), scheduler (scheduling latency, pending queue) and
controller manager (work-queue depth), each where observable (INF-014). A control-plane degradation
MUST be a candidate origin for RCA ([06](06-ai-copilot.md)) of incidents in that cluster.

*Acceptance:* Given an etcd fsync latency p99 above its baseline, when the cluster renders, then the
hall is Watch or worse with "etcd fsync p99" in its label, and an incident on workloads in that
cluster lists the control plane among the candidate origins.

#### INF-022 — Kubernetes events as a signal
**SHOULD** · M-UI3 · Platform, SRE, Engineer

Kubernetes events ingested as logs SHOULD attach to the object they involve. Warning events SHOULD
appear as badges on the object and on the Lens timeline, and scheduling, scaling, rollout,
eviction and node-condition events SHOULD enter the Change Feed.

*Acceptance:* Given FailedScheduling and BackOff events for checkout pods between 12:19 and 12:31,
when the checkout workload Lens opens, then its events list shows them in order and the Lens
timeline carries their badges.

#### INF-023 — Multi-cluster fleets
**MUST** · M-UI3 · Platform, SRE

The same workload (same namespace and name) in several clusters MUST be selectable as one fleet
workload. Selecting it MUST highlight its towers in every cluster, and its Lens MUST compare it
across clusters (replicas, version, error rate, restarts).

*Acceptance:* Given checkout in 4 clusters across 2 clouds, when the user selects "checkout (fleet)"
in the Explorer, then 4 towers are highlighted on the Landscape and the Lens shows one column per
cluster, with the cluster on a different version flagged.

## 7. Networks

Networks are invisible in most estate views until something is blocked. The **Network layer**
([15](15-estate-navigation.md) §7) makes them physical. Mockup:
[30-network-layer-3d](../mockups/30-network-layer-3d.svg).

**Table 16-8 — Network layer encodings**

| Element | 3D form |
|---|---|
| Virtual network | Glass enclosure volume on the region plateau (translucent walls, hairline edges), labelled with name and CIDR |
| Subnet | Floor tile inside its enclosure on its zone terrace; public subnets solid-edged, private dashed |
| Security boundary (security group, firewall rule set, network policy) | Thin translucent inner wall around the entities it governs |
| Gateway (internet, NAT, private endpoint, egress) | Arch gate in the enclosure wall |
| Peering, transit hub, VPN, interconnect | Bridge between enclosures; hexagonal platform for a hub; bridge leaving the plateau for VPN / interconnect (INF-012) |
| Flow | Traffic particles along the path; denied flows stop at the wall with ⨯ |

Entities other than network entities are dimmed while the layer is on.

#### INF-024 — Network layer
**SHOULD** · M-UI5 · Platform, SRE, Security

Dash SHOULD offer a Network layer that draws Table 16-8 in the Map, City and Infra views, from
connector inventory (INF-010) and network telemetry. Kubernetes network policies SHOULD be drawn as
security boundaries inside the cluster district. The 2D equivalent under `T` MUST be a nested
network diagram (virtual network → subnet → entity) with the same selection.

*Acceptance:* Given a connector reporting two virtual networks with 6 subnets, 4 security groups, a
NAT gateway and a peering, when the Network layer is on, then two enclosures with 6 subnet tiles,
4 inner walls, a gate and a bridge are drawn, and every compute and data entity stands on its subnet
tile.

#### INF-025 — Flows and denied flows
**SHOULD** · M-UI5 · Platform, SRE, Security

When flow logs are present in PulsusDB, the Network layer SHOULD draw flows between entities as
particles ∝ flow rate, and denied flows as particles stopping at the boundary that denied them, with
⨯, the port and protocol, and the rate. A new denied flow between entities that previously
communicated SHOULD be a change event and an RCA candidate.

*Acceptance:* Given flow logs with checkout → pg-orders tcp/5432 denied at 1 200 flows/min from 12:19,
when the Network layer is on, then failing-coloured particles stop at the pg-orders boundary with
"denied · tcp/5432 · 1.2k/min", and the Change Feed lists "new denied flow" at 12:19.

#### INF-026 — Reachability explanation
**MAY** · M-UI6 · Platform, Security

Dash MAY answer "can A reach B on port P?" from connector inventory, drawing the path through
subnets, boundaries and gateways, and naming the rule that allows or denies it.

*Acceptance:* Given A and B in peered networks with a boundary denying port 5432, when the user asks
for A → B tcp/5432, then the path is drawn to the boundary and the denying rule is named.

## 8. On-prem and generic components

Mockup: [31-datacentre-hall-3d](../mockups/31-datacentre-hall-3d.svg). The physical-layout variant
of [15](15-estate-navigation.md) (EST-021, EST-056) gives the hall, rows and rack cabinets; this
section fills them.

#### INF-027 — Hypervisors and VMs
**SHOULD** · M-UI5 · Platform, SRE

Hypervisor hosts SHOULD be drawn as buildings (or U-slot blocks in the rack variant) whose VMs are
floor slabs, slab thickness ∝ vCPU and fill ∝ usage, with hypervisor clusters as districts and
datastores as storage shapes linked to the hosts that mount them. Hypervisor-specific health (CPU
ready, ballooning, datastore latency) SHOULD bind to the Health layer.

*Acceptance:* Given a hypervisor host with 4 VMs, one at 9 % CPU ready, when the host is cut away,
then 4 slabs are drawn with thickness ∝ vCPU, and the slab at 9 % CPU ready is Watch with
"CPU ready 9 %".

#### INF-028 — Network devices and discovered links
**SHOULD** · M-UI5 · Platform, NOC

Switches, routers, firewalls and load-balancer appliances monitored through SNMP or streaming
telemetry SHOULD be entities of their `network.*` class, placed in their rack where known, with
interface metrics. Links discovered from neighbour-discovery tables SHOULD be drawn as overhead arcs
between devices, with utilisation particles and error state.

*Acceptance:* Given a top-of-rack switch with uplinks to two spines discovered by neighbour
discovery and 340 CRC errors/min on one, when the hall renders, then two arcs join the switch to the
spines, and the erroring one is Degraded with "CRC errors 340/min".

#### INF-029 — Storage systems
**SHOULD** · M-UI5 · Platform

Storage arrays, NAS and SAN devices SHOULD be `storage.array` entities with capacity, used %, IOPS and
latency, and SHOULD link by volume threads to the hosts, VMs and PVs that mount their volumes.

*Acceptance:* Given an array exporting 12 volumes mounted by 6 hypervisor hosts, when the array is
selected, then 6 threads link it to those hosts, and its label shows capacity and used %.

#### INF-030 — Facilities
**MAY** · M-UI6 · Platform, NOC

Dash MAY show facility entities (PDUs, UPS, cooling) as power bars on rack sides and a thermal haze
layer over rows, from SNMP or facility telemetry, with power and temperature thresholds as health.

*Acceptance:* Given a rack PDU at 92 % load and a row inlet temperature of 29 °C, when the hall renders
with the facility layer, then the rack's power bar is Watch with "92 %" and the row carries a haze
labelled 29 °C.

## 9. Coverage and scale

#### INF-032 — Mixed estate at scale
**MUST** · M-UI3 · Platform, NOC, SRE

The 3D estate MUST meet [15](15-estate-navigation.md) EST-047 and EST-062 on the **mixed-estate
fixture**: 3 public clouds with 12 regions and 40 accounts, 1 private cloud, 2 on-prem data centres;
50 Kubernetes clusters of 5 distributions with 10k nodes, 200k pods and 6 000 workloads; 20k VMs;
2 000 managed resources across every class family; 500 network devices; and 50 resources of unmapped
types. Mixed shapes MUST NOT break the draw budget: each shape family MUST be one instanced draw
per viewport ([T02](../technical/T02-vis-engine.md) T02-002).

*Acceptance:* Given the mixed-estate fixture, when the user flies from the globe to a workload tower
and back, then frame rates meet EST-062 on reference hardware, and the draw count per frame is at most
one per shape family per viewport plus labels (`bench:inf-mixed-estate`).

#### INF-033 — Coverage by provider and class
**MUST** · M-UI3 · Platform, SRE leads

The Coverage layer MUST offer a provider × class-family matrix showing, per cell, entities with
telemetry, inventory-only entities, unknown types and unmapped metric series, and clicking a cell
MUST highlight those entities.

*Acceptance:* Given the mixed-estate fixture, when the matrix opens, then the cloud-B × messaging cell
reads e.g. "14 · 2 inventory-only · 0 unknown", and clicking "2 inventory-only" highlights exactly those
two entities on the Landscape.

## 10. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| INF-001 | Canonical infrastructure classes | MUST | M-UI3 |
| INF-002 | One shape grammar per class family | MUST | M-UI3 |
| INF-003 | Unknown resource types are drawn, never dropped | MUST | M-UI3 |
| INF-004 | Provider is identity, not style | MUST | M-UI3 |
| INF-005 | The three largest public clouds out of the box | MUST | M-UI3 |
| INF-006 | Further public and private clouds | SHOULD | M-UI5 |
| INF-007 | Account, subscription and project as fenced lots | MUST | M-UI3 |
| INF-008 | Managed services are first-class entities | MUST | M-UI3 |
| INF-009 | Unmapped cloud metrics are visible | MUST | M-UI3 |
| INF-010 | A read-only connector for each supported cloud | SHOULD | M-UI5 |
| INF-011 | The same service in several clouds | SHOULD | M-UI5 |
| INF-012 | Hybrid links as bridges | SHOULD | M-UI5 |
| INF-013 | Kubernetes object model | MUST | M-UI3 |
| INF-014 | Any conformant distribution | MUST | M-UI3 |
| INF-015 | Workload arrangement in 3D | MUST | M-UI3 |
| INF-016 | Rollouts are visible | MUST | M-UI3 |
| INF-017 | Scheduling and failure states | MUST | M-UI3 |
| INF-018 | Autoscaling envelope | SHOULD | M-UI3 |
| INF-019 | Storage attachment | SHOULD | M-UI5 |
| INF-020 | Service and ingress paths | MUST | M-UI3 |
| INF-021 | Control-plane health | MUST | M-UI3 |
| INF-022 | Kubernetes events as a signal | SHOULD | M-UI3 |
| INF-023 | Multi-cluster fleets | MUST | M-UI3 |
| INF-024 | Network layer | SHOULD | M-UI5 |
| INF-025 | Flows and denied flows | SHOULD | M-UI5 |
| INF-026 | Reachability explanation | MAY | M-UI6 |
| INF-027 | Hypervisors and VMs | SHOULD | M-UI5 |
| INF-028 | Network devices and discovered links | SHOULD | M-UI5 |
| INF-029 | Storage systems | SHOULD | M-UI5 |
| INF-030 | Facilities | MAY | M-UI6 |
| INF-031 | Self-hosted and managed share one shape | MUST | M-UI3 |
| INF-032 | Mixed estate at scale | MUST | M-UI3 |
| INF-033 | Coverage by provider and class | MUST | M-UI3 |

## 11. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Created from the owner brief: all major clouds, Kubernetes deployments and generic infrastructure in 3D |
