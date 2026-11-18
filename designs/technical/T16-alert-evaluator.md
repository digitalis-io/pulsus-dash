# T16 — Alert evaluator & notification service

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Milestone** | M-UI4 (evaluator, routing, v1 endpoints, incidents, backtest, history) → M-UI5 (v2 endpoints, hygiene) → post-R15 (ruler migration) |
| **Related ADRs** | [ADR-0008](../adr/0008-dash-alert-evaluator.md), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md), [ADR-0003](../adr/0003-wgpu-rendering.md), [ADR-0005](../adr/0005-arrow-wire-format.md) |
| **Source draft** | plans/tech/T16-alert-evaluator.md (not tracked) |

## 1. Context & problem

PulsusDB evaluates recording rules today and stores alerting rules, but evaluates them only
post-1.0 (verified: PulsusDB API reference §6). [ADR-0008](../adr/0008-dash-alert-evaluator.md)
therefore puts an HA evaluator in Dash. [07](../product/07-alerting.md) asks for much more than
Prometheus/Alertmanager:

- seven rule kinds, including SLO burn rate, entity-relative templates, anomaly, journey and
  composite (Table 3.1);
- one lifecycle vocabulary (Table 3.2), with NoData and Error as first-class states and flapping
  detection;
- a live **backtest** while the threshold is dragged;
- **incident grouping** by topology, time and shared origin;
- one live alert set projected on **seven views** (Map, Topology, City, Infra, Segments, List,
  Timeline) and replayable from history;
- **alert history in Postgres** ([ADR-0012](../adr/0012-derived-state-in-postgres.md)), queryable
  as telemetry through `ALERTS`, `ALERTS_FOR_STATE` and the `{source="pulsus-dash"}` event stream;
