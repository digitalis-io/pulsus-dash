# T12 — Entity catalogue & graph service

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Milestone** | M-UI2 (catalogue, schema, R3 fallback) → M-UI3 (graph diffs, change feed, health, classes, Kubernetes model, three clouds) → M-UI5 (connectors, network inventory, devices, further clouds) → M-UI6 (remaining clouds, reachability, facilities) |
| **Related ADRs** | [ADR-0001](../adr/0001-rust-wasm-everywhere.md), [ADR-0005](../adr/0005-arrow-wire-format.md), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T12-entity-catalogue.md (not tracked) |

## 1. Context & problem

Pulsus is entity-first: the Landscape, Lenses, breadcrumbs, the Explorer, alert projections and RCA
scope all read one **entity set**. The product requires that:

- entities and their relationships are derived from telemetry with zero configuration, on a
  configurable hierarchy ([15](../product/15-estate-navigation.md) §1,
  [02](../product/02-information-architecture.md) §2.1);
- every infrastructure entity has one **canonical class** and the shape family of that class,
  whatever the provider, with clouds, Kubernetes, networks and on-prem devices modelled by
  **data-driven mapping packs** ([16](../product/16-infrastructure-model.md));
- ephemeral entities keep first/last seen for 30 days in Postgres, and the graph refreshes every 60 s
  without a reload (EST-046);
- a **Change Feed** ranks changes by proximity to an onset, every entity has a five-state health with
  a "why", and collections sort by **care** ([01a](../product/01a-audiences-and-perspectives.md) §4.2–§4.4);
- all of it works at **1M containers / 10k services** and on the **mixed-estate fixture** (INF-032).

PulsusDB has no inventory endpoint today. R3 (inventory) and R8 (version transitions) are open
([pulsusdb-requirements](pulsusdb-requirements.md)), so the service works on fallbacks from day one.
Dash-derived state lives in Postgres ([ADR-0012](../adr/0012-derived-state-in-postgres.md)); Dash
never writes derived series or events into PulsusDB.

## 2. Goals / non-goals

**Goals**
- One per-tenant entity graph from all four signals plus optional connectors, refreshed every 60 s,
  with incremental diffs pushed to subscribed clients.
- One class per infrastructure entity from versioned mapping packs plus per-org overrides.
- Kubernetes, cloud hierarchy, network inventory and on-prem devices as first-class entities.
- Bounded R3 and R8 fallbacks; one change-event model for T15 (draft) and [T16](T16-alert-evaluator.md).
- Health, care and an LLM-free anomaly sweep; RBAC filtering that never leaks hidden names.

**Non-goals**
- Rendering, shapes and layout ([T02](T02-vis-engine.md), T14 (draft)). T12 supplies `class` and
  `shape_family` per entity; T02 draws them.
- Summary pyramids and the local engine (T13 (draft)). T12 consumes the same rollups.
- Root-cause scoring (T15 (draft)). T12 supplies its inputs.
- DDL. [T11](T11-postgres-schema.md) §4.4 and §4.13 are authoritative; this doc gives the logical
  model and the changes it needs (§5.4).
