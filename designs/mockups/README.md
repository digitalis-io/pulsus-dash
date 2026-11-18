# Mockups

Mockups are hand-authored SVG files. They are **illustrative**: requirements in `product/` win
over a mockup, and a mismatch is a defect in the mockup.

## Conventions

- **Canvas:** `viewBox="0 0 1440 900"` (desktop) · `0 0 390 844` (phone) · `0 0 3840 2160` (wall).
  Always set `width`/`height` equal to the viewBox.
- **Theme:** dark by default, with tokens from [08 Visual language](../product/08-visual-language.md):

  | Token | Value | Token | Value |
  |---|---|---|---|
  | canvas | `#0B0D10` | surface-1 | `#12151A` |
  | surface-2 | `#191D24` | hairline | `#FFFFFF` at 8% (`#FFFFFF14`) |
  | text | `#E6E8EB` | text-muted | `#8A919C` |
  | ok | `#2FB59A` | watch | `#D9C84A` |
  | degraded | `#E8923A` | failing | `#E0457B` |
  | unknown | `#6B7280` + hatch | accent / focus | `#5B9BFF` |
  | series-1…8 | `#7AA2D6 #C9A36B #8FBF8F #B48FC9 #6FB8B8 #C98F8F #A8A8D9 #BFB07A` | | |

- **Type:** `font-family="Inter, system-ui, sans-serif"` for the UI and
  `"JetBrains Mono, ui-monospace, monospace"` for data and code. Sizes are 11/12/13/16/20 px,
  with tabular numerals for numbers.
- **Layout:** 32 px top bar, 40 px Time Ribbon, 4 px grid, 8 px gutters, 6 px radius, 1 px
  hairlines.
- **State is always encoded twice:** colour plus a glyph or ring: OK ●, Watch ◐, Degraded ◉, Failing ■, Unknown ○ (hatched), with solid or dashed rings. Unknown
  is hatched.
- **Realistic content:** use the storyboard incident from [13](../product/13-core-flow-storyboard.md):
  - checkout degraded since 12:22, origin `psp-api`;
  - ⚙ timeout config change at 12:19;
  - INC-2041 with investigation INV-2041;
  - ~€38k/h at risk.
- **Self-contained:** no external images or fonts, no scripts. `<title>` and `<desc>` are
  required (accessibility). Group logical regions with `<g id="…">`.
- **Annotations:** design callouts sit outside the UI area or in a `<g id="callouts">` layer,
  drawn in accent dashed lines and numbered (①②③). They are referenced from the product doc
  that owns the screen.
- **File names:** `NN-short-name.svg`, numbered in storyboard/reading order.

## Rendering check

```sh
google-chrome --headless=new --disable-gpu --no-sandbox --window-size=1440,900 \
  --screenshot=out.png file://$PWD/mockups/01-atlas-topology.svg
```

## Index