- Alertmanager-compatible routing for import;
- a broad endpoint catalogue in two tiers (v1 at M-UI4, v2 at M-UI5) with interactive Slack/Teams;
- server-rendered chart images;
- a heartbeat (dead-man's switch) that traverses the whole pipeline.

The storyboard sets the latency: the alert fires at 12:22:50 and the page, carrying the stage-1 RCA
summary, is delivered by 12:23:05, within 15 s ([13](../product/13-core-flow-storyboard.md)
SCN-007).

## 2. Goals / non-goals

**Goals**
- Correct, HA evaluation with no duplicate and no lost notifications across restarts and
  failovers.
- One state-machine implementation shared by the live evaluator, the backtest (server) and the
  authoring UI (WASM).
- Alertmanager semantics for `group_by`/`group_wait`/`group_interval`/`repeat_interval`,
  matchers, `continue`, inhibition and time intervals, so Alertmanager configs and those of other existing alerting systems import.
- Incident-first paging: one page per incident.
- History as data: every transition and delivery attempt in Postgres, served as virtual series.
- No dependency on the PulsusDB ruler or on PulsusDB ingest (ALR-004, ALR-087).

**Non-goals**
- Recording-rule evaluation for customers (PulsusDB's ruler does it).
- On-call scheduling beyond a lightweight escalation chain ([07](../product/07-alerting.md) §8.1).
- The action framework behind automation endpoints ([T18](T18-security.md) §4.7).
- Rendering of the seven alert views (T02, T08, T14 (draft), T20 (draft)). This doc specifies the
  alert-set feed they render (§4.15).
- Planner semantics of virtual sources ([T07](T07-scene-query-planner.md)); this doc fixes their
  labels and contents (§4.7).

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [ALR-001](../product/07-alerting.md#alr-001--all-rule-kinds) | §4.1 seven kinds; SLO burn preselected when the entity has an SLO (§5.1 prefill) | `itest:alert-kinds-corpus` (each kind fires and notifies on the replay corpus) |
| [ALR-002](../product/07-alerting.md#alr-002--entity-relative-templates-cover-new-entities) | §4.1 entity-relative templates, re-instantiated on `catalogue.diff` | `itest:template-new-entity` (≤ 1 refresh + 1 interval) |
| [ALR-003](../product/07-alerting.md#alr-003--composite-rules-page-once) | §4.1 composite after children; T16-029 `notify:false` | `itest:composite-pages-once` |
| [ALR-004](../product/07-alerting.md#alr-004--evaluation-independent-of-the-pulsusdb-ruler) | §4.1 SLO burn evaluated in Dash; §4.14 evaluator-agnostic UI; T16-008, T16-024 | `itest:alerting-ruler-disabled` |
| [ALR-005](../product/07-alerting.md#alr-005--one-state-vocabulary) | §4.4 Table 3.2 names and glyphs in `dash-alert-core`, API and templates | `golden:alert-state-glyphs` (every state × view, greyscale) |
| [ALR-006](../product/07-alerting.md#alr-006--lifecycle-transitions) | §4.4 T16-002 | `prop:alert-core-prometheus-parity` |
| [ALR-007](../product/07-alerting.md#alr-007--nodata-and-error-are-first-class) | §4.4 T16-003; §4.15 Unknown health for NoData/Error | `itest:nodata-error-policies` |
| [ALR-008](../product/07-alerting.md#alr-008--flapping-detection) | §4.4 T16-004; §4.16 flap counts | `prop:flapping-damping` |
| [ALR-009](../product/07-alerting.md#alr-009--severity-maps-to-the-health-scale) | §4.4 T16-005 | `unit:severity-health-map`; `golden:alert-severity-views` |
| [ALR-010](../product/07-alerting.md#alr-010--create-alert-from-every-inspector) | §5.1 `rules/prefill` from viewport query, entity, Context | `e2e:create-alert-from-inspector` |
| [ALR-011](../product/07-alerting.md#alr-011--live-backtest-with-draggable-threshold) | §4.5 fetch once, simulate in WASM | `bench:backtest-drag` (< 16 ms per change on (b)) |
| [ALR-013](../product/07-alerting.md#alr-013--notification-preview) | §4.5 step 4, §5.1 `preview` with the real renderer | `itest:notification-preview-parity` |
| [ALR-014](../product/07-alerting.md#alr-014--blast-radius-for-entity-relative-templates) | §5.1 `rules/blast-radius` | `itest:template-blast-radius` |
| [ALR-015](../product/07-alerting.md#alr-015--route-and-runbook-from-entity-ownership) | §5.1 prefill route from T12 ownership | `itest:route-from-owner-prefill` |
| [ALR-016](../product/07-alerting.md#alr-016--one-alert-set-across-views) | §4.15 one alert-set feed filtered by Context and alert filter | `e2e:alert-views-same-set` (Alt+1…7 same incident count) |
| [ALR-018](../product/07-alerting.md#alr-018--container-aggregation) | §4.15 per-instance worst health and incident id for container aggregation | `e2e:container-aggregation` |
| [ALR-019](../product/07-alerting.md#alr-019--show-what-still-needs-a-human) | §4.15 acked/silenced flags; silenced excluded unless `show_silenced` | `e2e:needs-a-human-filter` |
| [ALR-020](../product/07-alerting.md#alr-020--acknowledge-from-any-alert-view) | §4.15 ack API, bus fan-out ≤ 1 s, Slack update in place; audit | `e2e:ack-propagation` (≤ 1 s all views and collaborators) |
| [ALR-021](../product/07-alerting.md#alr-021--historical-replay-of-every-view) | §4.15 `state-at` snapshot from history (T11 §5.3) | `itest:alert-replay-at-t` |
| [ALR-022](../product/07-alerting.md#alr-022--map-content) | §4.15 feed carries entity geo/region ids and failing cross-region edges (rendering T02) | `e2e:map-alert-content` |
| [ALR-024](../product/07-alerting.md#alr-024--dark-region-is-never-healthy) | §4.15 NoData staleness `stale_for` | `e2e:dark-region-nodata` |
| [ALR-025](../product/07-alerting.md#alr-025--segment-matrix) | §4.15 feed by entity, aggregated per segment dimension | `e2e:segment-matrix-counts` |
| [ALR-027](../product/07-alerting.md#alr-027--victim-aware-cells) | §4.6 origin/victim role per alert in the feed | `e2e:victim-aware-cells` |
| [ALR-028](../product/07-alerting.md#alr-028--ranked-list-and-treemap-modes) | §4.15 care-score per incident in the feed | `e2e:ranked-list-care-order` |
| [ALR-029](../product/07-alerting.md#alr-029--silence-or-maintain-from-a-cell) | §5.1 silence/maintenance drafts from matchers | `e2e:silence-from-cell` |
| [ALR-030](../product/07-alerting.md#alr-030--infra-heat-grid) | §4.15 Arrow snapshot of instance states per entity | `e2e:infra-heat-grid` |
| [ALR-031](../product/07-alerting.md#alr-031--workload-targeted-alerts-outline-their-pods) | §4.15 `target_entity` with workload → pod expansion (T12 (draft)) | `e2e:workload-alert-outline` |
| [ALR-032](../product/07-alerting.md#alr-032--infra-scale) | §4.15 100k-instance snapshot ≤ 8 MB Arrow, deltas after | `bench:alert-feed-100k` (with the T02 frame gate) |
| [ALR-034](../product/07-alerting.md#alr-034--alert-layer-on-topology) | §4.6 incident membership and origin for hulls | `e2e:topology-incident-hull` |
| [ALR-035](../product/07-alerting.md#alr-035--alert-layer-on-city) | §4.15 same aggregation feed for City | `e2e:city-alert-layer` |
| [ALR-036](../product/07-alerting.md#alr-036--list-columns-and-grouping) | §4.15 Table 5.6 columns in the feed; grouping server-side | `e2e:alert-list-columns` |
| [ALR-037](../product/07-alerting.md#alr-037--list-keyboard-and-bulk-actions) | §5.1 bulk ack/silence/assign/merge/split; T16-012 sticky merges | `itest:sticky-merge-split` |
| [ALR-038](../product/07-alerting.md#alr-038--saved-alert-views) | §4.15 shipped saved views as filters (T11 `saved_views`) | `itest:saved-view-silenced-expiring` |
| [ALR-039](../product/07-alerting.md#alr-039--incident-swimlanes) | §4.15 transitions + deliveries + changes on one axis | `e2e:incident-swimlanes` |
| [ALR-040](../product/07-alerting.md#alr-040--alerts-in-viewports) | §4.7 `ALERTS` per series with threshold annotation | `e2e:viewport-firing-bands` |
| [ALR-041](../product/07-alerting.md#alr-041--alerts-in-lens-chips-and-home) | §4.15 alerts for entity + dependencies with role; severity → health dot | `e2e:lens-alert-header` |
| [ALR-042](../product/07-alerting.md#alr-042--global-incident-counter) | §4.15 `my_unacked_incidents` counter | `e2e:global-incident-counter` |
| [ALR-043](../product/07-alerting.md#alr-043--noc-wall-alerts) | §4.15 incident queue with salience inputs (unowned age) | `e2e:noc-wall-queue` |
| [ALR-044](../product/07-alerting.md#alr-044--mobile-alert-handling) | §4.10 PWA push v1; §5.1 ack/silence/escalate API used by T20 (draft) | `e2e:mobile-ack-propagation` |
| [ALR-045](../product/07-alerting.md#alr-045--rule-history-view) | §4.16 rule history + summary line | `itest:rule-history-summary` |
| [ALR-046](../product/07-alerting.md#alr-046--rule-versions-and-beforeafter-backtest) | §4.5 before/after backtest of two versions | `itest:before-after-backtest` |
| [ALR-047](../product/07-alerting.md#alr-047--per-instance-breakdown-and-evaluation-health) | §4.2 T16-011 missed-evaluation watchdog; §4.16 per-instance grid | `chaos:rule-not-evaluating` (3 skipped intervals → alert) |
| [ALR-048](../product/07-alerting.md#alr-048--calendar-heatmap-of-incidents) | §4.16 calendar aggregation over `incidents` | `itest:incident-calendar-counts` |
| [ALR-049](../product/07-alerting.md#alr-049--transition-explorer) | §4.7 transition stream; §4.16 top flapping panel | `bench:transition-explorer-1e6` |
| [ALR-050](../product/07-alerting.md#alr-050--segment-trends) | §4.16 incident-hours per segment | `itest:segment-trends-reference` |
| [ALR-051](../product/07-alerting.md#alr-051--ops-metrics) | §4.16 ops-metric definitions | `itest:ops-metrics-reference` |
| [ALR-052](../product/07-alerting.md#alr-052--incident-archive) | §4.16 archive search (T11 incidents) | `itest:incident-archive-search` |
| [ALR-055](../product/07-alerting.md#alr-055--v1-endpoints) | §4.10 v1 tier | `contract:endpoints-v1` (recorded provider contracts) |
| [ALR-057](../product/07-alerting.md#alr-057--interactive-chat-messages) | §4.13 Slack/Teams interactivity, update in place | `contract:slack-interactive`; `contract:teams-action-execute` |
| [ALR-058](../product/07-alerting.md#alr-058--two-way-sync-with-paging-and-itsm) | §4.13 two-way sync | `contract:pagerduty-two-way` (≤ 10 s); `contract:servicenow-ticket-sync` |
| [ALR-059](../product/07-alerting.md#alr-059--existing-contact-point-import) | §4.10 import maps types available now; T11 §4.10 report | `itest:dashboard-import-corpus` |
| [ALR-060](../product/07-alerting.md#alr-060--contact-point-editor) | §4.9 delivery defaults, T16-014, T16-015 digest | `itest:rate-limit-digest` (45 in 1 min → 30 + one digest of 15) |
| [ALR-061](../product/07-alerting.md#alr-061--test-notification) | §4.9 T16-028 test send, response inline | `contract:test-notification` |
| [ALR-062](../product/07-alerting.md#alr-062--secrets-are-write-only) | §8 secrets via `SecretStore` ([T18](T18-security.md) §4.8) | `itest:secret-write-only` |
| [ALR-063](../product/07-alerting.md#alr-063--used-by-blast-radius) | §5.1 `used-by` from `rule_routes` and the policy tree | `itest:contact-point-used-by` |
| [ALR-064](../product/07-alerting.md#alr-064--template-language-with-live-preview) | §4.11 `dash-gotmpl` with per-target preview, SMS 160 | `golden:gotmpl-differential` |
| [ALR-065](../product/07-alerting.md#alr-065--default-templates-carry-the-rca-card) | §4.11 default templates with `.RCA`; T16-027 ≤ 178-char push body | `golden:default-templates-rca` |
| [ALR-067](../product/07-alerting.md#alr-067--redaction-on-every-outbound-payload) | §4.11 T16-019 redaction at output time | `itest:redaction-all-payloads` |
| [ALR-068](../product/07-alerting.md#alr-068--every-attempt-recorded) | §4.9 T16-016; T11 `notification_deliveries` | `itest:delivery-attempt-record` |
| [ALR-069](../product/07-alerting.md#alr-069--meta-alert-to-a-fallback-route) | §4.9 T16-017 | `itest:meta-alert-fallback` |
| [ALR-070](../product/07-alerting.md#alr-070--heartbeat-dead-mans-switch) | §4.9 T16-018 Watchdog through evaluate → route → deliver | `chaos:heartbeat-stops` (evaluator, router, Postgres each stopped → no heartbeat in 2 min) |
| [ALR-071](../product/07-alerting.md#alr-071--policy-tree-editor-with-traffic-sankey) | §4.8 Sankey over `notification_deliveries` route paths | `itest:sankey-vs-deliveries` |
| [ALR-072](../product/07-alerting.md#alr-072--routing-simulator) | §4.8 simulator incl. silences, mute timings, maintenance | `itest:routing-simulator-parity` |
| [ALR-073](../product/07-alerting.md#alr-073--route-to-the-owner-of-the-origin-entity) | §4.8 `owner_of_origin` | `itest:route-owner-of-origin` |
| [ALR-074](../product/07-alerting.md#alr-074--grouping-and-timing) | §4.8 Alertmanager timings; `group_by: Incident`; T16-025 | `itest:routing-parity-alertmanager`; `e2e:one-page-per-incident` |
| [ALR-075](../product/07-alerting.md#alr-075--escalation-chains) | §4.8 escalation chains; delegation | `itest:escalation-chain` |
| [ALR-076](../product/07-alerting.md#alr-076--mute-timings) | §4.8 mute timings; decision row "muted (…)" | `itest:mute-timing-status` |
| [ALR-077](../product/07-alerting.md#alr-077--silences-with-preview-reason-and-audit) | §4.8 silences: preview, reason, nudge, audit | `itest:silence-reason-audit` |
| [ALR-078](../product/07-alerting.md#alr-078--maintenance-windows) | §4.8 RRULE maintenance → In maintenance; occurrences API | `itest:maintenance-rrule` |
| [ALR-080](../product/07-alerting.md#alr-080--actions-run-through-the-action-framework) | §4.10 automation endpoints via [T18](T18-security.md) §4.7; v1 generic webhook | `itest:action-framework-webhook` |
| [ALR-082](../product/07-alerting.md#alr-082--monthly-noise-report) | §4.16 monthly noise report job (M-UI5) | `itest:noise-report-sections` |
| [ALR-083](../product/07-alerting.md#alr-083--one-click-hygiene-fixes) | §4.16 fixes open the editor with a before/after backtest | `e2e:hygiene-fix-add-for` |
| [ALR-084](../product/07-alerting.md#alr-084--alert-history-in-postgres) | §4.7 T16-009 transitions and deliveries in Postgres only | `itest:retention-drop`; `itest:no-pulsusdb-writes` |
| [ALR-085](../product/07-alerting.md#alr-085--history-queryable-as-telemetry) | §4.7 virtual series and event stream, resolved in the BFF | `itest:virtual-source-alerts` (PulsusDB query log empty) |
| [ALR-087](../product/07-alerting.md#alr-087--alerting-survives-without-pulsusdb-ingest) | §4.7, T16-008: no ingest anywhere in the alerting path | `itest:alerting-no-ingest` |
| [AI-001](../product/06-ai-copilot.md#ai-001--rca-triggers) | §4.6 one `incident.created` per incident triggers auto-RCA (co-satisfies with T15 (draft)) | `e2e:one-rca-per-incident` |
| [AI-039](../product/06-ai-copilot.md#ai-039--incident-grouping) | §4.6 incident grouping | `e2e:one-page-per-incident` |
| [IA-018](../product/02-information-architecture.md#ia-018--context-relevant-alert-count) | §4.15 `context_firing_count` (Context entity set + dependencies) | `e2e:context-alert-count` |
| [ENT-002](../product/11-enterprise.md#ent-002--service-accounts) | §4.13 ack by service-account token audited as the SA | `itest:sa-token-ack` |
| [ENT-017](../product/11-enterprise.md#ent-017--append-only-audit-log) | §4.13, §4.15 every ack, silence and callback action audited | `itest:audit-alert-actions` |
| [ENT-029](../product/11-enterprise.md#ent-029--high-availability) | §4.2 leases + fencing, ≤ 20 s re-own; §4.8 nflog | `chaos:leader-kill` (no missed interval, no duplicate page); `itest:alert-ha-failover` |
| [PRF-041](../product/09-performance-contract.md#prf-041--push-handler-wall-time) | §4.10 PWA push payload pre-rendered as a binary envelope | `bench:push-handler` (with T20 (draft)) |
| [SCN-006](../product/13-core-flow-storyboard.md#scn-006--one-incident-not-14-alerts) | §4.6 grouping before routing | `e2e:storyboard-f0` (INC-2041 with 14 alerts at 12:23:00) |
| [SCN-007](../product/13-core-flow-storyboard.md#scn-007--the-page-answers-how-bad-where-what-changed) | §4.8 page deadline, §4.11 default template | `e2e:storyboard-f0` (page ≤ 15 s after first firing) |
| [SCN-011](../product/13-core-flow-storyboard.md#scn-011--sam-acks) | §4.15 ack fan-out | `e2e:ack-propagation` |

## 4. Design

### 4.1 Rule model

```rust
pub struct Rule {
    id: RuleId, version: u32, tenant: TenantId, owner_team: TeamId,
    kind: RuleKind, interval: Dur,            // default 1m, minimum 30s
    pending_for: Dur, keep_firing_for: Dur,
    severity: Severity, labels: Labels, annotations: Templates,
    nodata: StatePolicy, error: StatePolicy,  // Alert | Ignore | KeepLast | Ok
    notify: bool,                             // false: component of a composite, never pages on its own
    damping: bool,                            // ALR-008
    route_hint: Option<RouteHint>,            // e.g. "owner of origin entity"
}
pub enum RuleKind {
    Threshold { expr: QueryExpr, cond: Condition },                    // PromQL | LogQL | TraceQL-metrics
    SloBurn   { slo: SloId, policy: BurnPolicy },                      // generated, see below
    EntityTemplate { selector: EntitySelector, expr: ExprTemplate, cond: Condition, overrides: Vec<Override> },
    Anomaly   { entity_selector: EntitySelector, signal: HealthSignal, min_score: f32, impact_weighted: bool },
    Absence   { target: AbsenceTarget, max_age: Dur },                 // entity signal or pipeline lag
    Journey   { journey: JourneyId, min_success: f64, window: Dur },
    Composite { expr: BoolExpr<RuleRef> },                             // AND/OR/NOT over other rules' states
}
```

- **SLO burn rate** (the default kind when a rule is created from an entity with an SLO). An SLO
  (`good/total` query, objective, 30-day window) generates multiwindow multi-burn-rate rules
  following the Google SRE Workbook pattern: page on 14.4× burn over 1 h **and** 5 min, and on 6×
  over 6 h **and** 30 min; ticket on 3× over 1 d and 2 h, and 1× over 3 d and 6 h. **Dash evaluates
  the error-ratio expressions itself** (`sum(rate(bad[w])) / sum(rate(total[w]))` for w ∈ {5m,
  30m, 1h, 2h, 6h, 1d, 3d}) as instant queries through [T07](T07-scene-query-planner.md). The
  windows of 1 d and longer are re-evaluated every 5 min (they change slowly) and their last value
  is reused between, and PulsusDB picks its rollup level for the long ranges automatically. The
  generated rules are read-only children of the SLO and regenerate when it changes.
  - *Optional acceleration:* if an operator enables `slo.use_pulsusdb_ruler` **and** the tenant's
    PulsusDB ruler is enabled, Dash also installs the ratios as recording rules through the Rules
    API and reads the recorded series. Correctness never depends on it: when the recorded series is
    absent or older than 2 intervals, the evaluator falls back to the direct expressions
    (T16-008). Off by default.
- **Entity-relative templates** compile, where possible, into **one vectorised query** grouped by
  the entity's identifying label (`sum by (job) (rate(http_server_errors[5m])) / sum by (job)(…) >
  0.02` with `job=~` restricted to the selector's entities from T12 (draft) `selector_for`). Each
  resulting series maps back to an `EntityId`, which becomes the `entity_id` label. Per-entity
  overrides become a join against a threshold vector. New entities matching the selector are
  covered on the next `catalogue.diff`, with no rule change (ALR-002).
- **Anomaly** rules are thresholds over the `pulsus_anomaly_score` virtual series (Postgres
  `anomaly_scores`, [T11](T11-postgres-schema.md) §4.13.3), resolved by the planner and never sent
  to PulsusDB, optionally weighted by impact. Severity by deviation × impact maps to SEV levels.
- **Absence**: `absent_over_time` per entity selector, or T12 (draft) freshness (`last_seen`) for
  entities without a natural metric; pipeline lag from collector metrics.
- **Journey**: generated from the journey definition as a TraceQL-metrics ratio over the entry spans
  (`… | rate()` success over total) on the TraceQL metrics instant route.
- **Composite**: evaluated after its children in the same tick. Children's instance states are
  read from the shared state cache (§4.3), at most one interval stale.

#### T16-029 — Composite components do not page
**MUST** — A rule with `notify: false` MUST be evaluated and shown in every view, and MUST NOT
produce a notification on any route; it MAY still contribute to its composite and to incident
grouping.

#### T16-008 — No dependency on the PulsusDB ruler or ingest
**MUST** — Every rule kind MUST evaluate and notify with the PulsusDB ruler disabled and with
PulsusDB ingest rejecting writes from Dash. Evaluation reads PulsusDB through the query APIs and
Dash's Postgres only.

### 4.2 Scheduling, sharding and HA

```
 evaluator replicas (N, stateless binaries; role `evaluator` per T19, or `all`)
   ├─ membership: evaluator_members(member, epoch, heartbeat_at)        heartbeat 5 s, TTL 15 s
   ├─ 256 virtual shards: shard(rule) = xxh3(rule_id) mod 256
   ├─ owner(shard)   = rendezvous hash (HRW) over live members           every member computes the same answer
   └─ shard leases:  rule_shard_leases(shard, owner, fence, expires_at)  must be held to evaluate
```

#### T16-006 — Evaluate only under a fenced shard lease
**MUST** — A member MUST evaluate a shard only while holding its lease (renewed every 5 s, 15 s
TTL). On a membership change, the new owner MUST wait for the old lease to expire or be released,
then take it with `fence = fence + 1`. Every instance upsert, transition row and outbox row MUST
carry the fence and be rejected by Postgres if it is stale ([T11](T11-postgres-schema.md) T11-011).

That is what prevents a paused or partitioned old owner from double-notifying. Rendezvous hashing
moves only ≈ 1/N of shards when membership changes. On `SIGTERM` an evaluator releases its leases
immediately ([T19](T19-deployment.md) §4.5), so a rolling upgrade moves shards in well under one
interval; on a crash the lease expires in ≤ 15 s and the new owner evaluates immediately on
acquisition, which keeps missed evaluations within one interval for the 30 s minimum interval
(ENT-029).

**Ticks.** Each rule evaluates at `t = ⌊now/interval⌋·interval + offset(rule)`, where `offset` is
a stable hash of the rule id within the interval (spreads load, keeps timestamps aligned and
reproducible). Queries go through [T07](T07-scene-query-planner.md) with the budget class
`alerting` (highest priority, never shed before interactive).

#### T16-010 — Alerting queries have top priority
**MUST** — Evaluation queries MUST use the planner budget class `alerting`, which is never shed
before interactive or AI classes; backtests use the interactive class `backtest` and MUST NOT
consume the `alerting` budget.

#### T16-011 — Missed evaluations are recorded and alerted
**MUST** — A tick that cannot start within one interval MUST be recorded as a **missed
evaluation** in `rule_eval_stats` (with its scheduled timestamp), and `alert_rules.last_eval_at`
MUST be updated on every completed tick. A singleton **evaluation watchdog** (every 30 s, under a
`job_leases` lease, independent of shard ownership) MUST raise the meta-alert "rule not evaluating"
to the rule's fallback route for any unpaused rule whose `last_eval_at` is older than 3 intervals,
so a rule that stops evaluating for any reason (stuck query, unowned shard) pages.

**Singleton jobs** (evaluation watchdog, incident grouper per tenant, escalation timers, silence
expiry nudges, hygiene report, retention) run under `job_leases` leases
([T06](T06-bff-architecture.md) primitive).

### 4.3 Instance state, storage and recovery

```rust
pub struct Instance {
    rule: RuleId, fp: Fingerprint,            // xxh3-64 of sorted label set (incl. entity_id)
    state: State, state_since: Ts, active_at: Option<Ts>, fired_at: Option<Ts>, resolved_at: Option<Ts>,
    last_eval: Ts, last_value: f64, labels: Labels, annotations: Rendered,
    flags: Flags,                             // Acked | Silenced | InMaintenance | Flapping | Stale
    flaps: RingBuf<Ts, 16>, ack: Option<Ack>, silenced_by: SmallVec<[SilenceId; 1]>,
    incident: Option<IncidentId>, fence: u64,
}
```

#### T16-007 — Transitions are durable before they notify
**MUST** — Every state transition and flag change MUST be persisted **synchronously in one
transaction** that upserts `alert_instances`, inserts the `alert_transitions` row and inserts the
`alert_events` outbox row, all fenced. Nothing is notified for a transition that is not committed.
Value and last-eval fields are checkpointed every 5 minutes.

On shard acquisition the owner loads all instances for the shard, restores `Pending` timers from
`active_at` (Prometheus's `for`-state restoration semantics), and evaluates immediately.
Notifications are not repeated on restore because the dispatcher's `nflog` (§4.8) shows what was
already sent. After a Postgres PITR, the owner first reconciles each instance with its latest
`alert_transitions` row (same database, same snapshot; [T11](T11-postgres-schema.md) §4.12) and then
re-evaluates; a transition that the restored database does not contain is re-derived on the next
tick.

### 4.4 State machine

States as [07](../product/07-alerting.md) Table 3.2.

| State | Glyph | API name |
|---|---|---|
| Normal | ○ | `normal` |
| Pending | ◔ | `pending` |
| Firing | ● | `firing` |
| Firing·Acked | ● ✓ | `firing` + flag `acked` |
| Firing·Silenced | ● 🔇 | `firing` + flag `silenced` |
| Resolved | ✓ | `resolved` |
| NoData | ⊘ | `nodata` |
| Error | ✖ | `error` |
| Paused | ⏸ | `paused` |
| In maintenance | 🛠 | flag `maintenance` |

```
 per tick, per instance:
   result = Value(v) | NoSeries | QueryError(e)
   NoSeries   → apply rule.nodata  (Alert → NoData, notifies as kind NoData; Ignore; KeepLast → last state + Stale flag; Ok → Normal)
   QueryError → apply rule.error   (Alert → Error after 2 consecutive errors; Ignore; KeepLast; Ok)
   cond(v) true : Normal→Pending(active_at=t)  · Pending→Firing if t−active_at ≥ pending_for · Resolved→Pending
   cond(v) false: Pending→Normal · Firing→ (false for keep_firing_for ? Resolved : Firing)
   Resolved → Normal after 15 min unless re-triggered
   flags: Acked (user), Silenced (matching silence active), InMaintenance (window active), Flapping (below)
```

#### T16-001 — One state machine
**MUST** — The state machine MUST be the crate `dash-alert-core`: `#![no_std]`-friendly, no I/O,
compiled to native (evaluator, backtest service) and to **WASM** (authoring UI). The live
evaluator, the backtest and the UI preview MUST use it, so a backtest shows exactly what the live
evaluator would have done.

#### T16-002 — Lifecycle transitions
**MUST** — `dash-alert-core` MUST implement the transitions of [07](../product/07-alerting.md)
Table 3.2, with Prometheus-compatible semantics for `for` and `keep_firing_for` and a 15-minute hold
of Resolved before Normal. Every API response, template context (`.Status`, `.State`) and feed row
MUST use the Table 3.2 names and glyphs above.

#### T16-003 — NoData and Error are states, never healthy
**MUST** — NoData and Error MUST have per-rule policies *alert*, *ignore*, *keep last* or *OK*.
Error under *alert* MUST be entered after 2 consecutive failed evaluations. Neither MUST map to
Normal or healthy unless the policy is *OK*; in the feed (§4.15) they MUST map to health Unknown,
and *keep last* MUST set the `stale` flag so views can show "(stale)".

#### T16-004 — Flapping
**MUST** — An instance with **6 or more state transitions in the last 60 minutes** MUST get the
`flapping` flag (shown as ⇅), cleared when the count drops below 6. With `damping` on, the
evaluator MUST hold the instance's outbox events until **two consecutive evaluations agree** on its
state, then emit only the net transition. Flag changes are history rows, so flap counts feed rule
history and the noise report.

#### T16-005 — Severity maps to health
**MUST** — `Severity::health()` MUST map SEV1 → Failing, SEV2 → Degraded, SEV3 → Degraded,
SEV4 → Watch ([07](../product/07-alerting.md) Table 3.3), and an entity's alert health MUST be the
worst over its firing instances.

### 4.5 Backtest

The authoring UI needs live numbers while the threshold is dragged (ALR-011).

1. **Fetch once.** The BFF evaluates the rule's expression **without the condition** as range
   queries over the backtest window (default 30 days, adjustable) with `step = rule.interval`.
   30 days at 1 min is 43 200 steps, above the usual 11 000-point limit, so the window is split into
   ≤ 10 000-step chunks executed in parallel through T07 and streamed as Arrow. Entity-relative
   templates fetch the vectorised form (all instances in one series set, capped at 500 instances for
   interactive backtest, noted in coverage).
2. **Simulate in the browser.** `dash-alert-core` in WASM runs the state machine over the series
   for any threshold, `for` and `keep_firing_for` in < 16 ms per change (43k steps × 500 series is ≈
   20M comparisons, vectorised). Dragging the threshold needs no round trip.
3. **Match incidents.** The BFF sends past incidents for the rule's entities (Postgres
   `incidents`: entity set, start, end). A simulated firing interval matches an incident if it
   overlaps `[incident.start − 30 min, incident.end]`. Outputs: would-have-fired count, matched
   incidents (recall, e.g. "2/2"), unmatched firings, **median lead time** (incident start − first
   firing), and **est. pages/month** after simulating routing: `group_by` and incident grouping
   collapse firings that the same route would have sent as one page.
4. **Preview notification**: one backtested firing is rendered through the real template engine
   (§4.11) and chart renderer (§4.12), for every integration the rule routes to (ALR-013).

SLO burn and anomaly kinds backtest the same way over their generated expressions; composite
backtest simulates children first. **Before/after** (ALR-046): two rule versions are simulated over
the same fetched series and shown side by side; the hygiene fixes (§4.16) use the same path.

### 4.6 Incident grouping

Alerts are grouped into **incidents** before routing, so one page per incident (AI-039, SCN-006).

```
 on instance → Firing (or Pending with severity ≥ SEV2, for early grouping):
   e = entity of instance (entity_id label, else resolved via T12)
   candidates = open incidents with last_activity ≥ now − 15 min
   for c in candidates:
     topo = min hops(e, c.entities) over dependency ∪ runs-on (T12), within 3
     time = |onset(e) − c.onset| ≤ 10 min
     origin = T15 stage-1 top candidate of c explains e (e ∈ explained set)
     score = 0.5·[origin] + 0.3·exp(−topo) + 0.2·[time]
   join the best candidate with score ≥ 0.45; else open a new incident
 after T15 stage 1 for an incident (≤ 5 s): merge incidents that share the same top origin unit
```

Union-find over incidents makes merges cheap. Incident severity = max of its alerts; probable origin
and the causal sentence come from T15 (draft). Each alert in an incident carries a **role**:
`origin` (its entity is the stage-1 top origin), `victim` (downstream of the origin within the
incident), or `none`; the feed (§4.15) and the Segments, Topology and City views use it. Incident
records live in Postgres (`INC-n` numbering, [T11](T11-postgres-schema.md) §4.5) and are created on
the evaluator's `alert_events` stream by the singleton **grouper** (one per tenant,
leader-elected), because grouping needs a tenant-wide view. `incident.created` triggers exactly one
auto-RCA per incident (T15 (draft)).

#### T16-012 — Human merges and splits are sticky
**MUST** — A human merge or split (List `M`/`U`, API) MUST set `incident_alerts.sticky`, and the
grouper MUST NOT move a sticky alert, merge a human-split incident back, or split a human-merged
one.

### 4.7 History in Postgres and virtual series

Per [ADR-0012](../adr/0012-derived-state-in-postgres.md) and [07](../product/07-alerting.md) §10,
**all alert history is in Postgres** and Dash writes none of it to PulsusDB.

#### T16-009 — History is Postgres-only
**MUST** — Transitions MUST be written to `alert_transitions` (T16-007) and every delivery attempt
and suppression decision to `notification_deliveries` ([T11](T11-postgres-schema.md) §4.13), under
the org's `alert_history` retention (default 13 months, dropped by partition). The alerting path
MUST NOT write transitions, notifications, `ALERTS` or `ALERTS_FOR_STATE` to PulsusDB by any
protocol (OTLP, remote write, Rules API).

**What is written where:**

| Event | Written to | By |
|---|---|---|
| State transition, flag change (ack, silence, maintenance, flapping) | `alert_transitions` | Shard owner, in the T16-007 transaction |
| Delivery attempt, retry, failure | `notification_deliveries` (`attempt ≥ 1`) | Delivery worker, after each attempt |
| Suppression decision (muted, silenced, inhibited, coalesced) | `notification_deliveries` (`attempt = 0`) | Dispatcher |
| Evaluation health | `rule_eval_stats` (hourly) | Shard owner |
| Evaluator self-telemetry (latency, queue depth) | Self-telemetry only ([T19](T19-deployment.md) §4.10) | — |

**Virtual series, not stored series.** `ALERTS` and `ALERTS_FOR_STATE` are **not written
anywhere**. The planner ([T07](T07-scene-query-planner.md)) resolves them, and the event streams,
against Postgres through `dash-store`'s `HistoryRepo`, computing step series from the interval rows
of [T11](T11-postgres-schema.md) §5.3 at the query step. They are never sent to PulsusDB. They can be
mixed with PulsusDB results in one scene, and PromQL functions over them (`rate()`,
`count_over_time()`, aggregations) run in the BFF; binary operations joining them with PulsusDB
series use the BFF join within its documented limits (T07).

**Label contract** (fixes the names left open in [07](../product/07-alerting.md)):

| Selector | Labels | Value |
|---|---|---|
| `ALERTS` | `alertname` (rule name), `alertstate` ∈ {`pending`, `firing`}, `severity` (`SEV1`…`SEV4`), `pulsus_rule_uid`, `pulsus_state` ∈ {`pending`, `firing`, `nodata`, `error`}, `entity_id` (if any), the rule's labels, the instance's labels | `1` at every step inside a Pending or Firing interval (NoData and Error under policy *alert* count as `alertstate="firing"`, distinguished by `pulsus_state`) |
| `ALERTS_FOR_STATE` | As `ALERTS` without `alertstate` | `active_at` in Unix seconds, while Pending or Firing (Prometheus semantics) |
| `{source="pulsus-dash", kind="alert_transition"}` | Stream labels `source`, `kind`, `severity`, `pulsus_rule_uid`; structured fields `from`, `to`, `flags`, `value`, `threshold`, `entity_id`, `incident`, `actor`, `labels.*` | One line per `alert_transitions` row |
| `{source="pulsus-dash", kind="notification_attempt"}` | Stream labels `source`, `kind`, `integration`, `status`; fields `contact_point`, `route`, `attempt`, `code`, `latency_ms`, `incident`, `reason` | One line per `notification_deliveries` row |

Flags (acked, silenced, maintenance) are not labels on `ALERTS`, because they would split one alert
into several series; they are in the transition stream. An interval ends exactly at its closing
transition (no look-back extension), so `ALERTS` matches the transition table step for step.

**Prometheus-compatible read API** (ALR-086, SHOULD): `GET/POST
/api/dash/v1/prom/api/v1/{query,query_range,series,labels,label/<name>/values}` serves the same
virtual selectors (and `pulsus_anomaly_score`) for external tools such as third-party dashboards, authenticated by
API token and scoped like any query. A query that references a non-virtual metric is answered
`422` with "query PulsusDB directly".

### 4.8 Routing engine and dispatcher

Alertmanager-compatible model, extended with incident awareness:

```rust
pub struct Route {
    matchers: Vec<Matcher>,                    // =, !=, =~, !~ (Alertmanager syntax)
    receiver: Option<ContactPointId>, continue_: bool,
    group_by: GroupBy,                         // labels | "..." (all) | Incident (default)
    group_wait: Dur, group_interval: Dur, repeat_interval: Dur,   // defaults 10s / 5m / 4h for incident routes
    mute_time_intervals: Vec<TimeIntervalId>, active_time_intervals: Vec<TimeIntervalId>,
    owner_of_origin: bool,                     // resolve receiver from T12 ownership
    escalation: Option<EscalationChainId>, children: Vec<Route>,
}
```

- `group_by: Incident` is the default: the aggregation group key is the incident id, so 14 alerts
  produce one page (ALR-074). Imported Alertmanager trees keep their label `group_by`.
- **Page deadline.** `group_wait` defaults to **10 s for incident-grouped routes** (Alertmanager's
  default is 30 s). The first notification of a group waits for `rca.stage1.ready` from T15 (draft)
  if stage 1 is not already done, but **never later than first firing + 12 s**. Stage 1 normally
  completes in < 5 s, inside `group_wait`, so the hold rarely engages. With delivery p95 ≤ 2 s the
  page arrives within 15 s of the first firing (SCN-007). If stage 1 is late, the page goes without
  the origin and is updated in place when it arrives.
- **Inhibition rules** (source/target matchers + `equal`) as in Alertmanager; plus automatic
  inhibition of victims' pages within an incident when the route says "page origin only".
- **Owner of origin** (ALR-073): `owner_of_origin: true` resolves the receiver at dispatch time from
  the T12 (draft) owner team of the incident's origin entity (falling back to the alert's entity
  owner, then to the route's `receiver`), so an ownership change re-routes without editing the
  route.
- **Silences** (ALR-077): matcher sets (or an entity selector, from a Segments cell or Infra
  group) with start/end, author and a **required reason**. Creating one returns a preview of the
  currently matching instances. The expiry-nudge job notifies the creator 15 min before
  `ends_at`. Creation, change and expiry are audited.
- **Maintenance windows** (ALR-078): RRULE (`rrule` crate) with time zone, scoped to entity
  selectors or segments; instances in scope get the `maintenance` flag and don't notify.
  `GET /alerting/maintenance/occurrences?from&to&entity` expands occurrences for the 🛠 regions on
  charts and hatched cells. A window MAY be created from a change ticket (ALR-079, SHOULD): the
  ServiceNow change request's CI and slot become scope and times, linked by `source_ref`.
- **Mute timings** (ALR-076) are time intervals referenced by routes; a muted notification is a
  decision row with `reason = 'mute timing <name>'`, which the List shows as "muted (<name>)".
- **Escalation chains** (ALR-075): ordered steps `{receiver, after: Dur, until_ack: bool}`; timers
  live in `escalation_timers` and are run by a singleton under lease; an ack cancels later steps.
  Customers with a paging product delegate escalation by routing to it with no Dash chain.

#### T16-025 — Imported timings are preserved
**MUST** — Routes imported from Alertmanager or other existing alerting systems MUST keep their `group_wait`,
`group_interval` and `repeat_interval`; the 10 s incident default applies only to routes created in
Dash. The routing editor shows the difference.

**Dispatcher sharding.** Grouping crosses rules, so dispatch is sharded by `hash(route,
group_key)` over the same membership with its own lease table (`dispatch_leases`). Evaluators write
`alert_events` (outbox) in the transition transaction; dispatchers consume with `FOR UPDATE SKIP
LOCKED` and are woken by `LISTEN/NOTIFY`.

#### T16-013 — No duplicate notification across failover
**MUST** — The dispatcher MUST record each send in `nflog` `(receiver, group_key,
firing_set_hash, resolved_set_hash, window_start, sent_at, fence)` before handing it to delivery,
mirroring Alertmanager's nflog: a group is (re)sent only if its firing set changed or
`repeat_interval` elapsed, and the unique key stops duplicates across failover.

**Simulator** (ALR-072). `POST /api/dash/v1/alerting/routing/simulate {labels | instance_ref, at}`
walks the tree with the same code and returns matched routes, receivers, the matcher that matched
or failed at each node, and mute, silence, maintenance and inhibition decisions with the reason for
each. The **Sankey** of real traffic (ALR-071) is an aggregate over the last 7 days of
`notification_deliveries.route_path` in Postgres.

### 4.9 Delivery workers

```rust
#[async_trait::async_trait]
pub trait Notifier: Send + Sync {
    fn kind(&self) -> &'static str;                       // "slack", "pagerduty", …
    fn caps(&self) -> NotifierCaps;                       // images, interactive, update_in_place, resolve, two_way
    fn validate(&self, cfg: &serde_json::Value) -> Result<(), ConfigError>;
    async fn send(&self, n: &RenderedNotification, cx: &DeliveryCtx) -> Result<Receipt, DeliveryError>;
    async fn update(&self, prior: &Receipt, n: &RenderedNotification, cx: &DeliveryCtx)
        -> Result<Receipt, DeliveryError> { self.send(n, cx).await }
}
pub enum DeliveryError { Retryable { after: Option<Dur>, reason: String }, Permanent(String), RateLimited(Dur) }
```

- **Queue**: Postgres `delivery_jobs` (`SKIP LOCKED`), one job per (notification, integration).
  Workers run in every `notifier` replica, `reqwest` through `dash-egress`
  ([T18](T18-security.md) §4.9).

#### T16-014 — Delivery defaults
**MUST** — Each integration MUST default to 5 attempts with exponential backoff and full jitter
(1 s base, ×2, cap 5 min), a 10 s timeout, and send-resolved on (ALR-060). `Retry-After` MUST be
honoured and permanent errors MUST stop retrying immediately.

#### T16-015 — Rate limits coalesce, never drop
**MUST** — A per-integration token bucket (configured, e.g. 30/min) and a per-destination-host
bucket (provider defaults, e.g. Slack's per-channel posting limits, to be measured) MUST coalesce
excess notifications into **one digest** sent when the bucket refills, never drop them; each
coalesced notification gets a `coalesced` decision row.

#### T16-016 — Every attempt recorded
**MUST** — Every attempt MUST be recorded in `notification_deliveries` with endpoint, payload hash,
response code, a redacted response excerpt (≤ 512 B), latency and attempt number. These rows drive
per-alert status (✓ delivered / ✖ failed / ⏳ retrying), "Last 7 d" counts and **contact point
health** (success ratio over the last hour).

#### T16-017 — Meta-alert to the fallback route
**MUST** — An integration with ≥ 3 consecutive permanent failures, or < 50 % success over 15 min,
MUST raise a Dash-internal meta-alert ("contact point <name> failing") routed to the tenant's
**fallback route** (a contact point with `is_fallback`), which MUST NOT be the failing contact
point, so a broken Slack token can't silence production.

#### T16-018 — Heartbeat through the whole pipeline
**MUST** — For every org with a heartbeat receiver (and for the deployment, [T19](T19-deployment.md)
§4.6), an always-firing internal **Watchdog** rule MUST be evaluated by its shard owner every 30 s
and MUST emit a fenced `heartbeat` outbox event each tick; the dispatcher routes it on a dedicated
route (`group_wait 0`, `repeat_interval 1m`) and a delivery worker sends it to the external receiver
(PagerDuty, Healthchecks.io-style, Better Stack). There MUST be no side channel that pings the
receiver directly, so stopping the evaluator, the router or Postgres stops the heartbeat. The
receiver's grace period SHOULD be set to 2 minutes.

- **Interactive updates**: integrations with `update_in_place` (Slack `chat.update`, Teams card
  update, PagerDuty dedup key) edit the same message as the incident evolves (acked, origin found,
  resolved).

#### T16-028 — Test notifications
**MUST** — `POST …/contact-points/{id}/integrations/{n}/test` MUST send a real notification marked
"TEST" in title and body through the same worker path, and return the endpoint's status and a
redacted body excerpt within the integration timeout; it is recorded with `status='test'`.

### 4.10 Endpoint catalogue implementation tiers

The product tiers are those of [07](../product/07-alerting.md) Table 7.1: **v1 at M-UI4**, **v2 at
M-UI5**. Each endpoint is built either as a **native** Rust module implementing `Notifier`, or as a
**recipe**: a declarative HTTP recipe (URL template, headers, auth, body template, success
predicate, dedup field) run by the generic webhook engine, shipped as data and versioned.

| Product tier | Build | Endpoints |
|---|---|---|
| **v1** (M-UI4) | Native | Slack app (buttons), Microsoft Teams (app; workflows webhook one-way), Google Chat, PagerDuty Events v2, Atlassian JSM Operations / Opsgenie, incident.io, ServiceNow (incident + event management, CI linking), Jira / JSM (create, transition), email (SMTP with TLS/auth, Amazon SES, SendGrid; HTML + text; digest mode), Pulsus PWA web push, generic Webhook (templated body, HMAC signing, mTLS, custom headers, OAuth2 client credentials), Alertmanager-compatible webhook, forwarding to an external Alertmanager (`POST /api/v2/alerts`), Kafka (`rdkafka`) |
| **v1** (M-UI4) | Recipe | **Webhook-based chat**: presets of the generic webhook for chats that accept an incoming-webhook JSON body. The recipe engine itself ships at M-UI4 |
| **v2** (M-UI5) | Recipe | Mattermost, Cisco Webex, Discord, Telegram, Rocket.Chat, Zulip; DingTalk, WeCom, Feishu/Lark, LINE, Threema; Splunk On-Call, Rootly, FireHydrant, xMatters, Squadcast, Zenduty, Better Stack, other external on-call / incident tools; BMC Helix, Freshservice, Zendesk; Vonage SMS, Amazon SNS SMS; Pushover, ntfy; Sensu Go; status pages (Atlassian Statuspage, Better Stack, instatus — **draft only**); outbound webhook to an external AI agent carrying the RCA card |
| **v2** (M-UI5) | Native | Twilio SMS and voice with TTS and DTMF ack; MQTT; AWS SNS / EventBridge, GCP Pub/Sub, Azure Event Grid / Service Bus; Pulsus public status page (draft only); MCP push to an external agent; automation endpoints (GitHub Actions `repository_dispatch`, GitLab pipeline trigger, Rundeck / PagerDuty Process Automation, Ansible AWX/AAP, Argo Workflows, StackStorm), each executed through the action framework ([T18](T18-security.md) §4.7), with the result posted to the incident timeline |

- **Two-way sync** (`two_way` capability): PagerDuty, JSM/Opsgenie and incident.io (ack/resolve)
  and ServiceNow and Jira (ticket status ↔ incident status) at v1; the v2 paging and ITSM recipes
  declare it where the provider API allows.
- **PWA push** payloads are rendered on the server into the binary envelope of T20 (draft), so the
  service worker's `push` handler parses nothing and stays within its 50 ms budget (PRF-041).
- **Existing contact point import** maps contact-point types 1:1 to whatever is available at import time and lists
  the rest as unmapped ([T11](T11-postgres-schema.md) §4.10, ALR-059).
- Automation at v1 uses the generic webhook as the action transport (ALR-080).

### 4.11 Template engine

**Decision: an in-house interpreter of the Go `text/template` subset that Alertmanager and other existing
alerting systems' templates use**, in crate `dash-gotmpl`, rather than a third-party crate. The candidate crate
(`gtmpl`) implements Go templates in Rust, but its maintenance status and completeness are
uncertain, and we need things it does not give us:

1. A **redaction hook** at value-output time (T16-019).
2. **Execution budgets** (T16-020).
3. **Error positions** for the editor ([T09](T09-query-editors.md)) and a WASM build for live
   preview.
4. Exact Alertmanager function set: `toUpper`, `toLower`, `title`, `join`, `match`,
   `reReplaceAll`, `safeHtml`, `stringSlice`, `date`, `tz`, plus the commonly used helpers of other existing alerting systems,
   and our additions (`causalSentence`, `lensLink`, `chartImage`, `truncate`).

Supported syntax: actions, pipelines, variables, `if/else if/else`, `range` (with `$i, $v`),
`with`, `define`/`template`/`block`, comparison and logic functions, `printf` (a defined subset of
verbs). Correctness is checked against a committed **differential corpus**: Alertmanager's and
other existing alerting systems' default templates plus imported customer templates, rendered once with Go's
`text/template` and stored as golden outputs (a CI fixture, not a shipped dependency). The data
model is Alertmanager's (`.Status`, `.Alerts`, `.GroupLabels`, `.CommonLabels`, `.ExternalURL`, …)
plus `.Incident` and `.RCA` (sentence, impact, origin, change, evidence links, confidence).

**Preview** (ALR-064) renders the same template for each target format: Slack blocks, Teams
Adaptive Card, email HTML and text, and SMS truncated to 160 characters with a `…` marker.

#### T16-019 — Redaction at output time
**MUST** — Every interpolated value, including AI-generated text in `.RCA`, MUST pass the org's
redaction pipeline ([T18](T18-security.md) §4.10) before it reaches any outbound payload, chart
title or push envelope. There MUST be no template function that bypasses it.

#### T16-020 — Template budgets
**MUST** — A template execution MUST be bounded (10⁵ steps, 256 KiB output by default); exceeding
the budget fails the render with a position, and the dispatcher falls back to the default template
for that target, flagged in the delivery row.

#### T16-027 — Default templates carry the RCA card
**MUST** — Default templates MUST include impact, ⊕ probable origin, the change, the causal
sentence when present, a deep link into the Alert Lens carrying entity and window
(`lensLink`), and ack/silence buttons where the endpoint supports them. The default push body MUST
be ≤ 178 characters (ALR-065) and the default chat first line SHOULD fit a lock-screen preview
(SCN-007).

### 4.12 Server-side chart images

Images come from the **same wgpu renderer running natively and headless**
([T02](T02-vis-engine.md), [ADR-0003](../adr/0003-wgpu-rendering.md)): a render pool
(`pulsus-dash render-worker`, Vulkan where a GPU exists, `llvmpipe` otherwise) takes a vis spec plus
Arrow data (the rule's expression over the last hour with threshold and firing band) and returns a
PNG (`png` crate), 800 × 320 at 2×. Budget p95 ≤ 300 ms on `llvmpipe`; cached by `(rule,
fingerprint, eval_ts)`. Images are stored as artefacts (object storage when configured, else
Postgres, 7 days; [T11](T11-postgres-schema.md) §4.15) and referenced by a signed URL with a 7-day
expiry, or attached directly (email CID, Slack file upload) where the endpoint needs it. If
rendering exceeds 2 s the notification is sent without the image (ALR-066, SHOULD).

### 4.13 Interactive callbacks

#### T16-021 — Callbacks are verified and act as the linked user
**MUST** — Every inbound callback MUST be authenticated (provider signature or JWT, 5-minute replay
window), MUST be mapped to a Dash principal through `identity_links`, MUST be authorised as that
principal (`alert:ack`, `alert:silence`, `incident:assign`) and MUST be audited under it.
Unlinked or unauthorised users get an ephemeral reply and nothing changes.

- **Slack**: interactivity request URL `/hooks/slack/interactions`; the signing-secret HMAC
  (`v0:timestamp:body`) is verified; the Slack user is mapped to a Dash user by the linked identity
  (email via SCIM, or a one-time "link your account" flow); the action (`ack`, `silence 1h`,
  `assign`, `open RCA`) is applied and the message is updated in place to "ACK <name>", origin
  found, or Resolved (ALR-057).
- **Teams**: Adaptive Cards with `Action.Execute` delivered through a registered bot
  (`/hooks/teams/messages`, Bot Framework JWT validation). Workflow-webhook-only Teams
  integrations are one-way. Exact Teams app requirements are to be confirmed in M-UI4.
- **PagerDuty / JSM / incident.io**: ack/resolve sync both ways through their webhooks, keyed by
  the dedup key = incident id, applied within 10 s of the provider event (ALR-058).
- **ServiceNow / Jira**: ticket state changes arrive by webhook (or 30 s poll where webhooks are
  not available) and map to incident status; Dash status changes transition the ticket.
- **Service-account tokens** (automation) can ack and silence through the same API and are audited
  as the service account (ENT-002).

### 4.14 Migration to the PulsusDB ruler (R15)

When PulsusDB evaluates alerting rules ([R15](pulsusdb-requirements.md)):

1. **Compile**: Threshold (PromQL/LogQL) and SLO burn rules compile to standard rule-group YAML;
   entity templates compile to their vectorised form. Anomaly rules (they read the Postgres-backed
   `pulsus_anomaly_score`), TraceQL journey rules and composite rules stay in Dash (the PulsusDB
   ruler kinds are `logs` and `metrics` only, and it cannot read Dash's virtual sources).
2. **Shadow**: PulsusDB evaluates in parallel; Dash compares transitions per instance for 14 days.
3. **Cut over per rule kind**: PulsusDB notifies Dash's **Alertmanager-compatible receiver**
   (`/hooks/alertmanager`), and Dash derives transitions from the received alerts into
   `alert_transitions`, so routing, incidents, templates, delivery and history stay in Dash
   unchanged. The evaluator then only runs Dash-only kinds.

#### T16-024 — The UI does not expose the evaluator
**MUST** — No authoring screen or API field MAY depend on where a rule is evaluated; the evaluator
location appears only in rule evaluation health (ALR-004, ALR-047).

### 4.15 Alert-set feed for the seven views

All seven views of [07](../product/07-alerting.md) §5, the Lens header, chips, Home, the global
counter, the NOC wall and the mobile PWA render **one feed**: the live alert set filtered by Context
(tenant, environment, team, time) and the alert filter (severity, state, `show_silenced`,
`show_acked`).

- **Subscribe:** WS `alerts.subscribe {context, filter}` returns a snapshot as an Arrow record
  batch ([ADR-0005](../adr/0005-arrow-wire-format.md)), then deltas. One row per instance:
  `rule_uid, fp, entity_id, target_entity, state, flags, severity, health, stale_for, incident,
  role, value, threshold, state_since, owner_team, acked_by, silence_id, notify_status[],
  labels`, plus one row per incident: `incident, number, severity, origin_entity, care_score,
  unowned_since, alert_count, entity_ids`.
- **Derived fields:** `health` per T16-005 and T16-003 (NoData/Error → Unknown); `stale_for` is the
  age of the last sample for NoData and keep-last instances (ALR-024 "stale 6 min");
  `target_entity` is the workload for workload-targeted rules, which the view expands to pods via
  T12 (draft) (ALR-031); `notify_status` is the latest status per integration from
  `notification_deliveries`; `care_score` follows [01a](../product/01a-audiences-and-perspectives.md)
  ordering and drives ranked lists and the NOC queue.
- **Containers** (region, cluster, segment cell, super-node, district) are aggregated in the
  browser from the entity hierarchy: worst `health`, distinct `incident` count and alert count, so
  every view switch is local and the morph needs no fetch. Filtering silenced instances out
  unless `show_silenced` is set (ALR-019) is applied in the feed, not hidden in the UI.
- **Size:** 100k instances ≈ 8 MB Arrow snapshot (dictionary-encoded labels), then deltas of
  changed rows only.
- **History** (ALR-021): `GET /alerting/state-at?t=&context=` returns the same snapshot shape as it
  was at `t`, built from `alert_transitions` intervals ([T11](T11-postgres-schema.md) §5.3); moving
  the Time Ribbon into the past switches the views to it and marks the chrome "history".
- **Timeline** (ALR-039): per incident, the state intervals of its alerts from `ALERTS`, 📣 from
  `notification_deliveries`, ⚙ and ◆ from the change feed, on one axis.
- **Counters** pushed on the same socket: `my_unacked_incidents` (un-acked incidents of the
  caller's teams, ALR-042) and `context_firing_count` (firing alerts on the current Context's entity
  set and their dependencies, IA-018). Which one the chrome's `⚠ n` shows is a product decision
  (§13, T16-7); the feed serves both.

#### T16-026 — Acks propagate within one second
**MUST** — An ack (or unack) from any view, the Alert Lens, the mobile card, Slack/Teams or a
paging integration MUST commit as a fenced flag transition, be published on the bus
(`alert.flag`), and reach every subscribed feed and the in-place chat update within 1 s p95. It MUST
be audited with the actor ([11](../product/11-enterprise.md) ENT-017).

### 4.16 History views, ops metrics and hygiene

All computed from Postgres history and incidents; definitions are fixed here so reference
computations are testable.

| Measure | Definition |
|---|---|
| Fired count | Transitions with `to_state = 'firing'` in the window |
| Median duration | Median of `Firing → Resolved` interval lengths |
| MTTA | Per incident: first ack − `opened_at`; per rule: first ack − `fired_at` |
| MTTR | Per incident: `resolved_at − opened_at` |
| No-action firing | A firing episode that resolved with no ack, no action, no timeline note and no silence |
| Flap count | Number of `flapping` on-flags in the window |
| Last evaluation | `alert_rules.last_eval_at` and status; missed ticks from `rule_eval_stats` |
| Pages per on-call shift | Delivered pages to paging integrations per shift; shifts from the synced paging schedule, else per calendar day |
| Out-of-hours pages | Pages outside the team's `working_hours` |
| Alerts per incident | Mean `incident_alerts` count per incident (the grouping ratio) |
| % actionable | Incidents with an ack and at least one of: action, timeline note, human resolution |
| Incident-hours (segment trends) | Σ `(resolved_at or now) − opened_at` per incident, attributed to the segment of its origin entity |

- **Rule history** (ALR-045): value (re-queried), state band from `ALERTS`, notifications from
  deliveries, ✎ markers from `alert_rule_versions` with diff summary and author, and the summary
  line above. **Per-instance grid** (ALR-047): `ALERTS` grouped by fingerprint.
- **Calendar heatmap** (ALR-048): `count(*)` of incidents by `date_trunc('day', opened_at)` and
  team or segment, 1 week to 1 year.
- **Transition explorer** (ALR-049): the `kind="alert_transition"` stream, paged by keyset; "top
  flapping rules" is an aggregate over the same window.
- **Incident archive** (ALR-052): full-text search over incidents and investigations, with
  root-cause category, origin, duration, impact, post-mortem and flight-recorder links.
- **Noise report** (ALR-082, M-UI5): a monthly singleton job per team writes `noise_reports` with
  the eight sections of [07](../product/07-alerting.md) §9 (no-action rules, flapping rules, rules
  that never fire, alerts without runbooks, uncovered tier-1 services from T12 (draft), failing
  contact points, silences re-created ≥ 3 times with the same matchers, alerts-per-incident trend).
  **One-click fixes** (ALR-083) open the rule editor with the change prefilled and its
  before/after backtest (§4.5).

## 5. Interfaces

### 5.1 HTTP and WS

| Interface | Purpose |
|---|---|
| `GET/POST/PUT /api/dash/v1/alerting/rules`, `…/rules/{id}/versions` | CRUD, versions (JSON; T11 versioning) |
| `POST /api/dash/v1/alerting/rules/prefill` | `{viewport query, entity, context}` → draft rule with kind (SLO burn if the entity has an SLO), suggested threshold from the visible data, route from owner, runbook |
| `POST /api/dash/v1/alerting/rules/blast-radius` | Template → instantiation count + currently-breaching list |
| `POST /api/dash/v1/alerting/backtest` | `{rule, window, versions?}` → Arrow series stream + incidents JSON |
| `POST /api/dash/v1/alerting/preview` | `{rule, firing_ref, contact_point}` → rendered payload per integration |
| `POST /api/dash/v1/alerting/routing/simulate` | Route simulator |
| `GET /api/dash/v1/alerting/instances?…`, WS `alerts.subscribe {context, filter}` | Live alert-set feed (§4.15) |
| `GET /api/dash/v1/alerting/state-at?t=` | Historical snapshot |
| `POST /api/dash/v1/alerting/incidents/{id}/{ack,unack,assign,merge,split,escalate}`, bulk variants | List and mobile actions |
| `POST /api/dash/v1/alerting/silences` (`?preview=true`), `/maintenance`, `/mute-timings`, `/escalation-chains` | |
| `GET /api/dash/v1/alerting/maintenance/occurrences` | Expanded windows for charts |
| `POST /api/dash/v1/alerting/contact-points/{id}/integrations/{n}/test`, `GET …/{id}/used-by` | Real test send; blast radius |
| `GET /api/dash/v1/alerting/rules/{id}/history`, `/alerting/ops-metrics`, `/alerting/noise-report` | §4.16 |
| `/api/dash/v1/prom/api/v1/*` | Prometheus-compatible read of virtual series (ALR-086) |
| `/hooks/slack/*`, `/hooks/teams/*`, `/hooks/pagerduty`, `/hooks/jsm`, `/hooks/incidentio`, `/hooks/servicenow`, `/hooks/jira`, `/hooks/alertmanager` | Inbound callbacks |
| Bus out | `alert.transition`, `alert.flag`, `incident.created/updated` (T15, T17, T12 health) |
| Bus in | `rca.stage1.ready` (T15), `catalogue.diff` (T12, template coverage) |

### 5.2 Cross-doc interfaces

| Counterpart | Interface | Assumption |
|---|---|---|
| [T06](T06-bff-architecture.md) | Modules `dash-alerting` (evaluator, grouper), `dash-notify` (dispatcher, workers); lease primitive | T06 maps modules to roles; leases are Postgres-based either way |
| [T07](T07-scene-query-planner.md) | Budget classes `alerting` (top priority) and `backtest` (interactive); virtual sources for `ALERTS`, `ALERTS_FOR_STATE`, `pulsus_anomaly_score`, `{source="pulsus-dash"}` | T07 implements the resolver over `HistoryRepo` with the §4.7 label contract |
| T12 (draft) | `view`, `selector_for`, ownership, freshness, workload → pods | |
| T15 (draft) | `rca.stage1.ready`; stage-1 explained set used in grouping | Stage 1 < 5 s (AI-002) |
| T17 (draft) | Incident timeline events (transitions, notifications, acks); Slack/Teams thread ids per incident | T17 owns channel mirroring |
| [T02](T02-vis-engine.md) | Native headless renderer `render(spec, arrow) -> Png` | |
| T10 (draft) | Rule owner's scope for evaluation queries; permissions `alert:*`; identity links | |
| [T18](T18-security.md) | Secrets (write-only, Vault refs); `dash-egress`; redaction; action framework for automation endpoints | |
| [T11](T11-postgres-schema.md) | All tables in §6 | T11 holds DDL |
| [T09](T09-query-editors.md) | Template editor uses `dash-gotmpl` WASM for errors and preview | |
| T20 (draft) | Push envelope format; ack/silence/escalate API | |

## 6. Data & storage

| Data | Store |
|---|---|
| Rules (versioned), SLOs, contact points, routes, inhibition rules, silences, maintenance windows, mute timings, templates, escalation chains | Postgres |
| `alert_instances` (current state), `evaluator_members`, `rule_shard_leases`, `dispatch_leases` | Postgres |
| `alert_events` outbox, `delivery_jobs`, `nflog`, `escalation_timers` | Postgres (outbox rows pruned 7 d after consumption) |
| `alert_transitions`, `notification_deliveries` | Postgres, monthly partitions, 13-month default retention |
| `rule_eval_stats`, `noise_reports`, incidents | Postgres |
| `ALERTS`, `ALERTS_FOR_STATE` | **Nowhere**: computed on read by the planner from the two history tables |
| Chart images | Artefacts (object storage or Postgres), 7 d |
| Evaluator self-telemetry | Dash self-telemetry ([T19](T19-deployment.md) §4.10) |

## 7. Performance budget

| Path | Target |
|---|---|
| Evaluation capacity | 20k rules, 500k instances, 1-min interval per tenant-cluster; ≤ 2 vCPU per 5k rules excluding query time |
| Tick lag | p99 < 10 s from scheduled time to state written |
| Firing → page delivered | p95 ≤ 15 s: `group_wait` 10 s (stage 1 normally ready at < 5 s), hold capped at first firing + 12 s, delivery p95 2 s ([13](../product/13-core-flow-storyboard.md) SCN-007) |
| Failover | Shard re-owned ≤ 20 s (immediate on graceful release); no duplicate page; no more than one missed interval at the 30 s minimum |
| Ack propagation | p95 ≤ 1 s to every feed and the chat message (T16-026) |
| Inbound two-way sync | ≤ 10 s from provider event to Dash state |
| Heartbeat | One delivery per ≤ 60 s while healthy |
| Backtest | Fetch 30 d ≤ 3 s for a single series, ≤ 8 s for 500; re-simulate ≤ 16 ms per drag frame |
| Alert feed | Snapshot of 100k instances ≤ 500 ms server time; deltas ≤ 250 ms after commit |
| `ALERTS` over 24 h for 5k instances | ≤ 150 ms BFF time (T11 §7 + step conversion) |
| Chart image | p95 ≤ 300 ms |

## 8. Security, tenancy & RBAC

#### T16-023 — Rules evaluate under their owner's scope
**MUST** — Rule queries MUST run as the rule's `owner_sa_id` with the owning team's data scope (T10
(draft)), so a rule cannot read data its authors couldn't. Alert instances, history rows and virtual
series MUST be filtered by the viewer's scope on `entity_id`/`tenant_binding_id` before they leave
the BFF.

#### T16-022 — Secrets and egress
**MUST** — Contact-point secrets MUST be read only through `SecretStore::get_for_use`
([T18](T18-security.md) §4.8), and every outbound request MUST go through `dash-egress`
([T18](T18-security.md) §4.9). Webhook bodies support HMAC signing, mTLS and OAuth2 client
credentials.

- All inbound callbacks verify signatures (T16-021); every ack and silence is audited under the
  human's or service account's identity.
- Redaction runs on every outbound payload (T16-019).
- Action-type endpoints and "Revert config"-style buttons in notifications run through the action
  framework with its approval policy ([T18](T18-security.md) §4.7).

## 9. Failure modes & degradation

| Failure | Behaviour |
|---|---|
| PulsusDB query error/timeout | `Error` state per policy (alerting after 2 consecutive); rule evaluation health shows it |
| PulsusDB unreachable for a whole tenant | All rules go `Error`; one meta-alert "alerting blind" through the fallback route; the Watchdog still fires (it does not query PulsusDB) |
| PulsusDB ingest disabled or rejecting | No effect: alerting never writes to PulsusDB (T16-008) |
| Postgres unavailable | Evaluators keep evaluating in memory but cannot commit transitions or notify (no outbox); the heartbeat stops, so the external dead-man's switch pages; on recovery the in-memory transitions are committed in order with the current fence |
| Evaluator crash | Lease expires ≤ 15 s; new owner restores Pending timers and evaluates immediately |
| Dispatcher crash | Outbox rows stay unconsumed; the next lease owner resumes; `nflog` stops duplicates |
| Endpoint failing | Retries, then meta-alert to fallback route; per-alert ✖ in List |
| Rate limit exceeded | Excess coalesced into one digest (T16-015) |
| T15 slow | Page sent at the deadline without the origin; updated in place when it arrives |
| Renderer slow | Send without image |
| Rule stops evaluating | Watchdog meta-alert after 3 intervals (T16-011) |

## 10. Testing

- `prop:alert-core-prometheus-parity`: property tests for `for`/`keep_firing_for` on generated
  series against Prometheus; WASM and native produce identical transitions.
- `prop:flapping-damping`: the 8-minute crossing series of ALR-008.
- **Routing parity** (`itest:routing-parity-alertmanager`): imported Alertmanager configs and label
  sets compared against Alertmanager's own routing (golden outputs captured once), including
  `continue`, inhibition and time intervals.
- **HA chaos** (`chaos:leader-kill`, `itest:alert-ha-failover`): kill/pause owners, partition
  Postgres connections; assert no duplicate and no lost notifications (counted at a fake receiver)
  across 10k simulated incidents, and no more than one missed interval.
- `chaos:heartbeat-stops`: stop each of evaluator, dispatcher, delivery worker and Postgres in turn;
  the fake heartbeat receiver sees no heartbeat within 2 min each time, and ≤ 60 s intervals when
  all run.
- `itest:alerting-no-ingest`: the full alerting suite with a PulsusDB proxy that rejects every
  write; every test passes and the proxy records no write attempt from the alerting path.
- `itest:virtual-source-alerts`: the ALR-085 acceptance queries match the transition table; the
  PulsusDB query log contains neither request.
- Template differential corpus (`golden:gotmpl-differential`); endpoint contract tests against
  recorded provider responses (`contract:endpoints-v1`, v2 at M-UI5).
- End-to-end storyboard test (`e2e:storyboard-f0`): the F0 timeline on the replay corpus, page
  content and time asserted.

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI4 | All rule kinds, sharded HA evaluator, backtest, incidents, routing with simulator, silences, maintenance, mute timings, escalation, v1 endpoints (native + webhook-chat recipes), templates, chart images, Slack/Teams interactivity, two-way sync, history in Postgres with virtual series and event streams, Prometheus-compatible read API, heartbeat, evaluation watchdog, existing contact point and rule import |
| M-UI5 | v2 endpoints (recipes and native), noise report and one-click fixes |
| After R15 | Shadow mode and per-kind cutover to the PulsusDB ruler |

## 12. Alternatives considered

| Alternative | Why not |
|---|---|
| Embed Prometheus/Alertmanager (Go) | Breaks Rust-everywhere, can't evaluate LogQL/TraceQL or entity templates, no incident grouping |
| Gossip clustering (Alertmanager-style) | Postgres is already required; leases + fences give stronger no-duplicate guarantees with less code |
| Raft (e.g. `openraft`) for state | Extra consensus layer next to an HA Postgres; not needed at this write rate |
| Backtest fully server-side | Every threshold drag would be a round trip; the shared WASM state machine is instant |
| A Rust Handlebars/Tera engine | Not compatible with imported Go templates |
| History as OTLP logs + `ALERTS` remote write into PulsusDB (the draft) | Rejected with ADR-0010; consumes customer ingest, depends on ingest being enabled, and splits product state across two stores ([ADR-0012](../adr/0012-derived-state-in-postgres.md)) |
| Materialising `ALERTS` as stored samples in Postgres | 500k instances × 1 sample/min is 7 × 10⁸ rows/day; intervals give the same answers at transition volume |
| SLO burn via mandatory PulsusDB recording rules (the draft) | The ruler is off by default (ALR-004 requires evaluation with it disabled); kept only as an opt-in accelerator |
| A direct heartbeat ping from a singleton (the draft) | Masks an evaluator or router outage, contradicting ALR-070 |

## 13. Open questions

| # | Question | Leaning |
|---|---|---|
| T16-1 | Incident-grouping thresholds (score 0.45, 15 min, 3 hops) | Tune on the replay corpus and NOC interviews |
| T16-2 | Run evaluator/dispatcher as a separate deployment role | Yes for large tenants; same binary ([T19](T19-deployment.md)) |
| T16-3 | Teams interactivity requirements (bot registration per customer?) | Confirm in M-UI4 |
| T16-4 | Is installing SLO recording rules into a customer's PulsusDB ruler (opt-in, §4.1) acceptable under ADR-0012? It writes rule definitions, not series, but PulsusDB then stores derived series in the customer tenant | Leaning: allow, off by default; product owner to confirm |
| T16-5 | "Pages per on-call shift" (ALR-051) needs shift boundaries; without a synced paging schedule we fall back to calendar days | Confirm the fallback with the product owner |
| T16-6 | The 178-character push limit (ALR-065) awaits product-owner confirmation per 07 | Implement as a configurable constant |
| T16-7 | ALR-042 defines the chrome's `⚠ n` as un-acked incidents for the user's teams; IA-018 defines it as firing alerts relevant to the current Context | Product owner to reconcile; both counters are served |

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft; history moved to Postgres per ADR-0012; aligned with formal 07; formal design rules; Satisfies table |

**Changes versus the draft:**
1. **§4.7 rewritten (ADR-0012).** The draft wrote transitions and notifications as OTLP logs to
   PulsusDB and `ALERTS`/`ALERTS_FOR_STATE` by remote write, with a 30-day Postgres hot copy. Now
   transitions and deliveries live only in Postgres (13-month default retention), and `ALERTS`,
   `ALERTS_FOR_STATE` and the `{source="pulsus-dash", kind=…}` streams (replacing
   `service.name=pulsus-dash`, `pulsus.event.kind=…`) are virtual sources computed by the planner
   and **not written anywhere**. The label contract is fixed here. The Sankey reads Postgres; the
   recovery fallback to `ALERTS_FOR_STATE` in PulsusDB is replaced by Postgres reconciliation.
2. **No ruler dependency.** SLO burn ratios are evaluated by Dash; PulsusDB recording rules are an
   opt-in accelerator only (ALR-004, ALR-087). Anomaly rules read the Postgres-backed
   `pulsus_anomaly_score`, not a written-back series, and stay in Dash after R15.
3. **Heartbeat (ALR-070).** The draft's direct singleton ping is removed, because it would keep the
   heartbeat alive with the evaluator or router stopped. The Watchdog emits a heartbeat outbox event
   every tick.
4. **States, views and flapping** aligned to 07 Tables 3.2 and 3.3: state names and glyphs, severity
   → health, NoData/Error → Unknown with a `stale` flag for keep-last, flapping ≥ 6 transitions per
   60 min with damping until two evaluations agree. New §4.15 alert-set feed for the seven views, ack
   propagation ≤ 1 s, and §4.16 history, ops-metric definitions and the noise report.
5. **Endpoint tiers** re-cut to 07 Table 7.1's v1 (M-UI4) / v2 (M-UI5) split, with native vs recipe
   as the build method: forwarding to an external Alertmanager and webhook-based chat added to v1;
   BMC Helix, Freshservice, Zendesk, Vonage, SNS SMS, Sensu Go and the AI-agent webhook added to v2;
   two-way ITSM sync made explicit.
6. **Page deadline.** The draft added a 5 s RCA hold after a 10 s `group_wait` plus 2 s delivery
   (≈ 17 s). The hold is now capped at first firing + 12 s so the page meets SCN-007's 15 s.
7. **New rules from 07:** evaluation watchdog for rules that stop evaluating (ALR-047), required
   silence reason and expiry nudges (ALR-077), decision rows for muted/silenced/inhibited/coalesced
   notifications (ALR-060, ALR-076), TEST marking (ALR-061), `notify: false` composites (ALR-003),
   sticky human merges (ALR-037), minimum interval 30 s to meet ENT-029.