- Writing to any cloud, cluster or device. Every connector is read-only (T12-020).

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [IA-010](../product/02-information-architecture.md#ia-010--entities-are-derived-from-telemetry) | §4.2, §4.5, §4.6; overrides §6 | `golden:catalogue-graph-estates` (OTel demo: environment … route levels, service edges); `itest:entity-override-persist` |
| [IA-011](../product/02-information-architecture.md#ia-011--configurable-entity-schema) | §4.2, T12-003 | `itest:entity-schema-custom` |
| [IA-012](../product/02-information-architecture.md#ia-012--every-signal-row-maps-to-an-entity) | §4.2 `AttributeMap`, T12-004; unmapped rows §4.16 | `itest:signal-row-entity-map`; `itest:coverage-model` (unmapped row listed) |
| [EST-001](../product/15-estate-navigation.md#est-001--zero-config-relationship-derivation) | §4.2, §4.5, §4.6 | `golden:catalogue-graph-estates` (3 clusters + 1 on-prem DC; edges equal `service_graph`) |
| [EST-002](../product/15-estate-navigation.md#est-002--runs-on-from-co-occurrence) | §4.2 `runs_on`, §4.6, §4.10 | `itest:runs-on-cooccurrence` (14 pods / 6 nodes, first/last seen) |
| [EST-003](../product/15-estate-navigation.md#est-003--entity-kinds-on-the-landscape) | §4.3, §4.4, §4.12 pipeline entities | `golden:catalogue-graph-estates` (mixed estate: every kind with class and shape; PulsusDB has health) |
| [EST-004](../product/15-estate-navigation.md#est-004--inventory-connectors-and-inventory-only-entities) | §4.11, T12-021 | `itest:connector-contract` (idle managed DB → inventory-only, counted blind) |
| [EST-013](../product/15-estate-navigation.md#est-013--crossing-chips) | §4.5 `Rel`; §5.2 `crossing_counts` | `itest:runs-on-cooccurrence` (chip counts equal graph counts) |
| [EST-041](../product/15-estate-navigation.md#est-041--coverage-layer-shows-where-you-cannot-see) | §4.16 | `itest:coverage-model` (2 of 4 parts, blind) |
| [EST-046](../product/15-estate-navigation.md#est-046--entity-graph-cache-and-ephemeral-history) | T12-001, §4.9, §4.10 | `itest:catalogue-refresh-60s`; `itest:ephemeral-replay` |
| [INF-001](../product/16-infrastructure-model.md#inf-001--canonical-infrastructure-classes) | §4.3, §4.4, T12-007 | `itest:inf-class-resolution` (`class=data.relational` across providers; `family=messaging`) |
| [INF-002](../product/16-infrastructure-model.md#inf-002--one-shape-grammar-per-class-family) | §4.3 `shape_family` attribute (§5.3); rendering [T02](T02-vis-engine.md) | `unit:inf-class-shape-table`; `golden:inf-shape-grammar-greyscale` |
| [INF-003](../product/16-infrastructure-model.md#inf-003--unknown-resource-types-are-drawn-never-dropped) | §4.4 rule 7, T12-008 | `itest:inf-class-resolution` (unknown → override → redrawn within one refresh) |
| [INF-004](../product/16-infrastructure-model.md#inf-004--provider-is-identity-not-style) | T12-005; `provider` column | `unit:inf-class-shape-table` (same class, two providers → identical shape columns) |
| [INF-005](../product/16-infrastructure-model.md#inf-005--the-three-largest-public-clouds-out-of-the-box) | §4.4 packs `aws`, `azure`, `gcp`; §4.7 | `itest:inf-cloud-placement` (placement, class, headline metrics per provider) |
| [INF-006](../product/16-infrastructure-model.md#inf-006--further-public-and-private-clouds) | §4.4 pack list, T12-007 | `itest:inf-class-resolution` (provider without a pack gets an island) |
| [INF-007](../product/16-infrastructure-model.md#inf-007--account-subscription-and-project-as-fenced-lots) | §4.2 cloud levels, §4.4 `hierarchy`, §4.11 shared resources | `itest:inf-cloud-placement` (two accounts per region; terms) |
| [INF-008](../product/16-infrastructure-model.md#inf-008--managed-services-are-first-class-entities) | §4.4 `managed`, §4.7 metric-only entities and segments | `itest:inf-cloud-placement` (one entity over 3 zones, 3 segments, dependency edge) |
| [INF-009](../product/16-infrastructure-model.md#inf-009--unmapped-cloud-metrics-are-visible) | §4.7, T12-012 | `itest:coverage-model` (unmapped id and metric names) |
| [INF-010](../product/16-infrastructure-model.md#inf-010--a-read-only-connector-for-each-supported-cloud) | §4.11, T12-020 | `itest:connector-contract` (write-capable credentials refused with reason) |
| [INF-011](../product/16-infrastructure-model.md#inf-011--the-same-service-in-several-clouds) | §4.8 service `locations` | `itest:inf-cloud-placement` (2 locations) |
| [INF-012](../product/16-infrastructure-model.md#inf-012--hybrid-links-as-bridges) | §4.11 `Link` edges, §4.12 | `itest:inf-network-model` ("VPN 1/2 up", Degraded) |
| [INF-013](../product/16-infrastructure-model.md#inf-013--kubernetes-object-model) | §4.8, T12-013 | `itest:inf-k8s-object-model` (per cluster-state source and both) |
| [INF-014](../product/16-infrastructure-model.md#inf-014--any-conformant-distribution) | §4.8, T12-015 | `itest:inf-k8s-distributions` |
| [INF-015](../product/16-infrastructure-model.md#inf-015--workload-arrangement-in-3d) | §4.8 `Workload` tree, revisions, ready counts (data); arrangement T02, T14 (draft) | `itest:inf-k8s-object-model` (block counts = ready + not-ready) |
| [INF-016](../product/16-infrastructure-model.md#inf-016--rollouts-are-visible) | §4.8 rollout state, §4.13 `Rollout` | `itest:inf-k8s-changes` |
| [INF-017](../product/16-infrastructure-model.md#inf-017--scheduling-and-failure-states) | §4.8 `PodStatus` | `itest:inf-k8s-object-model` (pending reason, CrashLoopBackOff · OOMKilled) |
| [INF-018](../product/16-infrastructure-model.md#inf-018--autoscaling-envelope) | §4.8 `Envelope`; node events §4.13 | `itest:inf-k8s-changes` |
| [INF-019](../product/16-infrastructure-model.md#inf-019--storage-attachment) | §4.8 PVC → PV → volume | `itest:inf-k8s-object-model` |
| [INF-020](../product/16-infrastructure-model.md#inf-020--service-and-ingress-paths) | §4.8, T12-014 | `itest:inf-k8s-object-model` (0 ready → Failing) |
| [INF-021](../product/16-infrastructure-model.md#inf-021--control-plane-health) | §4.8 control plane, §4.14 | `itest:inf-k8s-distributions` |
| [INF-022](../product/16-infrastructure-model.md#inf-022--kubernetes-events-as-a-signal) | §4.13 events read in place | `itest:inf-k8s-changes` |
| [INF-023](../product/16-infrastructure-model.md#inf-023--multi-cluster-fleets) | §4.8 fleet index | `itest:inf-k8s-object-model` (fleet of 4) |
| [INF-024](../product/16-infrastructure-model.md#inf-024--network-layer) | §4.11 network inventory | `itest:inf-network-model` |
| [INF-025](../product/16-infrastructure-model.md#inf-025--flows-and-denied-flows) | §4.11 flows, T12-022; §4.13 | `itest:inf-network-model` (denied flow, change event) |
| [INF-026](../product/16-infrastructure-model.md#inf-026--reachability-explanation) | §4.11 reachability (M-UI6) | `itest:inf-network-model` (deciding rule) |
| [INF-027](../product/16-infrastructure-model.md#inf-027--hypervisors-and-vms) | §4.12 | `itest:inf-onprem-model` |
| [INF-028](../product/16-infrastructure-model.md#inf-028--network-devices-and-discovered-links) | §4.12 | `itest:inf-onprem-model` (LLDP/CDP links, CRC errors) |
| [INF-029](../product/16-infrastructure-model.md#inf-029--storage-systems) | §4.12 | `itest:inf-onprem-model` |
| [INF-030](../product/16-infrastructure-model.md#inf-030--facilities) | §4.12 (M-UI6) | `itest:inf-onprem-model` |
| [INF-031](../product/16-infrastructure-model.md#inf-031--self-hosted-and-managed-share-one-shape) | §4.4 `core` pack, `runs_on` §4.2 | `itest:runs-on-cooccurrence` (self-hosted DB on a VM) |
| [INF-032](../product/16-infrastructure-model.md#inf-032--mixed-estate-at-scale) | T12-006; §7; draws T02 | `bench:inf-mixed-estate`; `bench:catalogue-mixed-estate-cycle` |
| [INF-033](../product/16-infrastructure-model.md#inf-033--coverage-by-provider-and-class) | §4.16, T12-019 | `itest:coverage-model` (cell counts, cell → entities) |

## 4. Design

### 4.1 Placement

T12 is three crates inside the BFF ([T06](T06-bff-architecture.md) §4.1 owns the layout):

```
 dash-catalogue   schema + AttributeMap · classes · packs → ClassResolver · harvest (signals, cluster
                  state, cloud metrics) · graph + diff · registry · connectors · netinv · subscribe
 dash-changefeed  change events: R8/fallback, webhooks, cluster state, k8s events, patterns, flows, diffs
 dash-health      health state, care, anomaly sweep (scores and baselines in Postgres)
```

**Leader and followers.** The catalogue refresh is a per-tenant singleton job on the **worker** role,
holding the [T06](T06-bff-architecture.md) §4.6 lease `catalogue.refresh/{tenant}`. The lease holder
(the **leader**) harvests, builds the graph, persists, and announces each diff. Every **api** replica
is a **follower**: it loads the newest `catalogue_snapshots` row at start, then applies diffs. The
leader keeps a 30-minute diff ring and sends `NOTIFY catalogue_<tenant> '(epoch,seq)'` (the sequence
only: NOTIFY payloads are ≤ 8 KB); followers pull the diff over `/internal/v1/catalogue/diffs?since=`.

#### T12-001 — One writer per tenant, fenced
**MUST** — Only the holder of `catalogue.refresh/{tenant}` MAY harvest, mutate the graph or write the
catalogue tables. Every write (`entities`, `entity_edges`, `catalogue_snapshots`,
`entity_change_events`) MUST carry the lease's fencing token (T06-015) and is rejected if a newer
token has been seen.

#### T12-002 — Followers converge or reload
**MUST** — A follower MUST apply diffs strictly in `(epoch, seq)` order. On a gap it cannot fill from
the leader's ring, or on an epoch change (new leader), it MUST reload from the newest snapshot plus the
following diffs. Followers MUST serve reads from their last consistent state while catching up.
Failover is ≤ 15 s (T06-015) plus one refresh; a new leader starts a new `epoch`.

### 4.2 Entity schema

The schema maps resource attributes to **levels** (entity kinds) and declares identifying keys,
parents per containment tree, the class source, and the relationships each kind takes part in. It is
stored versioned in `entity_schema` ([T11](T11-postgres-schema.md) §4.4), edited in Admin
([04](../product/04-surfaces.md)), and exportable as YAML. The shipped default (excerpt):

```yaml
version: 8
kinds:   # hierarchy levels and app entities have no class (§4.3)
  environment:  { id: [deployment.environment.name|deployment.environment] }
  provider:     { id: [cloud.provider|"on-prem"] }
  organisation: { id: [cloud.provider, $pack.org_id], parent: provider }                    # INF-007
  account:      { id: [cloud.provider, cloud.account.id], parent: [organisation?, provider] }
  region:       { id: [cloud.provider, cloud.region], parent: provider }
  zone:         { id: [cloud.provider, cloud.availability_zone], parent: region }
  site:         { id: [site.name], class: facility.site }                                 # on-prem
  rack:         { id: [site.name, rack.name], parent: [hall?, site], class: facility.rack, tree: physical }
  cluster:      { id: [k8s.cluster.uid|k8s.cluster.name], parent: [zone?, region?, account?, site?], class: container.cluster }
  node:         { id: [k8s.cluster.name, k8s.node.name], parent: [node_pool?, cluster], class: container.node, ephemeral: true }
  namespace:    { id: [k8s.cluster.name, k8s.namespace.name], parent: cluster, tree: workload, class: container.namespace }
  workload:     { id: [k8s.cluster.name, k8s.namespace.name, $k8s.workload_kind, $k8s.workload_name], parent: namespace, tree: workload, class: container.workload }
  pod:          { id: [k8s.cluster.name, k8s.namespace.name, k8s.pod.name], parent: { infra: node, workload: workload }, class: container.pod, ephemeral: true }
  container:    { id: [k8s.pod.uid|k8s.pod.name, k8s.container.name|container.name], parent: pod, class: container.container, ephemeral: true }
  host:         { id: [host.id|host.name], parent: [zone?, rack?, hypervisor_host?], class: $pack.host_class, ephemeral: true }
  process:      { id: [host.name, process.pid, process.executable.name], parent: host, class: compute.process, ephemeral: true }
  service:      { id: [service.namespace?, service.name], parent: environment }
  route:        { id: [service.namespace?, service.name, http.route|span.name], parent: service }
  resource:     { id: [cloud.provider, cloud.resource_id], parent: [zone?, region, account?], class: $pack }   # §4.4
  # hall, node_pool, control_plane, hypervisor_host, device … : same pattern (§4.8, §4.12)
runs_on: [[service, pod], [service, host], [pod, node], [host, hypervisor_host], [resource, host]]  # EST-002, INF-031
dependencies:
  - { source: service_graph }
  - { attr: db.system,        kind: resource, class: $pack.core, id: [db.system, server.address|db.namespace] }
  - { attr: messaging.system, kind: resource, class: $pack.core, id: [messaging.system, messaging.destination.name] }
  - { attr: server.address,   kind: external, when: "no matching service or resource" }
ownership:
  team: [service.namespace, k8s.namespace.label.team, entity_override.owner, connector.owner]
```

`a|b` means "first present". `?` means optional. A kind's `class:` is either a fixed class or `$pack`
(resolved per entity by §4.4); `$pack.*` and `$k8s.*` values come from the mapping packs and the
Kubernetes deriver (§4.8). `tree:` names the containment tree (§4.5); the default
is `infra`. Org-specific kinds (data hall, PoP, cage) are added as new kinds with configurable
attributes.

**Per-signal mapping.** Logs flatten resource attributes into labels (`service.name` →
`service_name`), traces keep OTel names (`resource.service.name`), and metrics put `service.*` into
`job`/`instance` and the rest on `target_info`. The schema compiles into a per-signal `AttributeMap`
(`label_mappings` rows per tenant binding), the label ⇄ attribute translation of
[02](../product/02-information-architecture.md) §4.

#### T12-003 — The schema is versioned and previewed
**MUST** — Every schema change MUST create a new `entity_schema` version and MUST be dry-run first
(`POST …/entity-schema/preview`) against the last harvest, reporting entities added, removed and
**re-identified**. Re-identified entities MUST keep an alias from old to new id for 30 days, so links
and alert labels still resolve.

#### T12-004 — One attribute map
**MUST** — Translating an entity to a query matcher, or a signal row to an entity, MUST go through the
compiled `AttributeMap` (`selector_for`, `resolve`, §5.2). No other module may hard-code a label name
for an entity attribute.

### 4.3 Classes and shape families

Table 16-1 ([16](../product/16-infrastructure-model.md) §3) is compiled into the catalogue as Rust
enums. The text form (`data.relational`) is the stable identifier used in YAML, URLs, filters and the
wire.

```rust
#[repr(u8)]
pub enum ClassFamily { Compute, Container, Serverless, Data, Messaging, Storage, Network, Edge,
                       Security, Facility, External, Other }
/// Generated by build.rs from `classes.yaml` (= Table 16-1): one variant per class, in table order.
#[repr(u8)]
pub enum Class { ComputeVm, ComputeBareMetal, /* … ContainerPod, DataRelational, NetworkSubnet,
                 FacilityRack, ExternalSaas … */ OtherUnknown }
impl Class {
    pub const fn family(self) -> ClassFamily;              // Table 16-1
    pub const fn shape(self) -> (ShapeFamily, ShapeForm);  // Table 12-1 (from Table 16-3)
    pub fn parse(s: &str) -> Option<Class>;                // "data.relational"
}

#[repr(u8)]   // one instanced draw per value per viewport (T02-002, INF-032)
pub enum ShapeFamily { Box, Building, Tower, Slab, Swarm, Cylinder, Ribbon, Vault, Disc, Cabinet,
                       Gate, Enclosure, Tile, Wall, Bridge, Hub, LockBlock, Ring, Ground, PowerBar }
#[repr(u8)]   // parametric sub-form inside a family: same mesh family, different instance parameters
pub enum ShapeForm { Plain, Hall, USlot, BlockGroup, Ghost, Squat, Wide, Cell, Outer }
```

**Table 12-1 — Class → shape family** (from 16 Table 16-3; `/Form` where not Plain)

| Classes | `ShapeFamily` / `ShapeForm` |
|---|---|
| `compute.vm`, `.bare_metal`, `.hypervisor_host`, `container.node`; `compute.autoscaling_group`, `container.node_pool`; `container.control_plane` | Building (USlot in a rack); Building/BlockGroup; Building/Hall |
| `container.workload`, `.task_service`; `container.autoscaler`; `container.pod`, `.container`, `compute.process` | Tower; Tower/Ghost; Slab (Cell for container, process) |
| `container.cluster`, `.namespace`, `facility.site`, `.hall` | Ground |
| `serverless.*`; `data.*` (cache Squat, warehouse Wide); `messaging.*` | Swarm; Cylinder; Ribbon |
| `storage.object`, `.file`, `.backup_vault`; `storage.block`, `container.volume_claim`; `storage.array` | Vault; Disc; Cabinet/Wide |
| `network.virtual_network`; `.subnet`; `.security_boundary` | Enclosure; Tile; Wall |
| `network.gateway`, `.load_balancer`, `.dns_zone`, `container.service_endpoint`, `.ingress`; `edge.*` | Gate; Gate/Outer |
| `network.peering`, `.vpn`, `.interconnect`; `network.transit_hub` | Bridge; Hub |
| `network.switch`, `.router`, `.firewall`, `facility.rack`; `facility.pdu`, `.ups`, `.cooling` | Cabinet; PowerBar |
| `security.*`; `external.*`; `other.unknown` | LockBlock; Ring; Box |

Hierarchy levels (environment, provider, organisation, account, region, zone), application entities
(service, route) and hypervisor clusters are **not infrastructure**: they have `class = None` and are
drawn by the landscape grammar of [15](../product/15-estate-navigation.md) (islands, plateaus, fenced
lots, terraces, the app floor). INF-001 applies to every other entity (§13 Q6).

#### T12-005 — Shape is a function of class only
**MUST** — `shape_family` MUST be computed only by `Class::shape()`, and `shape_form` only from the
class and its containment placement (e.g. USlot in a rack). Provider, native type, tags and connector
MUST NOT alter either; the provider is an attribute and a `provider` column (§5.3) for grouping and
the text badge, never style (INF-004).

#### T12-006 — The shape family set is closed and small
**MUST** — `ShapeFamily` MUST have at most 24 values, and adding one is a minor wire change agreed with
[T02](T02-vis-engine.md), so that "one instanced draw per shape family per viewport" bounds the draw
count of any estate (INF-032).

### 4.4 Mapping packs

A **mapping pack** is a versioned YAML document, embedded in the binary with `include_str!`, that maps
telemetry attributes and provider-native resource types to classes, hierarchy terms, metric joins and
headline metric bindings. Packs are data, not code: adding a native type is a pack change only.

| Pack | Covers | Milestone |
|---|---|---|
| `core` | Provider-neutral semconv: `db.system`, `messaging.system`, `process.executable.name`, `server.*`, `faas.*`, telemetry pipeline (collector, PulsusDB) | M-UI3 |
| `kubernetes` | Objects of 16 Table 16-6, both cluster-state sources, node-pool labels, distribution rules (§4.8) | M-UI3 |
| `aws`, `azure`, `gcp` | `cloud.platform` values, native types, hierarchy terms, metric joins, headline bindings (Table 16-5) | M-UI3 |
| `oracle_cloud`, `alibaba_cloud`, `openstack`, `vsphere`, `onprem` (SNMP devices, arrays) | As above; `onprem` maps device identities to `network.*`, `storage.array`, `facility.*` | M-UI5 |
| `ibm_cloud`, `tencent_cloud`; `onprem` facility objects | As above | M-UI6 |

```yaml
pack: aws
version: 2026.11.1
hierarchy:                     # INF-007: canonical level → provider term and attribute
  organisation: { term: "Organization", attr: [connector.org_id] }
  account: { term: "Account", attr: [cloud.account.id] }
  zone: { term: "Availability zone", attr: [cloud.availability_zone] }   # region: "Region"
platforms:                     # OTel cloud.platform → class of the resource carrying it
  aws_ec2: { class: compute.vm }
  aws_eks: { class: container.cluster, managed: true, distribution: eks }
  aws_ecs: { class: container.task_service, managed: true }
  aws_lambda: { class: serverless.function, managed: true }
  aws_app_runner: { class: serverless.app, managed: true }   # + aws_elastic_beanstalk, aws_openshift
native_types:                  # connector and cloud-metric resource types
  "AWS::RDS::DBInstance":    { class: data.relational, managed: true, zonal: multi }
  "AWS::SQS::Queue":         { class: messaging.queue, managed: true }
  "AWS::EC2::Volume":        { class: storage.block, managed: true }
  "AWS::EC2::Subnet":        { class: network.subnet }
  "AWS::EC2::SecurityGroup": { class: network.security_boundary }
metric_joins:                  # INF-005 / INF-009: cloud metric series → resource id
  - { native_type: "AWS::RDS::DBInstance", probe: aws_rds_cpuutilization_average,
      resource_id: "arn:aws:rds:{region}:{account_id}:db:{dbinstance_identifier}" }
headline:                      # Table 16-5; {{sel}} = selector_for(entity, Metrics)
  data.relational:
    connections:   'aws_rds_database_connections_average{ {{sel}} }'
    replica_lag_s: 'aws_rds_replica_lag_average{ {{sel}} }'
```

```yaml
pack: core
version: 2026.11.1
db.system:        { postgresql: data.relational, mysql: data.relational, mongodb: data.document,
                    redis: data.cache, cassandra: data.wide_column, solr: data.search, neo4j: data.graph }
messaging.system: { kafka: messaging.stream, rabbitmq: messaging.queue, gcp_pubsub: messaging.topic }
process.executable.name: { nginx: network.load_balancer, envoy: network.load_balancer, postgres: data.relational }
pipeline:         { "otelcol*": compute.process, "pulsusdb": data.timeseries }   # EST-003 pipeline entities
```

**Resolution order** (first match wins): (1) org override in `class_mappings` by
(`provider`, `native_type`); (2) the schema's `class:` on the kind; (3) the provider pack's
`native_types`; (4) its `platforms` (`cloud.platform`); (5) the `core` pack (`db.system=postgresql` on a
VM → `data.relational`, unmanaged); (6) for hosts, `compute.vm` if `cloud.provider` or a hypervisor
parent is present, else `compute.bare_metal`; (7) `other.unknown`, keeping `native_type`, counted (§4.16).

#### T12-007 — Packs are data, embedded and versioned
**MUST** — Mapping packs MUST be YAML embedded in the binary, each with `pack` and `version`, and
MUST be the only place where provider-specific types, terms and metric names appear. A provider with
no pack MUST still get a `provider` entity (its island) from `cloud.provider`, with its hierarchy from
the OTel cloud attributes and its resources classed by rule 7 (INF-006).

#### T12-008 — Overrides apply at the next refresh
**MUST** — An admin mapping (`PUT /api/dash/v1/admin/class-mappings`) MUST be written to
`class_mappings` and announced with `NOTIFY catalogue_mappings_<tenant>`. The leader MUST recompile
its `ClassResolver` before the next cycle, and every affected entity MUST be re-emitted in that
cycle's diff with its new class and shape (INF-003: ≤ 60 s). An override never changes `EntityId`.

#### T12-009 — Packs are linted in CI
**MUST** — Every pack MUST pass `unit:mapping-pack-lint`: every class exists in Table 16-1, every
headline binding parses as PromQL with `{{sel}}`, every `metric_joins` template uses only labels the
probe series carries in the fixture, and every Table 16-5 class has bindings for `aws`, `azure` and
`gcp`.

### 4.5 Entity identity and the graph

```rust
pub struct EntityId(u128);   // xxh3-128(tenant_binding, kind, identifying values in schema order)
pub struct Entity {
    id: EntityId, kind: KindId, ident: SmallVec<[Sym; 4]>,  // interned identifying values
    class: Option<Class>,                                     // None for levels and app entities (§4.3)
    provider: Option<Sym>, native_type: Option<Sym>, managed: bool, attrs: AttrBag,
    signals: SignalMask,          // metrics | logs | traces | profiles | INVENTORY_ONLY
    first_seen: UnixSec, last_seen: UnixSec, source: SourceMask,
}
pub enum Rel { Contains(Tree),   // Infra | Workload | Network | Physical
               DependsOn(DepKind), // Rpc | Messaging | Db | External | Fronts | Link(Neighbour|Peering|Vpn|Interconnect|Transit) | Flow
               Owns, RunsOn,
               Attaches(AttachKind) } // Mounts | Autoscales | Guards
pub struct EntityGraph {
    g: petgraph::stable_graph::StableDiGraph<Entity, EdgeData>,   // EdgeData: rel, first/last seen, stats
    by_id: HashMap<EntityId, NodeIndex>, by_resource_id: HashMap<Sym, NodeIndex>,   // §4.7
    by_ip: IpIntervalIndex,       // time-aware IP → entity, CIDR → subnet (§4.11)
    interner: lasso::ThreadedRodeo, epoch: u64, seq: u64,
}
```

Each entity has one parent per containment **tree**. `Infra` is the primary ladder of
[15](../product/15-estate-navigation.md) Table 15-1 (`parent_id` on the wire); `Workload` is
cluster → namespace → workload → pod; `Network` is virtual network → subnet → entity; `Physical` is
site → hall → rack → device. The four relationships of 15 are `Contains`, `DependsOn`, `Owns` and
`RunsOn`; `Attaches` refines dependency for storage, autoscaling and security boundaries.

#### T12-010 — Stable identity, 64-bit wire id
**MUST** — `EntityId` MUST be the xxh3-128 of the tenant binding, kind and identifying values in schema
order, stored as `uuid` in Postgres (T11 `entities.id`). The wire carries `entity_id: UInt64`
([T04](T04-wire-format-and-data-plane.md) `entities/1`) = the high 64 bits. The leader MUST check
wire-id uniqueness per tenant on insert; on a collision (≈ 5·10⁻⁸ at 1.3M entities) the newer entity
gets `xxh3_64(id ‖ 1)`, recorded in the snapshot as an alias, and `catalogue_wire_id_collisions_total`
is raised.

### 4.6 Harvesting (R3 and fallback)

**With R3** (preferred): one request per signal per refresh for the distinct combinations of the
schema's attribute keys with `first_seen`/`last_seen`. The harvester only maps rows to entities and
co-occurrence edges.

**Fallback (R3 absent).** Label-values calls cannot produce **combinations**, so they cannot derive
runs-on; the fallback uses series-listing endpoints that return label sets. **Table 12-2** gives the
calls and their cost per 60 s refresh on the very large estate (100 clusters, 3 000 namespaces, 10k
services, 1M containers):

| Signal | Call | Yields | Calls (very large) |
|---|---|---|---|
| Partition keys | label values `k8s_cluster_name` (logs; metrics on `target_info`); else environment / `host_name` prefix | Cluster list | 2 |
| Logs | `GET /api/logs/v1/series?match[]={k8s_cluster_name="<c>"}&start=now-2m&end=now` | One label map per active stream (≤ 100k per answer; stream index only) | 100 (≈ 1 MB each) |
| Metrics | `GET /api/v1/series?match[]=target_info{k8s_cluster_name="<c>"}` | One label set per `job`/`instance` with every resource attribute | 100 |
| Cluster state | `GET /api/v1/series` with the `kubernetes` pack's `match[]` set + 4 instant queries, per 10-cluster batch (§4.8) | Owner chains, endpoints, claims, autoscalers, pod status | 50 |
| Traces | `tag/resource.service.name/values?q={resource.k8s.namespace.name="<ns>"}`, then pod/node tags for trace-only services | Trace-only services and pods | ≤ 3 000 on the 10-min cadence; < 200 links |
| Trace edges | `GET /api/traces/v1/service_graph?start=now-5m&end=now` | Edges with calls / failed / p50 / p95 / p99 (cap per A1) | 1 |
| Profiles | `POST /api/profiles/v1/series` with `labelNames` = mapped keys | Which entities have profiles | 1 |
| Cloud metrics | `GET /api/v1/series?match[]=<probe>` per pack `metric_joins` entry (§4.7) | Resource ids | ≈ 90 per 10 min |
| **Total** | | ≈ 220 MB JSON, ≈ 22 s worker CPU per 60 s, under [T07](T07-scene-query-planner.md) `Budget::background` | ≈ 255 |

Harvest runs at **60 s for the hot set** (clusters with churn in the last 10 min) and **10 min for
the cold set**; JSON is parsed with `simd-json` into interned symbols. Medium estates need 4–6 calls.

**Service-graph cap.** `service_graph` has no filter and the edge target relies on A1 (cap ≥ 50 000).
If A1 is false or `truncated` is set, edges are derived per environment from TraceQL metrics on client
spans: `{kind=client && resource.deployment.environment="<env>"} | rate() by(resource.service.name, span.peer.service)`
(at most `reader.traceql_max_series` series per answer, partitioned by namespace). This loses
messaging edges and server-side latency, and the coverage meter says so.

#### T12-011 — Harvest is bounded and attributable
**MUST** — Every harvest call MUST run under the tenant's background budget through
`pulsusdb-client` (T06-005), carry a query id, and be counted per step in
`catalogue_harvest_calls_total{step}`. A step over its call or byte bound MUST be cut, recorded as
partial in the coverage model (§4.16), and never retried in the same cycle.

### 4.7 Cloud resources, metric joins and the unmapped list

Telemetry places cloud entities by `cloud.provider`, `cloud.account.id`, `cloud.region`,
`cloud.availability_zone`, `cloud.platform` and `cloud.resource_id`. Cloud monitoring metrics stored in
PulsusDB carry provider dimensions, not `cloud.resource_id`; each pack's `metric_joins` turns the
dimension labels of a probe series into the provider's canonical identifier (ARN, Azure resource id,
GCP full resource name, OCID…), which is looked up in `by_resource_id`:

- A resource id that matches an entity (from telemetry or a connector) binds the pack's headline
  queries to it; `selector_for(entity, Metrics)` returns the dimension matcher.
- A resource id with a known native type and enough hierarchy dimensions (account, region) becomes a
  **metric-only entity** of its class, so managed services appear without a connector (INF-008).
- Anything else goes on the **unmapped list**: `UnmappedSeries { provider, resource_id, metric_names
  (≤ 20), first_seen, last_seen }`, capped at 10 000 per tenant with an overflow count.
- **Multi-zone managed services** (INF-008): a resource whose pack entry has `zonal: multi` is one
  entity contained by its region, with `segments: [(zone, role, member_id)]` from member dimensions
  (e.g. primary and replicas). It is not duplicated per zone.

#### T12-012 — Unmapped is listed, never dropped
**MUST** — A cloud metric series whose resource id resolves to no entity MUST appear on the unmapped
list with its identifier and metric names within one slow cycle (≤ 10 min), and MUST leave the list
in the cycle after a mapping or connector resolves it (INF-009). The same applies to signal rows that
match no kind (IA-012).

### 4.8 Kubernetes

Entities and relationships of [16](../product/16-infrastructure-model.md) Table 16-6 come from OTel
`k8s.*` resource attributes plus **cluster-state metrics**. Both sources are supported, and the
`kubernetes` pack maps each to the same derivation:

**Table 12-3 — Kubernetes derivation**

| Relationship / fact | Cluster-state exporter series | Collector Kubernetes cluster receiver (`k8s.*` metrics; attributes on `target_info`) |
|---|---|---|
| pod → ReplicaSet | `kube_pod_owner{owner_kind="ReplicaSet", owner_name}` | `k8s.replicaset.name` on the pod resource |
| ReplicaSet → Deployment | `kube_replicaset_owner{owner_kind="Deployment"}` | `k8s.deployment.name` |
| pod → Job → CronJob | `kube_pod_owner{owner_kind="Job"}`, `kube_job_owner{owner_kind="CronJob"}` | `k8s.job.name`, `k8s.cronjob.name` |
| StatefulSet / DaemonSet | `kube_pod_owner{owner_kind=…}` | `k8s.statefulset.name`, `k8s.daemonset.name` |
| pod → node (runs-on) | `kube_pod_info{node}` | `k8s.node.name` |
| Pod phase, ready, reasons | `kube_pod_status_phase`, `kube_pod_status_ready`, `kube_pod_container_status_waiting_reason`, `kube_pod_container_status_last_terminated_reason`, `kube_pod_container_status_restarts_total`, `kube_pod_status_unschedulable` | `k8s.pod.phase`, `k8s.container.ready`, `k8s.container.restarts`, `k8s.container.status.last_terminated_reason` (where enabled) |
| Service → ready pods | `kube_endpointslice_endpoints{ready="true", targetref_name}` per slice; slice → Service by the `kubernetes.io/service-name` label, else name prefix | Not exported: needs the exporter or a connector (coverage note) |
| Ingress → Service | `kube_ingress_path{service_name}` | Not exported (coverage note) |
| PVC → PV → backing volume | `kube_pod_spec_volumes_persistentvolumeclaims_info`, `kube_persistentvolumeclaim_info{volumename}`, `kube_persistentvolume_info{csi_volume_handle}` | Not exported (coverage note) |
| HPA → target, envelope | `kube_horizontalpodautoscaler_info{scaletargetref_kind, scaletargetref_name}`, `…_spec_min_replicas`, `…_spec_max_replicas`, `…_status_current_replicas`, `…_status_desired_replicas`, `…_spec_target_metric` | `k8s.hpa.min_replicas`, `max_replicas`, `current_replicas`, `desired_replicas`; target from `k8s.hpa.scaletargetref.*` where present |
| Rollout | `kube_deployment_spec_replicas`, `…_status_replicas_updated`, `…_status_condition{condition="Progressing", reason}`, `…_spec_paused`, `kube_replicaset_created` | `k8s.deployment.desired`, `k8s.deployment.available`, `k8s.replicaset.desired/available` |
| Node pool, provider id, versions | `kube_node_labels` (pack label keys), `kube_node_info{provider_id, kubelet_version}` | `k8s.node.*` attributes |

Derived per-entity facts: `PodStatus { phase, ready, reason ("CrashLoopBackOff · OOMKilled"),
restarts, scheduled, sched_reason }`, `RolloutState { revisions[(rs, rev, pods)], updated, desired,
phase: Progressing | Paused | Stalled | RolledBack | Complete }` and `Envelope { min, max, current,
desired, metric: (value, target) }`.

- **Revisions** order by `kube_replicaset_created` (or the allowlisted revision annotation). A rollout
  is **Stalled** on `ProgressDeadlineExceeded` and **RolledBack** when the newest ReplicaSet scales to 0
  while an older one grows; each yields a `Rollout` change event, and pods carry their revision.
- **Pending pods** have no infra parent: they are contained by their cluster with `scheduled=false`
  and the scheduler's reason, taken from the newest `FailedScheduling` event (§4.13) (INF-017).
- **Node ↔ VM.** `provider_id` (e.g. `aws:///eu-west-1a/i-…`) is parsed by the cloud pack into a
  resource id and joined to the VM entity, so the node and its VM are one building with both identities.
- **PV → backing volume** joins `csi_volume_handle` to the cloud block volume's resource id or to an
  array volume (§4.12) (INF-019).
- **Control plane** is one `container.control_plane` entity per cluster bound to `apiserver_request_*`,
  `etcd_server_leader_changes_seen_total`, `etcd_disk_wal_fsync_duration_seconds`,
  `etcd_mvcc_db_total_size_in_bytes`, `scheduler_*` and `workqueue_depth`; components with no series are
  `managed_by_provider` on managed clusters, otherwise `not_observed` (INF-021).
- **Distribution and version** (INF-014): from `cloud.platform`, then pack rules on node labels and the
  `kubelet_version` suffix, else `conformant`. Stored as `k8s.distribution` and `k8s.version`
  attributes of the cluster.
- **Fleets** (INF-023): an index `xxh3_64(namespace, workload kind, name)` → workloads across clusters,
  served as `entities/fleet:{key}` with per-cluster replicas, version, error rate and restarts.
- **Multi-location services** (INF-011): a service's `locations` are the distinct (provider, region)
  pairs of the pods and hosts it runs on.
- **Non-Kubernetes schedulers** map to `container.task_service` with the same tower data.

#### T12-013 — Both cluster-state sources, one model
**MUST** — The Kubernetes deriver MUST derive each fact of Table 12-3 from whichever cluster-state
source provides it, through one model with no source-specific path above the pack, and MUST merge both
sources when present (exporter wins on conflicts). A fact that no present source exports MUST be shown
as a coverage note on the cluster, never silently absent.

#### T12-014 — Ready endpoints only
**MUST** — `DependsOn(Fronts)` edges from a Service or Ingress MUST point only to pods whose endpoint is
`ready="true"` in the latest refresh. A Service with zero ready endpoints MUST carry
`ready_endpoints = 0` and the health rule MUST make it Failing with "0 ready endpoints" (INF-020).

#### T12-015 — No distribution-specific core
**MUST** — Nothing in §4.8 may require a specific distribution. Distribution rules MAY only set
attributes (distribution, version, managed control plane, node-pool label key).

### 4.9 Refresh, diff and push

```
 every 60 s (leader, per tenant):
   harvest ──► Observation{kind, ident, attrs, signal, ts}* ──► resolve class (§4.4) ──► staging graph
           ──► diff(staging, live) ──► EntityDiff ──► apply to live, seq += 1
           ──► diff ring + NOTIFY ──► followers apply ──► WS subscribers (scope-filtered)
           ──► registry writer (batched, §6)        ──► change derivation (§4.13)
```

An entity is **live** if seen in the last 5 min (configurable per kind); otherwise it is `gone`, kept
with `last_seen`.

```rust
pub struct EntityDiff { epoch: u64, seq: u64, at: UnixSec,
    upserts: Vec<EntityDelta>, gone: Vec<EntityId>,       // gone = liveness change, never deletion
    edges_up: Vec<(EntityId, EntityId, Rel, Option<EdgeStats>)>, edges_gone: Vec<(EntityId, EntityId, Rel)>,
    coverage: Option<CoverageDelta> }                     // ≈ 5k rows / 200 KB per minute at 1–3 % churn
```

**Client subscription.** A subscription names a **scope** (e.g. `cluster:prod-eu-1`), kinds or
classes, and a depth; L0–L1 views get **aggregates only** (counts by class family, worst state per
container). Diffs are Arrow batches on the [T04](T04-wire-format-and-data-plane.md) WS channel
([ADR-0005](../adr/0005-arrow-wire-format.md)). On reconnect the client sends `(epoch, seq)`; the
follower replays from its ring or sends a scoped snapshot.

### 4.10 Ephemeral entity tracking

Ephemeral kinds stay in the registry for **30 days** after they go (EST-046). Per
[T11](T11-postgres-schema.md) §4.4, the precise `last_seen` lives in memory and in
`catalogue_snapshots`; `entities.last_seen_day` advances at most once a day per row, and dropping
daily partitions older than 30 days is the retention.

**Time travel** (`as_of=T`): candidates come from the registry (`first_seen ≤ T`,
`last_seen_day ≥ day(T)`); precise liveness at `T` is then confirmed by one scoped §4.6 series call for
`[T − 5 min, T]`, cached per window. Older than 30 days, the §4.6 calls with a historical window are
the only source. Runs-on edges follow the same rule, so "which node was this pod on at 03:12" works.

### 4.11 Connectors, network inventory and flows

```rust
#[async_trait::async_trait]
pub trait InventoryConnector: Send + Sync {
    fn id(&self) -> &str;
    async fn verify_read_only(&self) -> ReadOnlyCheck;  // Verified | Unverifiable(why) | WriteCapable(evidence)
    async fn poll(&self, since: Option<Cursor>) -> Result<(Vec<InventoryItem>, Cursor), ConnectorError>;
    async fn poll_network(&self, since: Option<Cursor>) -> Result<(Vec<NetItem>, Cursor), ConnectorError>;
    fn join_keys(&self) -> &[JoinKey];
}
pub enum NetItem { VirtualNetwork, Subnet, SecurityBoundary, Gateway, Peering, TransitHub, Vpn,
                   Interconnect, Attachment /* entity ↔ subnet, boundaries */ }
```

| Connector | Source | Read-only verification (T12-020) | Join key |
|---|---|---|---|
| AWS Config | Advanced query per account and region; organisation from the organisations API | `iam:SimulatePrincipalPolicy` for the caller over a probe set of write actions | `cloud.resource_id` (ARN), `host.id` = instance id |
| Azure Resource Graph | Resource Graph queries over subscriptions and management groups | Role assignments of the principal; any action outside `*/read` is write | Resource id |
| GCP Cloud Asset Inventory | Asset search per organisation, folder or project | `testIamPermissions` with a probe set of write permissions | Full resource name, `host.id` |
| Oracle Cloud; Alibaba Cloud | Resource search; Resource Center | Unverifiable → "read-only not verified"; probe-set simulation where available | OCID; resource id |
| OpenStack | Compute and network APIs; project as account | Token roles: only `reader` passes | Instance / port id |
| vSphere | vCenter API | Privileges of the session's role: only `System.*` and read privileges pass | `vcenter.vm.id`, host id |
| CMDB; service catalogue | Table API on CI classes; catalogue entities API | Token scope | Configured CI field; `service.name` ↔ component, owner → team |

Connectors run on the leader every 15 min (network inventory 60 min) with credentials per
[T18](T18-security.md). Matched items enrich an entity (owner, tier, cost centre, size, tags);
unmatched items become **inventory-only** (EST-004). A resource spanning accounts is contained by its
owning account, with bridge edges to the accounts that use it (INF-007).

**Network inventory** (INF-024) builds the `Network` tree: virtual network → subnet → entity.
Entities are placed on subnets by the connector's `Attachment`, else by matching their IPs
(`host.ip`, `k8s.pod.ip`, `network.local.address`) against subnet CIDRs in `by_ip`. Security boundaries
attach with `Attaches(Guards)`; Kubernetes network policies (cluster-state series) become
namespace-scoped boundaries. Peering, transit hubs, VPN tunnels and interconnects become
`DependsOn(Link(…))` edges with tunnel state, bandwidth and drops from connector and device metrics
(INF-012).

**Flow logs** (INF-025) are read from PulsusDB logs; the provider pack declares the stream selector
and field extraction. Every 60 s on the hot set:

```logql
sum by (src_addr, dst_addr, dst_port, protocol, action)
  (count_over_time({log_type="flow", cloud_account_id=~"<batch>"} | json [1m]))
```

Addresses map to entities through the time-aware `by_ip` index; pairs aggregate into
`DependsOn(Flow)` edges (`calls` = accepted, `failed` = denied, attributes `port`, `protocol`, `boundary`
= the boundary whose rule denied, when inventory knows it), top 5 000 pairs per tenant by rate.

**Reachability** (INF-026, M-UI6): `reach(a, b, port, proto)` walks the network tree and routes
(subnet → route table → gateway / peering / hub) and evaluates each boundary's rules in provider order,
returning the path and the first allowing or denying rule.

#### T12-020 — Connectors are read-only, verified where possible
**MUST** — A connector MUST NOT call any mutating API. Before its first poll and every 24 h it MUST
run `verify_read_only` without performing a write. On `WriteCapable` it MUST refuse to start (or stop)
and show the evidence in Admin (e.g. "role grants `compute.instances.delete`"). On `Unverifiable` it
MAY run, flagged "read-only not verified" (INF-010).

#### T12-021 — Inventory never silently deletes
**MUST** — An item that disappears from a connector MUST become `gone` through the normal liveness rule.
A connector failure MUST mark its inventory-only entities stale, never remove them.

#### T12-022 — Flows are aggregated, never stored raw
**MUST** — Dash MUST NOT copy flow-log records. Only entity-pair aggregates live in the graph, and only
`FlowDeniedNew` change events are persisted (§4.13).

### 4.12 On-prem and generic components

| Component | Source (all read from PulsusDB unless noted) | Catalogue result |
|---|---|---|
| Hypervisors (INF-027) | Hypervisor receiver: `vcenter.datacenter.name`, `vcenter.cluster.name`, `vcenter.host.name`, `vcenter.vm.name`, `vcenter.datastore.name`; vCenter or OpenStack connector | Site (datacenter) → hypervisor cluster (`class = None`, district) → `compute.hypervisor_host` → `compute.vm` (`Contains(Infra)`, plus `RunsOn` VM → host). VM attrs `vcpu`, usage. Datastores are `storage.array` or `storage.file` with `Attaches(Mounts)` to hosts. Bindings: CPU ready, ballooning, datastore latency |
| Network devices (INF-028) | SNMP receiver or streaming telemetry; `onprem` pack maps `sysObjectID` prefixes and `sysDescr` patterns to `network.switch` / `router` / `firewall` / `load_balancer` | One entity per device, placed in its rack (`Physical` tree) from schema attributes or CMDB import; interface metrics as entity children (`port` attrs) |
| Discovered links (INF-028) | LLDP-MIB remote table or CDP cache table, scraped as metrics with remote system and port labels | `DependsOn(Link(Neighbour))` between devices, with per-port utilisation and error metrics bound on both ends; links whose remote end is unknown go on the unmapped list |
| Storage arrays (INF-029) | SNMP or array exporter metrics with volume labels | `storage.array` with volumes as attributes; `Attaches(Mounts)` to hosts, VMs and PVs matched by WWN / IQN / LUN id / CSI volume handle |
| Facilities (INF-030, M-UI6) | SNMP (UPS-MIB, PDU and sensor MIBs) | `facility.pdu`, `facility.ups`, `facility.cooling` in their rack or row; per-row inlet temperature aggregate for the thermal haze |
| Telemetry pipeline (EST-003) | Collector self-metrics; PulsusDB `/metrics` | Collector and PulsusDB entities with health, so "the monitoring is the problem" is visible |

### 4.13 Change feed

```rust
pub struct ChangeEvent {
    id: Ulid, at: UnixNanos, end: Option<UnixNanos>, entities: SmallVec<[EntityId; 2]>,
    kind: ChangeKind,   // Deploy | Config | FeatureFlag | Rollout | Scale | NodeChange | Failover | K8sEvent
                        // | NewPattern | NewErrorType | NewDependency | NewAttrValue | FlowDeniedNew | Action
    summary: String, before: Option<String>, after: Option<String>, actor: Option<String>, link: Option<Url>,
    source: ChangeSource,   // Derived(R8|Fallback|ClusterState|Flow|Pattern|Graph) | Webhook(id) | Telemetry
    confidence: f32,
}
```

| Source | Mechanism | Stored |
|---|---|---|
| Version transitions (R8) | One call per refresh for `(entity, version, first_seen, last_seen)` over the last 10 min | Postgres (derived) |
| Version transitions (fallback) | Per 1-min step: TraceQL metrics `{} \| count_over_time() by(resource.service.name, resource.service.version)` partitioned by namespace, LogQL `sum by (service_name, service_version) (count_over_time({service_version!=""}[1m]))`, and `target_info` for services with neither. A transition is a version series starting while another for the same service is live (rolling) or ends (recreate) | Postgres (derived) |
| Rollouts, scaling, node add/remove | Cluster-state deltas per refresh (§4.8): revision change, `Progressing` reason, replica changes, node set changes (INF-016, INF-018) | Postgres (derived) |
| Kubernetes events (INF-022) | Events ingested as logs (collector events or object receivers). Read per refresh: `{k8s_cluster_name=~"<batch>", k8s_event_reason=~".+"}`; attached by `k8s.object.kind/name/uid` to the involved entity. Warning events → badges; FailedScheduling, scaling, rollout, eviction and node-condition reasons → Change Feed | **Not copied**: read from PulsusDB at query time ([T11](T11-postgres-schema.md) §4.13.4) |
| CI/CD and config webhooks | `POST /hooks/changes/{source_id}`, verified per T18-029; recipes per source (Git provider deployments, CD controllers, generic JSON with field mapping) | Postgres (`webhook`) |
| Feature flags | Provider webhooks and OpenFeature hooks where the customer emits them, mapped flag → service | Postgres (`webhook`) |
| New log patterns / error types (AI-038) | R9 when available; fallback two `patterns` calls (last 10 min vs the same 10 min −1 d) per service on the slow cadence; NEW when ≥ 20 lines and absent in the baseline | Postgres (derived) |
| New dependencies, gone entities, new attribute values | Graph diffs (§4.9) | Postgres (derived) |
| New denied flows | A denied pair with an accepted flow in the previous 7 days (§4.11) | Postgres (derived) |
| Executed actions | [T18](T18-security.md) §4.7 | Postgres (`action`) |

Derived and webhook events are written to `entity_change_events` ([T11](T11-postgres-schema.md)
§4.13.4) with a `dedup_key`, so re-derivation is idempotent. They are queryable through the
`{source="pulsus-dash"}` virtual source ([T07](T07-scene-query-planner.md)), pushed on the `changes`
WS channel, and published on the bus to T15 (draft) and [T16](T16-alert-evaluator.md). Telemetry
events (Kubernetes events, the PulsusDB change feed once R8 ships) are merged at read time.

**Ranking for an onset** (Lens rails, T15 stage 1):
`rank(x) = w_kind × exp(−Δt⁺/τ) × 0.5^hops(x, e)`, where `Δt⁺ = max(0, onset − x.at)`, events more than
30 s after the onset are excluded, `τ` = 15 min, `hops` is the shortest distance in dependency ∪ runs-on
∪ attaches, and `w_kind` defaults to Deploy 1.0, Config 1.0, Flag 0.9, Rollout 0.8, FlowDeniedNew 0.7,
NewPattern 0.6, Scale 0.5, NewDependency 0.5, K8sEvent 0.4. T15 (draft) refits `w_kind` on the replay
corpus.

#### T12-016 — Change events never go to PulsusDB
**MUST** — Change events derived or received by Dash MUST be stored only in `entity_change_events`
(T11-007). Telemetry-borne events MUST be read in place and MUST NOT be copied into Postgres.

### 4.14 Health, care and the anomaly sweep

| Input | From |
|---|---|
| RED per service / route, USE per host / node / pod, class headline metrics (Table 16-5) | R4 rollups, else the Dash fallback pyramid tiles in Postgres ([T07](T07-scene-query-planner.md) §4.12, T13 (draft)); pack bindings for classes |
| Kubernetes state | Pod status, ready endpoints, rollout phase, envelope (§4.8) |
| SLO burn rate (fast and slow windows) | [T16](T16-alert-evaluator.md) SLO evaluation |
| Alert severity; anomaly score and band | T16 instance state; the sweep (below) |
| Freshness, impact, confidence | `last_seen` vs interval; traffic share, tier, Journeys; coverage and `truncated` (R10) |

**State rule** (thresholds configurable per tenant): Unknown if freshness > 2× interval; else Failing
if burn > 10×, a critical alert, or a class hard-fail (0 ready endpoints, CrashLoopBackOff, tunnel down
on every tunnel); else Degraded if burn > 2×, a warning alert, or a class soft-fail (rollout Stalled,
some tunnels down, link errors over threshold); else Watch if anomaly score ≥ 4 for 3 consecutive
minutes or a scaling-limit envelope; else OK. The firing rule produces the "why"
("p99 2.8 s vs 0.4 s baseline since 12:22", "etcd fsync p99"). Containers take the **worst** child
state; counts are kept per state.

**Care** = `impact × deviation × confidence × recency`, each normalised to [0, 1]: deviation =
`min(1, max(burn/10, score/8))`, recency = `exp(−age_of_onset/30 min)`, boosted 1.5× while the trend
is still worsening.

**Anomaly sweep** (T06 singleton job, every 30 s, no LLM): ≈ 70k series at very large scale.

1. Baseline per entity × signal: weekly profile of robust medians at 5-minute slots plus a MAD scale per
   hour-of-week, refit hourly from rollups, persisted in `anomaly_baselines`
   ([T11](T11-postgres-schema.md) §4.13.3; T13 (draft) owns the profile encoding).
2. Residual `z = (x − median_slot) / max(1.4826·MAD, floor)`; the score is the EWMA of `|z|` (α = 0.3),
   persisted at 5-minute resolution in `anomaly_scores(_open)` and read by charts and T16 rules
   through the `pulsus_anomaly_score` virtual source (ADR-0012).

#### T12-017 — Health and anomaly state stay in Postgres
**MUST** — Baselines and scores MUST be written only to the T11 §4.13.3 tables, with the sweep lease's
fencing token. No code path may remote-write them, or any derived series, to PulsusDB (T11-007).

### 4.15 RBAC filtering

T10 (draft) compiles a principal's data scope into a predicate over entity attributes
(`CompiledScope::matches(&Entity) -> bool`). Reads go through
`ScopedView { graph, scope: Arc<CompiledScope>, policy: HiddenPolicy }`:

- **Omit**: hidden entities and their edges are removed and totals recomputed.
- **Anonymous**: hidden entities collapse into one `Restricted { parent, count, worst_state? }` node per
  visible container ("+38 entities you can't view"); worst state only if org policy allows.
- Edges to a hidden entity become "another workload (restricted)"; fleet and coverage counts use the
  scoped view; entities whose metric scope cannot be evaluated are out of scope
  ([ADR-0013](../adr/0013-metrics-data-scopes.md), fail closed).

Visibility bitsets are cached per `(tenant, scope_hash, seq)` (≈ 30 ms over 1.3M entities).

#### T12-018 — No hidden identifier in any response
**MUST** — No API, WS frame, export or bus message consumed by a principal MAY contain the id, name,
native type or attribute of an entity outside that principal's scope. Unscoped access is reserved for
the leader's harvest and the background jobs of T06-002.

### 4.16 Coverage model

Per entity: `signals` (4-part glyph), `blind` (a signal expected for its class is missing),
`inventory_only`, `unknown_type`. Per tenant: the unmapped list (§4.7) and partial harvest steps
(T12-011). The leader maintains the **provider × class-family matrix** (INF-033) incrementally:
`HashMap<(provider, ClassFamily), CoverageCell { telemetry, inventory_only, unknown_types,
unmapped_series }>`.

`GET /api/dash/v1/coverage/matrix` returns it (scoped); `GET …/coverage/cells/{provider}/{family}/{bucket}`
returns the entity ids to highlight. The estate strip's "unknown types" and "blind" totals are the
matrix sums. The same model feeds the per-viewport coverage meter (VIZ-027).

#### T12-019 — Coverage counts equal the graph
**MUST** — Every coverage count MUST equal a count over the scoped graph at the same `seq`; the matrix
MUST NOT be computed from a separate source.

## 5. Interfaces

### 5.1 HTTP (JSON for config, Arrow for bulk; under [T06](T06-bff-architecture.md) §5.1)

| Endpoint | Purpose |
|---|---|
| `GET /api/dash/v1/entities?scope=&kind=&class=&family=&provider=&q=&as_of=&limit=` | Search / list (Explorer, ⌘K). Arrow by default, JSON with `Accept: application/json` |
| `GET /api/dash/v1/entities/{ref}` | One entity: parents per tree, neighbours by relationship, signals, class, provider term, health "why"; `fleet:{key}` returns a fleet |
| `GET /api/dash/v1/entities/{ref}/neighbourhood?depth=&rel=`, `GET /api/dash/v1/graph?scope=` | Subgraph for Lens and T15 scope; scoped snapshot (Arrow) |
| `GET /api/dash/v1/changes?entity=&from=&to=&onset=` | Change feed, ranked when `onset` is given |
| `POST /hooks/changes/{source_id}` | Webhook ingest (T18-029) |
| `GET/PUT /api/dash/v1/admin/entity-schema`, `POST …/preview` | Versioned schema (JSON / YAML), dry run (T12-003) |
| `GET/PUT /api/dash/v1/admin/class-mappings` | Org class overrides; `GET …/packs` lists embedded pack versions |
| `GET/PUT /api/dash/v1/admin/connectors/{id}`, `POST …/verify`; `GET/PUT /entities/{ref}/override` | Connector config and read-only check; name, owner, tier, runbook overrides |
| `GET /api/dash/v1/coverage/{matrix,unmapped}`, `POST /api/dash/v1/network/reach` | §4.16, §4.7; reachability (M-UI6) |

**WS channels** (framing per [T04](T04-wire-format-and-data-plane.md)): `catalogue.subscribe {scope, kinds?, classes?, depth, since:(epoch,seq)?}` → `catalogue.snapshot` then
`catalogue.diff*` (Arrow); `health.subscribe {scope}` → per-entity state, score and why;
`changes.subscribe {scope}` → `ChangeEvent`s.

### 5.2 In-process API (T07, T15, T16, T17)

```rust
pub trait Catalogue: Send + Sync {
    fn view(&self, cx: &RequestCtx) -> ScopedView<'_>;
    fn resolve(&self, cx: &RequestCtx, r: &EntityRef) -> Option<EntityId>;
    fn neighbourhood(&self, cx: &RequestCtx, id: EntityId, depth: u8, rels: RelMask) -> SubGraph;
    fn crossing_counts(&self, cx: &RequestCtx, id: EntityId) -> CrossingCounts;   // EST-013
    fn as_of(&self, cx: &RequestCtx, t: UnixSec) -> HistoricView;
    fn selector_for(&self, id: EntityId, signal: Signal) -> String;               // T12-004
}
pub trait ChangeFeed: Send + Sync { fn query(&self, cx: &RequestCtx, q: ChangeQuery) -> Vec<RankedChange>; }
pub trait Health: Send + Sync { fn state(&self, cx: &RequestCtx, id: EntityId) -> HealthState; }
```

These refine the `Catalogue`, `ChangeFeed` and `Baselines` traits of [T06](T06-bff-architecture.md)
§4.1 and take `&RequestCtx` (T06-002).

### 5.3 Arrow: additions to `entities/1` and `entity_edges/1`

Additive minor columns (T04-002), nullable, in [T04](T04-wire-format-and-data-plane.md) §4.3:

| Schema | Column | Type | Meaning |
|---|---|---|---|
| `entities/1` | `class` | `Dictionary(UInt8, Utf8)` nullable | `data.relational`…; null for hierarchy levels and app entities |
| `entities/1` | **`shape_family`** | `UInt8` nullable | `ShapeFamily` code (§4.3); T02 groups instances by it, one draw per value per viewport |
| `entities/1` | `shape_form` | `UInt8` nullable | `ShapeForm` code: instance parameter inside the family |
| `entities/1` | `provider` | `Dictionary(UInt8, Utf8)` nullable | Grouping and text badge only (T12-005) |
| `entities/1` | `flags` | `UInt8` | bit 0 managed, 1 inventory-only, 2 unknown type, 3 restricted aggregate, 4 gone, 5 pending (unscheduled) |
| `entity_edges/1` | `rel` | `UInt8` (values added) | add `owns` and `attaches` to calls / runs_on / contains |
| `entity_edges/1` | `conn` | `UInt8` (values added) | add `db`, `external`, `fronts`, `link_neighbour`, `link_peering`, `link_vpn`, `link_interconnect`, `link_transit`, `flow`, `mounts`, `autoscales`, `guards`, and tree codes `workload`, `network`, `physical` for `contains` |

`entity_id` stays `UInt64` (T12-010). Class-specific facts (revision, ready endpoints, envelope,
segments, native type, provider term) go in `entity_attrs/1`.

**PulsusDB endpoints used:** R3 (preferred) / logs `series`, metrics `series` on `target_info` and cluster-state series, trace
`tag/{tag}/values`, `service_graph`, profiles `Series` (fallback); PromQL instant queries (cluster
state, headline bindings); R8 / TraceQL metrics and LogQL `query_range` (fallback); R9 / `patterns` ×2
(fallback); LogQL metric queries over flow logs and Kubernetes events; R4 rollups. **No writes.**

### 5.4 Cross-doc interfaces

| Counterpart | Interface | Direction / change needed |
|---|---|---|
| [T06](T06-bff-architecture.md) | Crates `dash-catalogue`, `dash-changefeed`, `dash-health`; leases `catalogue.refresh/{tenant}`, `changefeed/{tenant}`, `anomaly.sweep/{tenant}`; `/internal/v1/catalogue/diffs`; `NOTIFY catalogue_<tenant>` | Assumed from T06 §4.6, §5.4 |
| [T07](T07-scene-query-planner.md) | Harvest and sweep under `Budget::background(tenant)`; catalogue snapshot and label ⇄ attribute map; `{source="pulsus-dash"}` reads `entity_change_events` | Assumed |
| [T04](T04-wire-format-and-data-plane.md) | **Change needed:** §5.3 columns on `entities/1` (`class`, `shape_family`, `shape_form`, `provider`, `flags`) and new `rel` / `conn` codes on `entity_edges/1`; `entity_id` derivation per T12-010 | T04 owns the schema text |
| [T02](T02-vis-engine.md) | One instanced draw per `shape_family` per viewport; `shape_form` as instance parameter; greyscale-distinct silhouettes | T02 owns meshes and `golden:inf-shape-grammar-greyscale` |
| [T11](T11-postgres-schema.md) | **Change needed:** (1) new table `class_mappings` (below); (2) `entities` gains `class text`, `provider text`, `native_type text`, `managed bool`; (3) `entity_change_events.kind` adds `deploy`, `rollout`, `node_change`, `k8s_scale`, `dependency_new`, `attr_value_new`, `flow_denied_new`, and `source` adds `webhook`; (4) `connectors` and `change_sources` config tables with `secret_ref` | T11 holds the DDL; T12 owns these tables (T11 §5.2) |
| T10 (draft) | `CompiledScope::matches(&Entity)`, `HiddenPolicy` per org | T10 owns scope compilation |
| T13 (draft) | Entity ids as pyramid keys; anomaly profile encoding | |
| T15 (draft) | `Catalogue`, `ChangeFeed`, `Health`; onset ranking; control plane as candidate origin (INF-021) | T15 refits weights |
| [T16](T16-alert-evaluator.md) | `view` + `selector_for`; ownership; freshness; workload → pods; `catalogue.diff` bus topic | |
| [T18](T18-security.md) | Connector credentials, webhook secrets (T18-029), egress (T18-021) | |
| [T05](T05-testing-and-performance.md) | New gates (§10); mixed-estate fixture in `pulsus-synth` | T05 owns the catalogue |

Proposed `class_mappings` DDL for T11 (under the §4.1 RLS template):

```sql
CREATE TABLE class_mappings (
  org_id uuid NOT NULL, provider text NOT NULL, native_type text NOT NULL,
  class text NOT NULL,                       -- Table 16-1 identifier, validated by the BFF
  updated_by uuid NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, provider, native_type));
```

## 6. Data & storage

| Data | Where | Notes |
|---|---|---|
| Live graph | Memory on the leader and every api follower | ≈ 1.3M nodes × ~200 B + 2.2M edges × ~48 B ≈ 370 MB very large; ≈ 25 MB medium |
| Diff ring; mapping packs | Memory (30 min); binary (embedded YAML) | Pack versions listed in Admin |
| Entity / edge registry | Postgres `entities`, `entity_edges` (T11 §4.4) | Daily partitions, 30 days; births within 60 s by `COPY`; `last_seen_day` advance in 5-min batches |
| Graph snapshot | Postgres `catalogue_snapshots` (zstd), every 10 min, last 3 kept | Fast follower start; holds precise `last_seen`, aliases, unmapped list |
| Schema, overrides, class mappings, label mappings, connectors, change sources | Postgres, versioned where T11 says so | |
| Change events | Postgres `entity_change_events`, `change_events` retention domain (default 90 days) | Telemetry-borne events stay in PulsusDB |
| Baselines, anomaly scores | Postgres `anomaly_baselines`, `anomaly_scores(_open)` | 30 days default |
| Flow aggregates, coverage matrix, fleet index | Memory (rebuilt each cycle) | Not persisted |

## 7. Performance budget

| Path | Budget | Measured by |
|---|---|---|
| Harvest + resolve + diff + publish (very large estate) | ≤ 45 s wall per 60 s cycle; diff ≤ 2 s; class resolution ≤ 1 s | per-phase spans (self-telemetry, [T19](T19-deployment.md)); `bench:catalogue-cycle-1m` |
| Same on the mixed-estate fixture (INF-032) | ≤ 30 s wall; resolver ≤ 300 ms | `bench:catalogue-mixed-estate-cycle` |
| Override → redrawn (INF-003) | ≤ 60 s | `itest:inf-class-resolution` |
| Diff → client paint; resolve from snapshot | ≤ 1 s; ≤ 5 ms ([T06](T06-bff-architecture.md) §7) | spans |
| L0 aggregates payload | ≤ 200 KB (Table 15-6) | `itest:fetch-plan-levels` |
| L2 cluster (100k cells) | ≈ 1.6 MB, first paint < 800 ms | Atlas benchmark |
| Distinct shape draws per viewport | ≤ 20 (`ShapeFamily` values) + labels | `bench:inf-mixed-estate` |
| Anomaly sweep (70k series) | ≤ 5 s per 30 s tick | span |
| Change ranking for one onset | ≤ 20 ms | `bench:change-rank` |

## 8. Security, tenancy & RBAC

- Each tenant binding has its own graph, leader, interner and PulsusDB headers; harvesting runs as
  the tenant's service principal, and every **read** goes through `ScopedView` (T12-018).
- Connectors: read-only (T12-020); credentials only as `secret_ref` ([T18](T18-security.md) T18-020),
  never logged; all calls through `dash-egress` (T18-021) with per-connector allowlisted hosts.
- Webhooks: T18-029 (signature, 5-minute replay window, 256 KB cap) plus a per-source rate limit.
- Attributes marked PII in the schema (`enduser.id`, `tenant.id`) are never identifying keys by
  default and are excluded from diffs without the customer-lookup permission ([11](../product/11-enterprise.md)).
- Telemetry is untrusted (T18-023): templates treat label values as data; values are capped at 256 B.

## 9. Failure modes & degradation

| Failure | What the user sees |
|---|---|
| PulsusDB slow or a harvest call fails | Last good state kept; affected clusters age; strip shows "inventory 3 min stale"; coverage names the failed partition |
| `service_graph` truncated or A1 false | Coverage "edges: 1 000 of more (truncated)"; TraceQL fallback fills rpc edges |
| Only one cluster-state source, or neither | Facts it lacks show as cluster coverage notes (T12-013); pods still derive from `k8s.*` attributes |
| Missing signal; unknown type or provider | Coverage gap, health from the rest; generic box, counted, island from `cloud.provider` |
| Leader lost; schema re-identifies | Followers serve last state, new epoch ≤ 15 s + one cycle; preview count and 30-day aliases |
| Connector auth failure or write-capable credentials | Admin badge with reason; connector stopped; its entities stale, never deleted (T12-021) |
| Flow-log volume over budget | Top 5 000 pairs kept; coverage "flows sampled" |
| Postgres unavailable | Graph keeps serving from memory; change events and scores buffered ≤ 10 min, then dropped with a coverage note; registry catches up from the next snapshot |

## 10. Testing

- **Golden estates** (seeded PulsusDB databases, one `X-Pulsus-Database` per fixture): OTel demo, a
  2 000-service synthetic estate, an on-prem rack estate and the INF-032 **mixed-estate fixture**
  (`pulsus-synth` preset `mixed-estate`,
  [T05](T05-testing-and-performance.md#45-seeded-synthetic-telemetry-and-the-incident-replay-corpus)).
  Each asserts the derived graph, with class and shape per entity, equals a committed graph.
- **Kubernetes matrix:** every Table 12-3 row runs with the exporter only, the receiver only, and both.
- **Property, scale, change-feed and sweep tests** as below; every itest runs behind the recording
  proxy of `itest:no-pulsusdb-writes`.

**New T05 gates** (to add to [T05](T05-testing-and-performance.md#71-gate-catalogue) §7.1):

| Gate | Proves |
|---|---|
| `golden:catalogue-graph-estates` | Derived entities, classes, shapes and relationships equal the committed graph per golden estate (IA-010, EST-001, EST-003) |
| `itest:entity-schema-custom` | A custom non-Kubernetes schema drives catalogue and breadcrumb; new tenants get the default (IA-011) |
| `itest:signal-row-entity-map` | An entity's logs, spans and profiles are found with zero configuration (IA-012) |
| `itest:runs-on-cooccurrence` | Runs-on with first/last seen; crossing-chip counts; self-hosted software on its host (EST-002, EST-013, INF-031) |
| `itest:connector-contract` | Inventory-only entities; read-only verification refuses write-capable credentials; no mutating call; failure marks stale (EST-004, INF-010) |
| `itest:coverage-model` | Signal mask and blind marker; unmapped rows and cloud series; provider × family matrix equals graph counts (EST-041, INF-009, INF-033) |
| `unit:mapping-pack-lint` | T12-009 over every embedded pack |
| `unit:inf-class-shape-table` | `Class::shape()` equals 16 Table 16-3; ≤ 24 families; shape independent of provider (INF-002, INF-004) |
| `itest:inf-class-resolution` | One class per entity; class and family filters; unknown type → override → redrawn within one refresh; provider without a pack (INF-001, INF-003, INF-006) |
| `itest:inf-cloud-placement` | aws / azure / gcp: hierarchy and terms, metric joins, headline metrics, managed services with segments, service locations (INF-005, INF-007, INF-008, INF-011) |
| `itest:inf-k8s-object-model` | Table 12-3 from each source and both; pod status; ready endpoints; PVC chain; fleets (INF-013, INF-015, INF-017, INF-019, INF-020, INF-023) |
| `itest:inf-k8s-distributions` | Five distributions modelled alike; distribution, version, control-plane health, "managed by provider" (INF-014, INF-021) |
| `itest:inf-k8s-changes` | Rollout bands and phases, envelope and scaling limit, node events, Kubernetes events read in place (INF-016, INF-018, INF-022) |
| `itest:inf-network-model` | Network tree, boundaries, gateways, links, flow aggregates, denied-flow events, reachability (INF-012, INF-024–INF-026) |
| `itest:inf-onprem-model` | Hypervisors and VMs, SNMP devices and LLDP/CDP links, arrays and mounts, facilities (INF-027–INF-030) |
| `prop:catalogue-diff` | `diff(apply(g, d))` is identity; ids stable under attribute order and re-harvest |
| `prop:scoped-view-no-leak` | No response for a fuzzed scope contains a hidden id, name or attribute (T12-018) |
| `itest:anomaly-sweep-quality` | Precision / recall on labelled seasonal series with injected shifts; scores only in Postgres |
| `bench:catalogue-cycle-1m` | 1M-container cycle within §7 |
| `bench:catalogue-mixed-estate-cycle` | Mixed-estate cycle within §7 (INF-032) |
| `bench:change-rank` | Onset ranking ≤ 20 ms |

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI2 | Default schema, fallback harvest, graph and diffs, registry with 30-day ephemeral retention, entity APIs, Lens resolution |
| M-UI3 | WS diffs L0–L2; classes and shape columns; packs `core`, `kubernetes`, `aws`, `azure`, `gcp`; org overrides; cloud metric joins and unmapped list; Kubernetes model (both sources), rollouts, fleets; change feed (R8 fallback, webhooks, cluster state, events, patterns); health, care, anomaly sweep in Postgres; RBAC views; `as_of`; coverage matrix |
| M-UI5 | Connectors (AWS Config, Azure Resource Graph, Cloud Asset Inventory, Oracle, Alibaba, OpenStack, vSphere, CMDB, service catalogue) behind per-connector flags; network inventory, flows; packs `oracle_cloud`, `alibaba_cloud`, `openstack`, `vsphere`, `onprem` (devices, arrays); PVC chain to backing volumes |
| M-UI6 | Packs `ibm_cloud`, `tencent_cloud`; reachability; facilities; anonymous restricted nodes (EST-051, EST-052) |

R3, R8 and R9 replace fallbacks behind capability probes at start-up (`/buildinfo` plus a probe call).
Packs ship with the binary; a pack update is a patch release.

## 12. Alternatives considered

| Alternative | Why not |
|---|---|
| A graph database | A second stateful store breaks [ADR-0006](../adr/0006-pulsusdb-and-postgres.md); queries are neighbourhood walks over ≤ 2.2M edges, which petgraph does in microseconds |
| Writing baselines, scores or change events to PulsusDB | Rejected ([ADR-0010](../adr/0010-dash-writes-derived-series.md), superseded by ADR-0012) |
| Push all entities to every client | 1M entities ≈ 100+ MB; scoped subscriptions keep L0 at 200 KB |
| Label-values fan-out only (R3's stated fallback) | No combinations, so no runs-on |
| Class mapping in code per provider | Every new native type would need a release; INF-003 needs runtime overrides; packs keep providers out of code |
| One `ShapeFamily` per class family exactly (12) | Table 16-3 gives several silhouettes inside `network` and `container`; a closed set of ≈ 20 geometric families with forms keeps both silhouette and draw bounds |
| Copying Kubernetes events and flow logs into Postgres | Duplicates customer telemetry; read in place, persist only derived events |

## 13. Open questions

| # | Question | Leaning |
|---|---|---|
| Q1 | Ask PulsusDB for a `q` filter on `service_graph` in addition to A1's higher cap | Yes: add to R5 |
| Q2 | Use OTLP `EntityRef` on resources as an identity source once queryable in bulk | Yes, opportunistically |
| Q3 | Liveness window per kind or adaptive to scrape interval | Per kind, default 5 min |
| Q4 | Anonymous restricted nodes: show worst state or not | Org policy, default hidden |
| Q5 | Feature-flag providers with first-class recipes in v1 | Generic webhook + OpenFeature + one provider chosen with design partners |
| Q6 | Should hierarchy levels and services have a class (16 says "every entity")? | No: `class = None`, landscape grammar; confirm with the 16 owner |
| Q7 | EndpointSlice → Service label and Kubernetes network-policy selectors are not exported by default | Document the exporter allowlist; fall back to name prefix / namespace scope |
| Q8 | Cloud metric dimension names differ by exporter configuration | Packs carry alternative templates per metric family; lint against fixtures |

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from draft; extended for [16 Infrastructure model](../product/16-infrastructure-model.md): class taxonomy, mapping packs and org overrides, cloud hierarchy and metric joins, Kubernetes model from both cluster-state sources, read-only connectors with network inventory and flows, on-prem devices, shape columns for T02. Aligned with ADR-0012 (no PulsusDB writes), T06 leases and T11 DDL |