| File | Screen | Owning requirements |
|---|---|---|
| [01-landscape-map.svg](01-landscape-map.svg) | **3D globe** (Map view, ⌥1): real Earth (continents, shaded relief, ocean, atmosphere, night side with city lights), regions as hex districts (height = load), eu-west-1 Failing with ⊕ beacon, great-circle arcs, unplaced/outside-estate sites, docked 2D error-rate strip | [15](../product/15-estate-navigation.md), [07](../product/07-alerting.md) |
| [01-landscape-map-2d.svg](01-landscape-map-2d.svg) | (2D `T` variant) Atlas Map view (L0): regions and DCs on a dot-matrix world map; eu-west-1/prod-eu-1 Failing for INC-2041; layer, view and L0–L5 ladder; care queue | [15](../product/15-estate-navigation.md), [07](../product/07-alerting.md) |
| [02-atlas-topology-2d.svg](02-atlas-topology-2d.svg) | (2D `T` variant of 22) Topology view: 43-node service graph with team territories; ⊕ psp-api, dashed victims, causal path, ⚙ 12:19; First Light lanes; Inspector | [15](../product/15-estate-navigation.md), [06](../product/06-ai-copilot.md) |
| [03-infra-cluster.svg](03-infra-cluster.svg) | **3D Infra view** (⌥4, capacity): node pools as glass nodes on plinths (allocatable / requested / used), batch-etl bulging, psp-api node Failing, docked node memory and pool headroom | [15](../product/15-estate-navigation.md) |
| [03-infra-cluster-2d.svg](03-infra-cluster-2d.svg) | (2D `T` variant) Infra view: prod-eu-1 node grid, pods packed by request, Capacity tint, MemoryPressure node opened at L3; floors indicator | [15](../product/15-estate-navigation.md) |
| [04-segments-matrix.svg](04-segments-matrix.svg) | **3D Segments** (⌥5): region × tier columns (height = error rate), eu-west-1 × Tier 0 glowing with ⊕, SLO plane, docked row bars and Inspector | [15](../product/15-estate-navigation.md), [07](../product/07-alerting.md) |
| [04-segments-matrix-2d.svg](04-segments-matrix-2d.svg) | (2D `T` variant) Segments view: region × service tier, care-sorted, origin/victim cells, Unknown hatched; segment Inspector | [15](../product/15-estate-navigation.md), [07](../product/07-alerting.md) |
| [05-service-lens.svg](05-service-lens.svg) | checkout Lens, **hybrid**: 3D dependency neighbourhood on tier planes with the lit causal path, linked to the 2D golden-signals strip by one time cursor | [04](../product/04-surfaces.md), [05](../product/05-visualisation-catalogue.md) |
| [05-service-lens-2d.svg](05-service-lens-2d.svg) | (2D `T` variant) checkout Lens: 4-lane stacked-axis golden-signals strip with −7d ghost and ⚙/◆ markers; dependency mini-map; log/trace pivots | [04](../product/04-surfaces.md), [05](../product/05-visualisation-catalogue.md) |
| [06-metrics-workbench.svg](06-metrics-workbench.svg) | Metrics workbench: PromQL with inline error, rps/p99 dual Y, top "last Tue" X axis with drag and Align on onset, manual-range pin, all-axes crosshair, ⚡/☁/✓ badge | [04](../product/04-surfaces.md), [05](../product/05-visualisation-catalogue.md) |
| [07-logs-workbench.svg](07-logs-workbench.svg) | Logs: LogQL editor, level-stacked volume with brush, patterns "NEW since 12:19", detected fields, paused live stream with trace pivots | [04](../product/04-surfaces.md) |
| [08-traces-workbench.svg](08-traces-workbench.svg) | Traces: TraceQL editor, RED tiles vs −7d, span scatter (density + outliers, 2.000 s ceiling), waterfall with psp-api timeout | [04](../product/04-surfaces.md) |
| [09-alert-lens.svg](09-alert-lens.svg) | Alert Lens INC-2041, **hybrid**: 3D incident mini-world (floors, runs-on thread, ⊕), docked 2D impact strip, First Light, 14 merged alerts, RCA card whose evidence lights the 3D scene | [07](../product/07-alerting.md), [06](../product/06-ai-copilot.md) |
| [09-alert-lens-2d.svg](09-alert-lens-2d.svg) | (2D `T` variant) Alert Lens INC-2041: impact line, causal sentence, mini-Atlas ⊕ psp-api, First Light, 14 merged alerts, RCA card, ack/escalate/INV-2041 | [07](../product/07-alerting.md), [06](../product/06-ai-copilot.md) |
| [10-alerts-list-timeline.svg](10-alerts-list-timeline.svg) | Alerts List (Alt+6) over Timeline (Alt+7): grouped by incident, all states as colour + glyph/pattern, ◆/⚙ markers | [07](../product/07-alerting.md) |
| [11-rule-editor-backtest.svg](11-rule-editor-backtest.svg) | Rule editor: query, condition/for, labels, 7-day backtest (6 firings, 14 sends), flapping warning, routing + Slack preview | [07](../product/07-alerting.md) |
| [12-routing-simulator.svg](12-routing-simulator.svg) | Routing: policy tree, 7-day Sankey label sets → routes → endpoints, simulator with match reasons, per-endpoint delivery health | [07](../product/07-alerting.md) |
| [13-investigation.svg](13-investigation.svg) | Investigation INV-2041, **hybrid**: pinned 3D evidence scene with E1–E7 pins and a collaborator camera frustum; ledger, hypothesis tree (H1 ✔), timeline, AI dock | [04](../product/04-surfaces.md), [06](../product/06-ai-copilot.md) |
| [13-investigation-2d.svg](13-investigation-2d.svg) | (2D `T` variant) Investigation INV-2041: timeline, evidence ledger, hypothesis tree (H1 ✔), ✦ dock with cited answer, presence, REC | [04](../product/04-surfaces.md), [06](../product/06-ai-copilot.md) |
| [14-board.svg](14-board.svg) | Board "Payments — overview", **mixed**: 3D cluster city and latency surface viewports beside 2D tiles, series, SLO burn, table, state timeline; one shared cursor | [04](../product/04-surfaces.md), [05](../product/05-visualisation-catalogue.md) |
| [14-board-2d.svg](14-board-2d.svg) | (2D `T` variant) Board "Payments — overview": variables, stats, time series in hover-edit, SLO burn, heatmap, table, state timeline | [04](../product/04-surfaces.md), [05](../product/05-visualisation-catalogue.md) |
| [15-command-palette.svg](15-command-palette.svg) | ⌘K palette over a dimmed Lens: fuzzy results by entities/actions/queries/views/keys, preview, ✦ ask | [03](../product/03-interaction-model.md) |
| [16-gallery.svg](16-gallery.svg) | Showcase gallery on a **3D** entry: fleet line stack of 2 000 lanes with fps/frame/points readout, tier and camera switches, editable spec | [05](../product/05-visualisation-catalogue.md) |
| [16-gallery-2d.svg](16-gallery-2d.svg) | (2D `T` variant) Showcase gallery, Line 10⁸: nav, live chart, fps/frame/points readout, tier + theme switches, editable spec, "Use in a board" | [05](../product/05-visualisation-catalogue.md) |
| [17-mobile-alert-card.svg](17-mobile-alert-card.svg) | Phone PWA Alert Lens card (offline): as-of banner, impact, sparkline, ⊕ path, RCA, thumb-zone Ack/Escalate | [07](../product/07-alerting.md) |
| [18-noc-wall-2d.svg](18-noc-wall-2d.svg) | (2D variant of 24) 4K NOC wall: near-monochrome hexbin, one glowing failing block ⊕ psp-api, segment matrix, static-X charts, salience ticker | [01a](../product/01a-audiences-and-perspectives.md), [08](../product/08-visual-language.md) |
| [19-estate-3d-landscape.svg](19-estate-3d-landscape.svg) | **3D** Landscape (L0): regions as plateaus on continents, cluster districts (footprint = capacity, height = load), prod-eu-1 glowing with ⊕ psp-api beacon, victim rings, traffic arcs, care queue | [15](../product/15-estate-navigation.md), [07](../product/07-alerting.md) |
| [20-city-cluster-3d.svg](20-city-cluster-3d.svg) | **3D** City (L2→L3): prod-eu-1 as 40 node buildings in pool districts, pods as floor slabs, one node cut away to pods and containers, Capacity height legend, node Inspector | [15](../product/15-estate-navigation.md), [08](../product/08-visual-language.md) |
| [21-floors-3d.svg](21-floors-3d.svg) | **3D** `V` floors: glass application floor over the infrastructure city; causal path crosses down a runs-on thread to the node and pods; A/L ladders | [15](../product/15-estate-navigation.md), [06](../product/06-ai-copilot.md) |
| [22-topology-3d.svg](22-topology-3d.svg) | **3D** Topology: 45 services on tier planes, bundled arcs with particles, causal path as a lit tube, ⊕ beacon, victims in fog, First Light | [15](../product/15-estate-navigation.md), [05](../product/05-visualisation-catalogue.md) |
| [23-semantic-zoom-flight.svg](23-semantic-zoom-flight.svg) | Storyboard: one continuous camera flight, world → region → cluster → node → pod → container flame, with pre-fetch per step | [15](../product/15-estate-navigation.md), [03](../product/03-interaction-model.md) |
| [24-noc-wall-3d.svg](24-noc-wall-3d.svg) | **3D** 4K NOC wall: calm auto-orbiting estate world, one glowing district with ⊕ beacon, incident rail with salience ladder | [01a](../product/01a-audiences-and-perspectives.md), [08](../product/08-visual-language.md) |
| [25-fleet-line-stack-3d.svg](25-fleet-line-stack-3d.svg) | **3D signal view:** 120 node CPU lines as lanes in depth, hot psp-api lanes lit, time-cursor plane, linked 2D chart, top-preset heatmap | [05](../product/05-visualisation-catalogue.md) |
| [26-latency-surface-3d.svg](26-latency-surface-3d.svg) | **3D signal view:** latency histogram surface with contours, ridge moving to the 2 s bucket, linked 2D slices | [05](../product/05-visualisation-catalogue.md) |
| [27-span-point-cloud-3d.svg](27-span-point-cloud-3d.svg) | **3D signal view:** 10⁷ spans as a point cloud, 2.000 s timeout sheet, 3D box selection driving 2D divergence | [05](../product/05-visualisation-catalogue.md), [04](../product/04-surfaces.md) |
| [28-multicloud-estate-3d.svg](28-multicloud-estate-3d.svg) | **3D hybrid multi-cloud estate** (Map view, ⌥1): provider islands named by text badge only, accounts as fenced lots, one shape per class family, managed vs self-hosted, VPN / interconnect / peering bridges, unknown type drawn as a hatched box; docked provider × class health matrix | [16](../product/16-infrastructure-model.md), [15](../product/15-estate-navigation.md) |
| [29-k8s-workloads-3d.svg](29-k8s-workloads-3d.svg) | **3D Kubernetes Workload arrangement** (Infra ⌥4, group by workload): namespace districts, Deployment towers banded by revision during rollout, HPA ghosts, StatefulSet PVC anchors, DaemonSet ribbons, pending cloud, Service with 0 ready endpoints, control-plane hall, ghosted node floor; docked rollout chart and events | [16](../product/16-infrastructure-model.md) |
| [30-network-layer-3d.svg](30-network-layer-3d.svg) | **3D Network layer** on eu-west-1: virtual networks as glass enclosures, subnet tiles, security-boundary walls, gateways, peering / transit hub / VPN bridges, denied flow stopped at a wall; docked flows table and denied-flow chart | [16](../product/16-infrastructure-model.md) |
| [31-datacentre-hall-3d.svg](31-datacentre-hall-3d.svg) | **3D data-centre hall** (Infra ⌥4, physical layout): racks with U-slot hosts, hypervisor cut-away with VM slabs, ToR / spine discovered links, storage array LUN threads, self-hosted services, PDU load and thermal haze (Facilities layer) | [16](../product/16-infrastructure-model.md), [15](../product/15-estate-navigation.md) |
| [32-globe-dive-to-dc.svg](32-globe-dive-to-dc.svg) | **Dive from the globe into a data centre** (Map ⌥1): filmstrip Orbit 9 800 km → Continent 1 200 km → Metro 25 km → Site 0.8 km on real geography; lon-dc1 campus with halls as buildings (Hall B Watch, cut-away to racks), energy centre, fibre and power entry; altitude ladder; built-in relief imagery chip | [15](../product/15-estate-navigation.md) |
| [33-aws-region-3d.svg](33-aws-region-3d.svg) | **3D AWS region** (City ⌥3, eu-west-1, account prod-payments): CloudFront + WAF at the edge, VPC enclosure with 3 AZ terraces and subnet tiles, IGW / NAT gates, multi-AZ ALB arcs to healthy targets only, EKS district with node groups, control plane and workload towers, DynamoDB tables via the gateway endpoint with a global-table bridge, Aurora, SQS, S3; request path lit end to end; docked ALB panel with per-hop path | [16](../product/16-infrastructure-model.md) |

## Known mockup defects (to fix)

- **`-2d` files** are the earlier flat versions, kept as the `T` (flattened 2D) mode of the hybrid/3D defaults.

- **Failing glyph:** mockups draw Failing as a ringed ● or ◉. The normative glyph is ■
  ([08](../product/08-visual-language.md)).
- **Timeline:** some screens show the incident unmitigated at 13:02 ("since 12:22 (40m)"). In the
  storyboard the revert happens at 12:24:40. Read these as the "what if not reverted" state.
- **Impact figure:** 09 shows ~9% failing (the 12:30 state), and 17 shows 4.1% (the 12:23 state).
  Both are valid points on the storyboard timeline.
- **Fonts:** renders on machines without Inter or JetBrains Mono fall back to system fonts.
