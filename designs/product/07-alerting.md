# 07 — Alerting

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Requirement area** | `ALR` |
| **Source draft** | plans/07-alerting.md (not tracked) |
| **Depends on** | [01a](01a-audiences-and-perspectives.md), [02](02-information-architecture.md), [03](03-interaction-model.md), [04](04-surfaces.md), [05](05-visualisation-catalogue.md), [06](06-ai-copilot.md), [09](09-performance-contract.md), [11](11-enterprise.md), [15](15-estate-navigation.md) |
| **Decisions applied** | [ADR-0008](../adr/0008-dash-alert-evaluator.md) (Dash evaluator, Proposed), [ADR-0012](../adr/0012-derived-state-in-postgres.md) (alert history in Postgres, Accepted) |
| **Technical designs** | [T16](../technical/T16-alert-evaluator.md), [T11](../technical/T11-postgres-schema.md), [T07](../technical/T07-scene-query-planner.md), [T18](../technical/T18-security.md) |
| **Mockups** | [09 Alert Lens](../mockups/09-alert-lens.svg) · [10 Alerts list & timeline](../mockups/10-alerts-list-timeline.svg) · [11 Rule editor & backtest](../mockups/11-rule-editor-backtest.svg) · [12 Routing simulator](../mockups/12-routing-simulator.svg) · [01 Landscape map](../mockups/01-landscape-map.svg) · [02 Atlas topology](../mockups/02-atlas-topology.svg) · [03 Infra cluster](../mockups/03-infra-cluster.svg) · [04 Segments matrix](../mockups/04-segments-matrix.svg) · [17 Mobile alert card](../mockups/17-mobile-alert-card.svg) · [18 NOC wall](../mockups/18-noc-wall.svg) |

## 1. Purpose & scope

Principle: **author alerts on the data, prove them against history, page on user impact, and show
alerts where they live in the estate.**

This document specifies what users see and do in alerting:
- the alert model and lifecycle (§3);
- authoring on a chart, with backtest (§4);
- the active-alert views, one alert set projected on seven views (§5);
- alert history: rule, estate and incident (§6);
- notification endpoints, templates, delivery observability and heartbeat (§7);
- routing, escalation, silences, maintenance, mute timings and actions (§8);
- alert hygiene (§9);
- where alerting data is stored (§10).

It does not specify the evaluator's internals (sharding, leader election, grouping score), which
are in [T16](../technical/T16-alert-evaluator.md), or the Postgres DDL, which is in
[T11](../technical/T11-postgres-schema.md). The AI parts of an alert (RCA card, causal sentence,
similar incidents) are specified in [06](06-ai-copilot.md); this document specifies only where they
appear in alerting.

## 2. Definitions

| Term | Meaning |
|---|---|
| **Rule** | A versioned alert definition of one of the kinds in Table 3.1 |
| **Alert instance** (alert) | One rule × label set (or rule × entity, for entity-relative templates), with a lifecycle state |
| **Incident** (`INC-n`) | A group of alerts sharing topology, time and probable origin. Its investigation is `INV-n` ([06](06-ai-copilot.md)) |
| **Health scale** | Healthy, Watch, Degraded, Failing, Unknown, as defined in [01a](01a-audiences-and-perspectives.md) and drawn per [08](08-visual-language.md) |
| **Contact point** | A named fan-out of one or more **integrations** (one endpoint each) with templates and delivery settings |
| **Notification policy tree** | The routing tree that maps an alert's labels and entity to contact points |
| **Silence** | A time-bounded matcher that suppresses notifications for matching alerts |
| **Maintenance window** | A scheduled (one-off or recurring) period, scoped to entities or segments, during which matching alerts are In maintenance |
| **Mute timing** | A recurring quiet period attached to a route |
| **Action** | An operation that changes something outside Dash (revert, rollback webhook, scale, pipeline trigger), run through the audited action framework (§8.6) |
| **Context** | The shared tenant / environment / team / time / entity selection ([02](02-information-architecture.md)) |

## 3. Alert model & lifecycle

### 3.1 Rule kinds

**Table 3.1 — Rule kinds**

| Kind | Typical author | Notes |
|---|---|---|
| **SLO burn-rate** (recommended default) | SRE, service owner | Multi-window multi-burn-rate generated from an SLO definition; pages on budget risk, not blips |
| **Threshold / expression** | Anyone | PromQL / LogQL / TraceQL metrics expression + condition + `for` |
| **Entity-relative template** | Platform | "For every Service of tier-1: error rate > 2% for 5m". Instantiates per entity, so new services are covered automatically |
| **Anomaly** | Anyone | Deviation from learned baseline (seasonal); severity by deviation × impact |
| **Absence / freshness** | Platform | No data from entity / pipeline lag |
| **Journey** | Business-facing | Journey success < X% ([01a](01a-audiences-and-perspectives.md)) |
| **Composite** | SRE | Boolean of other rules ("checkout failing AND payments degraded"); used to page once instead of twice |

#### ALR-001 — All rule kinds
**MUST** · M-UI4 · SRE, Platform, Engineer, Business

Dash MUST support authoring, evaluating and notifying on every rule kind in Table 3.1. The SLO
burn-rate kind MUST be offered as the default when a rule is created from an entity that has an SLO.

*Acceptance:* Given a test tenant, when one rule of each kind in Table 3.1 is created and its
condition is induced on the replay corpus, then each rule reaches Firing and produces a notification;
and when "New alert" is opened on an entity with an SLO, the SLO burn-rate kind is preselected.

#### ALR-002 — Entity-relative templates cover new entities
**MUST** · M-UI4 · Platform

An entity-relative template MUST instantiate on every entity matching its entity selector, including
entities that first appear after the template was saved, without any edit to the rule.

*Acceptance:* Given a template "every tier-1 Service: error rate > 2% for 5m", when a new tier-1
service starts emitting telemetry, then within one entity-catalogue refresh plus one evaluation
interval the template has an instance for it, and the blast-radius count (ALR-014) increases by one.

#### ALR-003 — Composite rules page once
**MUST** · M-UI4 · SRE

A composite rule MUST evaluate a Boolean expression over the states of other rules. When a composite
is routed, its component rules MUST be able to be marked "do not page on their own", so one page is
sent instead of several.

*Acceptance:* Given composite "checkout failing AND payments degraded" with both components marked
"do not page", when both components fire, then exactly one notification is sent (for the composite)
and the components show as Firing in every view with no notification of their own.

#### ALR-004 — Evaluation independent of the PulsusDB ruler
**MUST** · M-UI4 · SRE, Platform

Rules, contact points, routing, silences and maintenance windows MUST be stored in Postgres, and
rules MUST be evaluated by the Pulsus Dash rule evaluator querying PulsusDB
([ADR-0008](../adr/0008-dash-alert-evaluator.md)). The UI MUST NOT expose which evaluator runs a rule
except in rule evaluation health (ALR-047), so evaluation can later move to the PulsusDB ruler (R15 in
[pulsusdb-requirements](../technical/pulsusdb-requirements.md)) without UI change.

*Acceptance:* Given a PulsusDB deployment with its ruler disabled, when rules of every kind are
created, then they evaluate and notify; and no authoring screen contains a control that depends on
the evaluator location.

> **Note:** PulsusDB's ruler evaluates *recording* rules today; it stores alerting rules but only
> evaluates them post-1.0.

### 3.2 Lifecycle states

One vocabulary is used everywhere. Every state is encoded with a glyph, a colour and text, never
colour alone ([08](08-visual-language.md)).

```
            condition true            held for `for`            notified
 ○ Normal ─────────────────► ◔ Pending ─────────────► ● Firing ──────────► (Incident)
    ▲                            │ condition false          │  ack ✓  → ● Firing·Acked
    │                            ▼                          │  silence 🔇 → ● Firing·Silenced
    └──────────── ✓ Resolved ◄───────── keep-firing-for ────┘
 Also: ⊘ NoData · ✖ Error (query failed) · ⏸ Paused (rule disabled) · 🛠 In maintenance
```

**Table 3.2 — Lifecycle states**

| State | Glyph | Enters when | Leaves when |
|---|---|---|---|
| Normal | ○ | Rule created; Resolved has been held for 15 min | Condition becomes true → Pending |
| Pending | ◔ | Condition true | Condition held for `for` → Firing; condition false → Normal |
| Firing | ● | Condition held for `for` | Condition false for `keep-firing-for` → Resolved |
| Firing·Acked | ● ✓ | A user acknowledges a Firing alert | Resolved, or ack is withdrawn |
| Firing·Silenced | ● 🔇 | A matching silence is active | Silence expires or is removed; Resolved |
| Resolved | ✓ | Firing ends after `keep-firing-for` | 15 min elapse → Normal; condition true again → Pending |
| NoData | ⊘ | The query returns no series and the rule's NoData policy is *alert* | Data returns |
| Error | ✖ | The query fails on 2 consecutive evaluations and the rule's Error policy is *alert* | A query succeeds |
| Paused | ⏸ | The rule is disabled | The rule is enabled |
| In maintenance | 🛠 | A matching maintenance window is active | The window ends |

Acked, Silenced and In maintenance are flags on an alert, so an alert can be, for example, Firing,
Acked and In maintenance at once.

#### ALR-005 — One state vocabulary
**MUST** · M-UI4 · NOC, SRE, Platform, Engineer

Every alert view, notification template and API response MUST use the states, glyphs and names of
Table 3.2, and every state MUST be shown with glyph and text in addition to colour.

*Acceptance:* Given one alert in each state of Table 3.2, when it is shown in each of the seven
views (§5), the Lens header, a notification preview and the mobile card, then each rendering shows
the Table 3.2 glyph and name; and with colour removed (greyscale render), every state remains
distinguishable.

#### ALR-006 — Lifecycle transitions
**MUST** · M-UI4 · SRE

The evaluator MUST apply the transitions of Table 3.2, including `for` (pending period),
`keep-firing-for`, and the 15-minute hold of Resolved before Normal, with Prometheus-compatible
semantics for `for` and `keep-firing-for`.

*Acceptance:* Given a rule with `for: 5m` and `keep-firing-for: 2m` over a synthetic series, when the
series crosses the threshold for 4 min, then the alert goes Pending and back to Normal without firing;
when it crosses for 6 min, it fires at 5 min; when it drops below, it stays Firing for 2 min, then
Resolved, then Normal 15 min later. The same series in Prometheus produces the same Pending/Firing
timestamps.

#### ALR-007 — NoData and Error are first-class
**MUST** · M-UI4 · SRE, Platform, NOC

NoData and Error MUST be states with their own per-rule policy: *alert* (enter the state and notify
as its own kind), *ignore*, *keep last state*, or *OK*. Neither MUST ever be shown as Normal or
healthy unless the rule's policy is explicitly *OK*; in all spatial views they MUST render as
Unknown (hatched), consistent with "missing data is never shown as healthy"
([01a](01a-audiences-and-perspectives.md)).

*Acceptance:* Given a rule with NoData policy *alert*, when its source stops reporting, then the
alert enters ⊘ NoData, a notification of kind NoData is sent, and the entity renders hatched Unknown
in Map, Segments and Infra views. Given policy *keep last*, the last state is kept and marked
"(stale)". Given a query that fails twice in a row with Error policy *alert*, the alert enters ✖ Error.

#### ALR-008 — Flapping detection
**MUST** · M-UI4 · SRE, Platform

An alert instance with 6 or more state transitions in the last 60 minutes MUST be flagged as
flapping and shown with a ⇅ badge in every view that shows the alert. The rule MAY enable damping,
which holds notifications until the instance is stable for 2 evaluation intervals. Flapping counts
MUST feed rule history (ALR-045) and the noise report (§9).

*Acceptance:* Given a series that crosses its threshold every 8 minutes, when 6 transitions have
occurred within 60 min, then the alert shows ⇅ in List, Timeline and the Lens header; with damping
on, no further notification is sent until two consecutive evaluations agree.

#### ALR-009 — Severity maps to the health scale
**MUST** · M-UI4 · NOC, SRE, Business

Alert severity MUST map to the health scale as in Table 3.3, and this mapping is how alerts colour
the Atlas and every other view.

**Table 3.3 — Severity to health**

| Severity | Level | Health state |
|---|---|---|
| SEV1 | critical | Failing |
| SEV2 | warning | Degraded |
| SEV3 | warning | Degraded |
| SEV4 | info | Watch |

*Acceptance:* Given one firing alert of each severity on four separate entities, when the Atlas,
Map and Segments views are shown, then the entities render Failing, Degraded, Degraded and Watch
respectively, and an entity with both a SEV1 and a SEV4 alert renders Failing (worst wins).

## 4. Authoring on a chart

```
┌ New alert · from viewport "checkout p99" ──────────────────────────────────────────────────────┐
│ Condition  [ p99 latency ▾ ] [ > ▾ ] [ 1.5 s ]  for [ 5m ]      or  ◉ SLO burn  ○ anomaly     │
│ ┌ Backtest: last 30 days ─────────────────────────────────────────────────────────────────────┐│
│ │ ▁▁▂▁▁▁▃▁▁▁▁▁█▁▁▁▁▂▁▁▁▁▁▁▁▁▁▁▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁█▇▁▁▁▁  ── threshold (drag me) ──────────────  ││
│ │       ▲     ▲                ▲                ▲▲  would have fired 5× (2 matched incidents)  ││
│ └─────────────────────────────────────────────────────────────────────────────────────────────┘│
│ Would have fired: 5 · Matched real incidents: 2/2 · Est. pages/month: 4.3 · Median lead time: 6m│
│ Severity [SEV2 ▾]  Route → team payments (from entity owner) · Runbook [link]  [✦ Suggest]     │
│ Labels/annotations …                                                   [Cancel] [Save rule]    │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

See [mockup](../mockups/11-rule-editor-backtest.svg).

#### ALR-010 — Create alert from every Inspector
**MUST** · M-UI4 · SRE, Engineer, Platform

Every Inspector ([03](03-interaction-model.md)) and every time-series viewport MUST offer "Create
alert", which opens the rule editor prefilled with the viewport's query, entity, Context and a
threshold suggested from the visible data.

*Acceptance:* Given a viewport "checkout p99", when the user chooses "Create alert" from its
Inspector, then the editor opens with the same query and entity, the condition metric set to the
viewport's series, and the backtest already rendered, with no field typed by the user.

#### ALR-011 — Live backtest with draggable threshold
**MUST** · M-UI4 · SRE, Engineer

The rule editor MUST show a backtest over the last 30 days (adjustable) with the threshold drawn as a
draggable line. Dragging the threshold, or changing `for` or the burn windows, MUST update the
backtest: would-have-fired count with markers, matched real incidents (recall, e.g. "2/2"),
estimated pages per month, and median lead time.

*Acceptance:* Given a 30-day backtest for a threshold rule, when the user drags the threshold, then
the fired count, matched-incident ratio, pages/month and median lead time update within one frame
budget of [09](09-performance-contract.md) per change (target < 16 ms on the reference laptop) and
the markers move to the new would-have-fired positions.

> **Rationale:** this is the single biggest improvement over writing rules blind.

#### ALR-012 — AI suggestion of thresholds and windows
**SHOULD** · M-UI4 · SRE, Engineer

The editor SHOULD offer **✦ Suggest**, which proposes thresholds or burn windows from the history
and the team's paging tolerance, shown as a draft the user accepts or edits ([06](06-ai-copilot.md)).

*Acceptance:* Given a team paging tolerance of 4 pages/month, when the user presses ✦ Suggest, then a
threshold is proposed whose backtest shows ≤ 4 est. pages/month with recall of known incidents
displayed, and nothing is saved until the user accepts it.

#### ALR-013 — Notification preview
**MUST** · M-UI4 · SRE, Engineer

The editor MUST offer a right-hand drawer that renders the actual payload (Slack, email, PagerDuty
and every other endpoint the rule would route to) for one backtested firing, using the selected
templates (§7.3).

*Acceptance:* Given a rule routed to a contact point with Slack and email integrations, when the user
opens the preview, then the drawer shows the Slack message and the email exactly as the template
renderer produces them for the chosen backtested firing.

#### ALR-014 — Blast radius for entity-relative templates
**MUST** · M-UI4 · Platform

For entity-relative templates, the editor MUST show how many entities the template instantiates on
and how many would currently be firing (e.g. "instantiates on 143 services; would currently be firing
on 3"). Both lists MUST be clickable.

*Acceptance:* Given a template matching 143 services of which 3 currently breach, when the editor
is open, then it shows "143" and "3"; and clicking "3" lists those three services, each opening its
Lens.

#### ALR-015 — Route and runbook from entity ownership
**MUST** · M-UI4 · SRE, Platform

The editor MUST prefill the route from the entity owner (e.g. "Route → team payments (from entity
owner)") and allow a runbook link, labels and annotations to be set.

*Acceptance:* Given an entity owned by team payments, when a rule is created from it, then the route
field shows "team payments (from entity owner)" before the user edits anything.

## 5. Active alerts: one alert set, seven views

The core idea: **active alerts are a layer, not a page.** The same live alert set, filtered by the
current Context (tenant, environment, team, time), projects onto the estate views of
[15](15-estate-navigation.md), with the same keys, plus List and Timeline.

```
 [ 1 Map ◉ | 2 Topology | 3 City | 4 Infra (cluster) | 5 Segments | 6 List | 7 Timeline ]   Group by: incident ▾
 Filter: env=prod · team=any · sev≥SEV3 · state=firing,pending · ☐ show silenced · ☐ show acked
```

**Table 5.1 — Alert views**

| Key | View | Question it answers | Section |
|---|---|---|---|
| `Alt+1` | Map | Where in the world? | §5.2 |
| `Alt+2` | Topology | How do the alerts relate causally? | §5.5 |
| `Alt+3` | City | Which part of the estate, at a glance? | §5.5 |
| `Alt+4` | Infra (cluster) | Which nodes, pods, hosts? | §5.4 |
| `Alt+5` | Segments | Which slice of the business / estate? | §5.3 |
| `Alt+6` | List | Exactly which alerts, with bulk actions? | §5.6 |
| `Alt+7` | Timeline | What happened when? | §5.7 |

### 5.1 Shared behaviour

#### ALR-016 — One alert set across views
**MUST** · M-UI4 · NOC, SRE, Platform

All seven views of Table 5.1 MUST show the same alert set, filtered by the same Context and alert
filter (environment, team, severity, state, show silenced, show acked). A segmented control and
`Alt+1` … `Alt+7` MUST switch between views. Selection and filters MUST carry across views.

*Acceptance:* Given filter `env=prod · sev≥SEV3 · state=firing,pending` and a selected incident
INC-2041, when the user presses `Alt+1` through `Alt+7` in turn, then every view shows the same
incident count, INC-2041 remains selected in each, and the filter chips are unchanged.

#### ALR-017 — Animated morph between views
**MUST** · M-UI4 · NOC, SRE

Switching between alert views MUST animate a morph in which each selected or alerting item moves from
its position in the old view to its position in the new one, so the eye can follow an alert. The
morph MUST meet the view-transition budget of [09](09-performance-contract.md) (250 ms).

*Acceptance:* Given a selected alert in the Map view, when the user presses `Alt+4`, then the alert's
mark moves continuously to its cell in the Infra grid within 250 ms with no blank frame; with reduced
motion enabled, the switch is a cross-fade.

#### ALR-018 — Container aggregation
**MUST** · M-UI4 · NOC, SRE, Platform

In every spatial view (Map, Topology, City, Infra, Segments), a container (region, cluster, segment
cell, super-node) MUST show:
- the **worst** health state among its contents;
- a count badge `⚠ n` of **incidents**, not raw alerts, with the alert count on hover
  ("2 incidents · 14 alerts");
- a salience ring for un-acked items that escalates from glow to pulse while nobody owns them
  ([08](08-visual-language.md)).

*Acceptance:* Given region eu-west-1 containing 14 alerts in 2 incidents, one un-acked, when the Map
is shown, then the region shows the worst state, badge `⚠ 2`, hover text "2 incidents · 14 alerts",
and a ring that glows and then pulses until the incident is acked.

#### ALR-019 — Show what still needs a human
**MUST** · M-UI4 · NOC, SRE

Acked items MUST be drawn desaturated, and silenced items MUST be hidden unless the filter "show
silenced" is on, so the screen shows what still needs a human, not everything that is wrong.

*Acceptance:* Given three firing incidents, one acked and one silenced, when the default filter is
used, then one incident renders at full salience, one desaturated, and the silenced one is absent;
ticking "show silenced" makes it appear with 🔇.

#### ALR-020 — Acknowledge from any alert view
**MUST** · M-UI4 · SRE, NOC

An operator MUST be able to acknowledge a focused alert or incident from every alert view, from the
Alert Lens and from the mobile card with `Shift+A` (or the Ack control). The ack MUST propagate to
every view and every collaborator and be written to the audit log ([11](11-enterprise.md)).

*Acceptance:* Given a firing alert shown in the Map view, when the operator focuses it and presses
`Shift+A`, then the alert enters Acknowledged within 1 s in every view and for every collaborator, the
NOC wall salience drops, the Slack message updates to "ACK <name>", and the action is in the audit
log.

#### ALR-021 — Historical replay of every view
**MUST** · M-UI4 · NOC, SRE, IC

Every view in §5 MUST also work historically: moving the Time Ribbon into the past MUST replay the
alert state as it was at that moment, from alert history (§10).

*Acceptance:* Given an incident at 03:12 yesterday, when the user drags the ribbon to 03:12, then the
Map, Segments and Infra views show the alert states as they were at 03:12 (verified against the
transition log), and a "history" badge is shown in the chrome.

### 5.2 Map (`Alt+1`): where in the world

```
┌ Alerts · Global ───────────────────────────────────────────────────────────────────────────────┐
│        ╭──────╮                                   ╭──────╮                                      │
│        │us-w-2│ ●                                 │eu-w-1│ ● ⚠2  ◀── pulsing (un-acked SEV2)    │
│        ╰──────╯                 ╭──────╮          ╰──┬───╯                                      │
│                    ╭──────╮     │us-e-1│ ◐            ╲  ━━━ red arc: cross-region calls failing  │
│                    │sa-e-1│ ●   ╰──────╯               ╲                                        │
│                    ╰──────╯                     ╭──────╮╲  ╭──────╮                             │
│                                                 │me-c-1│ ● │ap-s-1│ ○ ⊘ NoData (stale 6 min)    │
│                                                 ╰──────╯   ╰──────╯                             │
│ ┌ Region strip ───────────────────────────────────────────────────────────────────────────────┐ │
│ │ eu-west-1 ● ⚠2 (SEV2, SEV3) · us-east-1 ◐ · ap-south-1 ○ NoData · 9 others ●               │ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

See [mockup](../mockups/01-landscape-map.svg). The Map is the NOC wall default and serves execs and
multi-region SREs: it answers "is it everywhere or one region?" in one glance, the first triage
question after "how bad".

#### ALR-022 — Map content
**MUST** · M-UI4 · NOC, SRE, Business

The Map MUST plot regions, zones, PoPs, data centres and edge sites from entity geo attributes or
the cloud-region gazetteer ([05](05-visualisation-catalogue.md)), with a region strip listing each
region's state and incident count. It MUST draw **arcs** for cross-region dependencies that are
alerting (replication lag, failover traffic, CDN → origin). It SHOULD offer customer-impact heat
(RUM / Journey failures by user geo) as an optional underlay.

*Acceptance:* Given alerts in eu-west-1 and a failing cross-region call from eu-west-1 to
ap-south-1, when the Map is shown, then both regions are plotted at their gazetteer positions, the
region strip lists "eu-west-1 ● ⚠2 (SEV2, SEV3)", and an arc joins the two regions in the failing
colour.

#### ALR-023 — Map semantic zoom
**MUST** · M-UI4 · NOC, SRE

Zooming the Map MUST reveal availability zones and then clusters, fading in as the camera approaches.
Double-clicking a region MUST open the Infra view (§5.4) for that region.

*Acceptance:* Given the Map at world zoom, when the user zooms into eu-west-1, then AZs fade in and
then clusters; when the user double-clicks the region, the Infra view opens scoped to eu-west-1.

#### ALR-024 — Dark region is never healthy
**MUST** · M-UI4 · NOC

A region whose telemetry is stale MUST render as ○ NoData, hatched, with the staleness (e.g. "stale 6
min"). A region with no data MUST NOT render as healthy.

*Acceptance:* Given ap-south-1 with no telemetry for 6 minutes, when the Map is shown, then the region
is hatched with "⊘ NoData (stale 6 min)" and the region strip lists "ap-south-1 ○ NoData".

### 5.3 Segments (`Alt+5`): which slice of the business / estate

```
┌ Alerts · Segments    rows: [team ▾]   cols: [environment ▾]   cell: worst state + incidents ───┐
│                 prod-eu      prod-us      prod-ap      staging     dev                          │
│ payments        ● ⚠1 ✚      ●            ●            ◐           ●                            │
│ checkout        ● ⚠1 (victim)●           ●            ●           ●                            │
│ search          ●            ◐ ⚠1        ●            ●           ●                            │
│ platform-k8s    ●            ●            ○ NoData    ●           ● ⚠3 (sev4, muted)           │
│ data            ●            ●            ●            ●           ●                            │
│ ─────────────── column totals:  2 incidents · 1 · 0 (1 NoData) · 0 · 3 low ────────────────── │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

See [mockup](../mockups/04-segments-matrix.svg).

**Table 5.2 — Segment dimensions** (from the entity schema, [02](02-information-architecture.md))

| Group | Dimensions |
|---|---|
| Location & account | environment, region / zone, cloud account / subscription / project |
| Platform | cluster, namespace, team / owner, service tier |
| Business | Journey, customer segment / plan / tenant, business unit |
| Technology | technology (db / queue / cache / runtime) |
| Alert | severity, alert kind |

**Table 5.3 — Saved segmentations (Perspective defaults)**

| Perspective | Rows × columns |
|---|---|
| NOC | region × tier |
| Platform | cluster × namespace |
| Business | Journey × market |
| Support | customer plan × Journey |
| Engineering manager | team × severity |

#### ALR-025 — Segment matrix
**MUST** · M-UI4 · NOC, Platform, Business, Support

The Segments view MUST show any two dimensions of Table 5.2 as rows × columns, each cell coloured by
worst state and carrying its incident count, with column totals. Dragging a dimension chip onto an
axis MUST re-pivot the matrix with an animated transition.

*Acceptance:* Given rows=team, cols=environment, when the user drags the "region" chip onto the
columns axis, then the matrix re-pivots with animation, every cell shows worst state + incident
count, and the totals row updates.

#### ALR-026 — Perspective default segmentations
**MUST** · M-UI5 · NOC, Platform, Business, Support

Each Perspective MUST open the Segments view with its saved segmentation from Table 5.3, and users
MUST be able to save further segmentations.

*Acceptance:* Given the Platform Perspective, when the Segments view opens, then rows are cluster and
columns namespace; switching to the NOC Perspective shows region × tier.

#### ALR-027 — Victim-aware cells
**MUST** · M-UI4 · NOC, SRE

A cell whose alerts are all downstream victims of an incident whose origin is elsewhere MUST be
drawn **dashed** with "(victim)", so the eye lands on the origin cell.

*Acceptance:* Given INC-2041 with origin in payments and victims in checkout, when the team ×
environment matrix is shown, then the checkout/prod-eu cell is dashed with "(victim)" and the
payments/prod-eu cell is solid.

#### ALR-028 — Ranked list and treemap modes
**MUST** · M-UI4 · NOC, Business

With only one dimension selected, the matrix MUST become a **ranked bar list** in "care" order
([01a](01a-audiences-and-perspectives.md)). A treemap mode (area ∝ entity count or traffic, colour =
state) MUST be available for unbalanced segments.

*Acceptance:* Given cols cleared to leave rows=team, then the view shows bars ranked by care score;
when treemap mode is chosen with area=traffic, rectangles are sized by traffic and coloured by state.

#### ALR-029 — Silence or maintain from a cell
**MUST** · M-UI4 · NOC, Platform

A segment cell (and an Infra group, §5.4) MUST offer "Silence…" and "Maintenance window…" prefilled
with the cell's matchers (e.g. `node-pool=gpu`).

*Acceptance:* Given a cell team=platform-k8s × env=dev, when the user chooses "Silence…", then the
silence editor opens with matchers `team=platform-k8s, env=dev` and the preview of matching alerts
(ALR-077).

### 5.4 Infra / cluster detail (`Alt+4`): down to the pod or host

```
┌ Alerts · Cluster prod-eu-1 (k8s) · colour: worst alert / health · size: CPU req ─────────────────┐
│ ╭ node pool: general (42 nodes) ─────────────────╮ ╭ node pool: memory (12) ─╮ ╭ gpu (4) ─╮     │
│ │ ⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡  ⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡⬡              │ │ ⬡⬡⬡⬡⬡⬡ ⬢⬢ ⬡⬡⬡⬡         │ │ ⬡⬡⬡⬡     │     │
│ │ ⬡⬡⬡⬡⬡⬡⬡⬡⬢⬡⬡⬡⬡⬡  ← node ip-10-4-7 DiskPressure │ │       ↑ 2 nodes NotReady│ │          │     │
│ ╰────────────────────────────────────────────────╯ ╰─────────────────────────╯ ╰──────────╯     │
│ Zoom ▸ node → pods:  ip-10-4-7  [■ payments-7f9 ● OOMKilled ×3] [■ checkout-a1 ●] [■ …]         │
│ Group by: [node pool ▾ | namespace | workload | zone]   Colour: [alerts ▾ | CPU | mem | restarts]│
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

See [mockup](../mockups/03-infra-cluster.svg).

**Table 5.4 — Infra hierarchies**

| Estate | Hierarchy | Alternative grouping |
|---|---|---|
| Kubernetes | cluster → node pool / zone → node → pod → container | namespace → workload (same pods) |
| VMs / hosts | DC / region → rack / AZ → host → process | — |
| Managed services | account → service type → instance (RDS, MSK, ElastiCache…) | — |

**Table 5.5 — Infra encodings**

| Channel | Encodes |
|---|---|
| Colour | Worst alert state, or a switchable USE metric (CPU, memory, restarts) |
| Size | Capacity (e.g. CPU requests) |
| Ring | Un-acked salience |
| ◆ | Recent rollout on that workload |

#### ALR-030 — Infra heat grid
**MUST** · M-UI4 · Platform, NOC

The Infra view MUST show every instance as a cell in a semantic-zoom hexbin wall
([05](05-visualisation-catalogue.md)) nested by the hierarchies of Table 5.4 and encoded per Table
5.5. Kubernetes and VM/bare-metal estates MUST use the same component. Group-by (node pool,
namespace, workload, zone) and colour (alerts, CPU, mem, restarts) MUST be switchable.

*Acceptance:* Given cluster prod-eu-1 with three node pools, when the Infra view opens, then nodes
are grouped by pool with counts; zooming into node ip-10-4-7 shows its pods with states (e.g.
"payments-7f9 ● OOMKilled ×3"); switching group-by to namespace re-groups the same pods by
namespace → workload.

#### ALR-031 — Workload-targeted alerts outline their pods
**MUST** · M-UI4 · Platform

An alert that targets a workload (e.g. "deployment replicas unavailable") MUST highlight all of the
workload's pods and outline the group.

*Acceptance:* Given an alert on deployment payments, when the Infra view is grouped by node pool,
then every payments pod is highlighted wherever it runs and an outline joins them.

#### ALR-032 — Infra scale
**MUST** · M-UI4 · Platform, NOC

The Infra view MUST render 100 000 cells at 60 fps on the reference hardware of
[09](09-performance-contract.md), with level of detail collapsing to node-level and then pool-level
squares as the camera zooms out.

*Acceptance:* Given a synthetic estate of 100 000 pods, when the user pans and zooms continuously for
10 s, then p95 frame time is ≤ 16.7 ms, and at the widest zoom cells are drawn as pool-level squares.

#### ALR-033 — Lasso and compare
**MUST** · M-UI4 · Platform

Lassoing a set of cells and pressing `B` MUST run Universal Compare on the selected instances
against the rest, reporting the distinguishing attributes (e.g. "the 9 failing nodes are all
`m6i.4xlarge` in `eu-west-1b` running kernel 6.8.0-1021").

*Acceptance:* Given 9 failing nodes that share instance type, zone and kernel, when the user lassos
them and presses `B`, then the Compare result ranks those three attributes first, with a coverage
meter.

### 5.5 Topology (`Alt+2`) and City (`Alt+3`): how alerts relate

Topology is the Atlas ([04](04-surfaces.md), [15](15-estate-navigation.md)) with the alert layer
emphasised; this is where 14 alerts visibly become one problem. See
[mockup](../mockups/02-atlas-topology.svg). City is the estate's City layout from
[15](15-estate-navigation.md) with the same alert layer.

#### ALR-034 — Alert layer on Topology
**MUST** · M-UI4 · SRE, NOC, IC

The Topology view MUST show ⚠ badges on alerting nodes and edges, the probable origin ⊕ glowing,
victims with dashed rings, and each incident's boundary as a translucent hull around its affected
subgraph labelled with its id (e.g. `INC-2041`). `X` (anomalous subgraph only) MUST be on by default
when the view is opened.

*Acceptance:* Given INC-2041 with 14 alerts across 4 services, when `Alt+2` is pressed, then only the
anomalous subgraph is shown, one hull labelled INC-2041 encloses the 4 services, psp-api shows ⊕, and
checkout and gateway show dashed rings.

#### ALR-035 — Alert layer on City
**MUST** · M-UI4 · NOC, Platform

The City view MUST apply the aggregation rule (ALR-018) and the victim/origin encodings to its
districts and buildings.

*Acceptance:* Given INC-2041, when `Alt+3` is pressed, then the payments district shows the worst
state and `⚠ 1`, and victim buildings are dashed.

### 5.6 List (`Alt+6`): the precise, keyboard-driven view

The List is the Explorer with alert columns: a Table ([05](05-visualisation-catalogue.md)),
DOM-rendered, for people who work by keyboard and for bulk actions. See
[mockup](../mockups/10-alerts-list-timeline.svg).

```
┌ Alerts · List   Group: [Incident ▾ | Rule | Entity | Team | None]   Sort: care ▾   312 alerts / 9 incidents ┐
│ ▾ INC-2041 SEV2 Checkout degraded       ⊕ payments→psp-api   ≈2 900 users  👤Sam ✓  11m  ↘ improving  │
│     ● HighErrorRate        checkout     err 4.1% > 2%      firing 9m   ⇢ victim                       │
│     ● EdgeFailures         payments→psp 38% > 5%           firing 11m  ⊕ origin                       │
│     ◔ LatencyBurn          gateway      burn 6×            pending 1m                                  │
│     … 11 more (collapsed)                                                                              │
│ ▸ INC-2042 SEV3 search p99 burn (us)    ⊕ search-index      —          unowned ◉  3m  ↗ rising        │
│ ▸ — ungrouped (4)                                                                                     │
│ [x] select  [⇧A] ack  [S] silence…  [M] merge into incident  [U] split  [O] assign owner  [Enter] open │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Table 5.6 — List columns**

| Column | Content |
|---|---|
| State | Glyph per Table 3.2, with ⇅ when flapping |
| Severity | SEV1–SEV4 |
| Rule | Rule name |
| Entity | Entity chip with hover Lens |
| Value vs threshold | e.g. "err 4.1% > 2%" |
| Age | Time in current state |
| Owner / ack | Owner, acking user |
| Trend | Sparkline and ↗ / ↘ |
| Role | ⊕ origin / ⇢ victim |
| Incident | `INC-n` |
| Labels | Pill cell |
| Silence | Silencing silence id |
| Notification status | ✓ delivered / ✖ failed / ⏳ retrying, per endpoint (§7.4) |

**Table 5.7 — List keys**

| Key | Action |
|---|---|
| `x` | Select row |
| `Shift+A` | Acknowledge |
| `S` | Silence… (with preview of matches) |
| `M` | Merge into incident |
| `U` | Split from incident |
| `O` | Assign owner |
| `Enter` | Open (Alert Lens) |

#### ALR-036 — List columns and grouping
**MUST** · M-UI4 · SRE, NOC

The List MUST offer the columns of Table 5.6 and grouping by incident (default), rule, entity,
team, label key, or none (the raw Alertmanager-style view, for experts), with sort by care by
default.

*Acceptance:* Given 312 alerts in 9 incidents, when the List opens, then it is grouped by incident
with the header "312 alerts / 9 incidents"; choosing Group: None shows 312 flat rows; every column of
Table 5.6 is available.

#### ALR-037 — List keyboard and bulk actions
**MUST** · M-UI4 · SRE, NOC

The List MUST support the keys of Table 5.7 and bulk actions on a multi-row selection: ack, silence
(with a preview of matches), assign, merge/split incidents, add to Investigation, and export.
Human merges and splits MUST be sticky: automatic grouping MUST NOT undo them.

*Acceptance:* Given three alerts selected with `x`, when the user presses `M` and picks INC-2041,
then the three alerts move into INC-2041 and stay there after subsequent grouping runs; pressing
`Shift+A` on the selection acks all three.

#### ALR-038 — Saved alert views
**MUST** · M-UI4 · SRE, NOC

The List MUST ship the saved views "My team's firing", "Unowned SEV1–2", "NoData everywhere" and
"Silenced, expiring < 1 h", and allow users to save their own.

*Acceptance:* Given a silence expiring in 40 min, when the user opens "Silenced, expiring < 1 h",
then the alerts it silences are listed and a silence expiring in 2 h is not.

### 5.7 Timeline (`Alt+7`): what happened when

#### ALR-039 — Incident swimlanes
**MUST** · M-UI4 · SRE, IC, NOC

The Timeline MUST show one swimlane per incident, expandable to its alerts, with state bars
(pending / firing / acked / silenced) and ◆ deploys, ⚙ changes and 📣 notifications overlaid on the
same axis. It is the First Light view ([04](04-surfaces.md)) for the whole estate. Dragging the Time
Ribbon left MUST turn the live view into history (§6) without leaving the view.

*Acceptance:* Given INC-2041, when the Timeline opens, then its lane shows pending and firing bars, a
⚙ at 12:19, 📣 glyphs at each notification, and expanding it shows one sub-lane per alert; dragging
the ribbon to yesterday shows yesterday's incidents in the same view.

### 5.8 Alerts everywhere else

**Table 5.8 — Alerts outside the alert views**

| Place | How alerts show |
|---|---|
| Every time-series viewport | Firing intervals as a tinted band along the x-axis; threshold line; ⚠ glyph at onset |
| Lens header | Active alerts for the entity and its dependencies (with victim/origin role) |
| Breadcrumb / entity chip | Health dot already reflects alert severity |
| Global chrome | `⚠ n` = incidents needing you (your teams, un-acked); click opens List filtered to you |
| Home | "Firing for your teams" strip |
| NOC wall | Global or Segments view + incident queue, with salience ([04](04-surfaces.md)); see [mockup](../mockups/18-noc-wall.svg) |
| Mobile PWA | Incident list → Alert Lens; ack/silence/escalate; push notifications; see [mockup](../mockups/17-mobile-alert-card.svg) |

#### ALR-040 — Alerts in viewports
**MUST** · M-UI4 · SRE, Engineer

Every time-series viewport whose series is covered by a rule MUST show that rule's firing intervals
as a tinted band along the x-axis, its threshold line, and a ⚠ glyph at each onset.

*Acceptance:* Given a rule on checkout error rate that fired twice in the window, when a viewport of
that series is open, then two tinted bands, the threshold line and two ⚠ glyphs are drawn at the
transition timestamps.

#### ALR-041 — Alerts in Lens, chips and Home
**MUST** · M-UI4 · SRE, Engineer, Platform

The Lens header MUST list active alerts for the entity and its dependencies with victim/origin role;
breadcrumbs and entity chips MUST reflect alert severity in their health dot (Table 3.3); Home MUST
show a "Firing for your teams" strip.

*Acceptance:* Given a SEV2 firing alert on payments, when the payments Lens, a breadcrumb containing
payments and Home (for a payments team member) are shown, then the Lens header lists the alert with
"⊕ origin", the chip dot is Degraded, and Home's strip lists the incident.

#### ALR-042 — Global incident counter
**MUST** · M-UI4 · SRE, Engineer, NOC

The global chrome MUST show `⚠ n`, where n is the number of un-acked incidents for the user's teams.
Clicking it MUST open the List filtered to those incidents.

*Acceptance:* Given 2 un-acked and 1 acked incident for the user's teams, when the chrome is shown,
then it reads `⚠ 2`; clicking it opens the List showing exactly those 2.

#### ALR-043 — NOC wall alerts
**MUST** · M-UI4 · NOC

The NOC wall MUST show the Map or Segments view plus an incident queue with salience
([04](04-surfaces.md)).

*Acceptance:* Given a wall playlist with the NOC Perspective, when an un-acked SEV2 incident opens,
then it appears in the queue and on the Map with the salience ring; after ack its salience drops.

#### ALR-044 — Mobile alert handling
**MUST** · M-UI4 · SRE, IC

The mobile PWA MUST show an incident list that opens the Alert Lens card, allow ack, silence and
escalate from it, and receive push notifications (§7.1). Its offline behaviour is specified in T20
(draft).

*Acceptance:* Given a SEV2 page delivered by PWA push, when the user taps it, then the Alert Lens card
opens; tapping Ack acks the incident and every desktop view reflects it within 1 s.

## 6. Alert history

Three questions, three views. All are driven by the Time Ribbon, so "history" is simply moving the
window into the past (ALR-021). History is read from Postgres (§10).

### 6.1 Rule history: "how does this rule behave?"

```
┌ Rule · HighErrorRate (checkout) · last 30 d ───────────────────────────────────────────────────┐
│ value    ▁▁▂▁▁▃▁▁▁▁▁█▁▁▁▂▁▁▁▁▁▁▁▃▁▁▁▁▁▁▁▁▁▁▁▁█▇▁   ── threshold 2%                              │
│ state    ───────────▮──────────────────────────▮▮──    ▮ firing  ▯ pending  ░ silenced  ⊘ nodata  │
│ notified          📣Slack 📣PD                  📣Slack 📣PD (ack 1m)                              │
│ changes  ✎ rule edited 11-02 (threshold 3%→2%) by Priya                                           │
│ Fired 3× · median duration 14 m · MTTA 1.2 m · MTTR 18 m · 0 no-action · flaps 0 · last eval 4s ago ✓│
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### ALR-045 — Rule history view
**MUST** · M-UI4 · SRE, Engineer

Each rule MUST have a history view with, on one time axis: the evaluated value with threshold, the
state band (firing, pending, silenced, nodata), notifications per endpoint with ack time, and rule
edits (✎ with diff summary and author). A summary line MUST show fired count, median duration, MTTA,
MTTR, no-action count, flap count and last evaluation (age and status).

*Acceptance:* Given rule HighErrorRate edited on 11-02 from 3% to 2% and fired 3× in 30 d, when its
history opens, then the ✎ marker at 11-02 reads "threshold 3%→2% by Priya", three firing bars and
their 📣 glyphs are shown, and the summary line values match the transition and delivery records.

#### ALR-046 — Rule versions and before/after backtest
**MUST** · M-UI4 · SRE, Engineer

Every rule version MUST be stored. From a rule edit marker, a before/after backtest of the two
versions over the same window MUST be one click away, so "did my change reduce noise?" is
answerable.

*Acceptance:* Given two versions of a rule, when the user clicks the ✎ marker and "Compare backtest",
then both versions' would-have-fired counts and pages/month over the same window are shown side by
side.

#### ALR-047 — Per-instance breakdown and evaluation health
**MUST** · M-UI4 · SRE, Platform

For multi-dimensional rules, rule history MUST offer a per-instance breakdown (one row per label set
or entity) as a status history grid ([05](05-visualisation-catalogue.md)). It MUST show evaluation
health: evaluation duration, errors and missed evaluations. A rule that silently stops evaluating
MUST itself raise an alert.

*Acceptance:* Given a rule whose evaluations are skipped for 3 intervals, when its history is open,
then missed evaluations are marked, and a "rule not evaluating" alert fires to the rule's fallback
route.

### 6.2 Estate history: "what has been going on?"

#### ALR-048 — Calendar heatmap of incidents
**MUST** · M-UI4 · SRE, Platform, IC

Estate history MUST offer a calendar heatmap of incidents per day by team or segment, over a range
of 1 week to 1 year, showing the seasonality of pain (Monday deploys, month-end batch).

*Acceptance:* Given 12 months of incident history, when the calendar is set to 1 year and grouped
by team, then each day cell's count equals the number of incidents opened that day for that team.

#### ALR-049 — Transition explorer
**MUST** · M-UI4 · SRE, Platform

Estate history MUST offer a transition explorer: every state transition in the window as a log-style
stream, filterable by rule, entity, team, severity and state, with columns time, from → to, value,
labels and notified endpoints. It MUST be rendered with the GPU log stream
([05](05-visualisation-catalogue.md)) so that 10⁶ transitions scroll smoothly, and MUST show patterns
(e.g. "top flapping rules") above the stream.

*Acceptance:* Given 1 million transitions in the window, when the user scrolls the stream at full
speed, then p95 frame time is ≤ 16.7 ms; filtering to state=Firing updates the stream and the "top
flapping rules" panel.

#### ALR-050 — Segment trends
**MUST** · M-UI4 · Platform, NOC, Business

Estate history MUST offer the Segments matrix aggregated over a period, with cells showing
incident-hours instead of live state ("where do we spend our pain?").

*Acceptance:* Given last month as the window, when segment trends are shown for team × environment,
then each cell shows summed incident-hours that match the incident records.

#### ALR-051 — Ops metrics
**MUST** · M-UI4 · SRE, Platform, IC

Estate history MUST show, per team over time: MTTA and MTTR (median and p90); pages per on-call shift
and out-of-hours pages; alerts per incident (the grouping ratio); and % actionable. These feed the
noise report (§9).

*Acceptance:* Given a team's last 90 days, when ops metrics are shown, then each metric is plotted per
week and its values match a reference computation over the transition and delivery records.

### 6.3 Incident history: "have we seen this before?"

#### ALR-052 — Incident archive
**MUST** · M-UI4 · SRE, IC, Engineer

Dash MUST provide a searchable incident archive table with root-cause category, origin entity,
duration, impact, post-mortem link and flight-recorder link.

*Acceptance:* Given 200 past incidents, when the user searches "psp-api", then incidents whose origin
entity or root cause mentions psp-api are listed with all six columns populated.

#### ALR-053 — Similar incidents in the Alert Lens
**MUST** · M-UI4 · SRE, IC

The similar-incident match from RCA ([06](06-ai-copilot.md)) MUST appear in the Alert Lens (e.g.
"looks like INC-1733, resolved by reverting a config"), linking to that incident.

*Acceptance:* Given an incident whose embedding is closest to INC-1733, when its Alert Lens opens,
then the similar-incident line names INC-1733 and its resolution and links to it.

#### ALR-054 — Past incidents reopen in full
**MUST** · M-UI4 · SRE, IC, Engineer

Every past incident MUST reopen in full: its Context, evidence ledger and replayable flight recorder,
not a static post-mortem document.

*Acceptance:* Given INC-1733 from March, when it is opened from the archive, then its Investigation
INV-1733 opens with the original Context, every evidence item can be re-run "as of then", and the
flight recorder scrubs.

## 7. Notification endpoints (contact points)

### 7.1 Endpoint catalogue

The aim is parity with the contact points of existing alerting systems (including Alertmanager), plus enterprise ITSM and automation.
**v1** ships at M-UI4; **v2** ships at M-UI5.

**Table 7.1 — Endpoint catalogue**

| Category | Endpoints | Interactive (two-way)? | Tier |
|---|---|---|---|
| **Chat** | Slack (app, with buttons), Microsoft Teams (app / workflows webhook), Google Chat, Mattermost, Cisco Webex, Discord, Telegram, Rocket.Chat, Zulip | Slack & Teams: ack / silence / open RCA / assign from the message; updates edit the same message in place | Slack, Teams, Google Chat, Webhook-based chat **v1**; others **v2** |
| **Regional chat** | DingTalk, WeCom, Feishu/Lark, LINE, Threema | — | **v2** (parity with existing alerting systems) |
| **Paging / on-call** | PagerDuty (Events v2), Atlassian JSM Operations (and Opsgenie, which is end-of-life), Splunk On-Call (VictorOps), incident.io, Rootly, FireHydrant, xMatters, Squadcast, Zenduty, Better Stack, other external on-call / incident tools | Ack/resolve sync both ways where the API allows | PagerDuty, JSM/Opsgenie, incident.io **v1**; others **v2** |
| **ITSM / ticketing** | ServiceNow (incident + event management, CMDB CI linking), Jira / JSM (create & transition issues), BMC Helix, Freshservice, Zendesk (for support-facing Journeys) | Ticket status ↔ incident status | ServiceNow, Jira **v1**; others **v2** |
| **Email** | SMTP (TLS, auth), Amazon SES, SendGrid; HTML + plain-text templates; digest mode | — | **v1** |
| **SMS / voice** | Twilio (SMS, voice call with TTS and press-1-to-ack), Vonage, Amazon SNS SMS | Voice ack via DTMF | **v2** |
| **Push** | Pulsus mobile PWA web push, Pushover, ntfy | Ack from the notification | PWA push **v1**; others **v2** |
| **Generic / bus** | Webhook (templated body, HMAC signing, mTLS, custom headers, OAuth2 client credentials), **Alertmanager-compatible webhook** (drop-in for existing receivers), forwarding to an external Alertmanager, Kafka (native producer), MQTT, AWS SNS / EventBridge, GCP Pub/Sub, Azure Event Grid / Service Bus, Sensu Go | — | Webhook, Alertmanager, Kafka **v1**; others **v2** |
| **Automation** | GitHub Actions `repository_dispatch`, GitLab pipeline trigger, Rundeck / PagerDuty Process Automation, Ansible AWX/AAP job templates, Argo Workflows, StackStorm. Listed as endpoints, but each runs through the action framework (§8.6) | Result posted back to the incident timeline | **v2** (generic webhook covers v1) |
| **Status pages** | Atlassian Statuspage, Better Stack, instatus, Pulsus' own public status page | Draft only: a human publishes, and the AI-drafted Business-Perspective text is pre-filled ([06](06-ai-copilot.md)) | **v2** |
| **AI agents** | MCP push / outbound webhook to an external agent (e.g. a customer's own runbook agent), carrying the RCA card as structured data | — | **v2** |

> **Note:** the PWA web-push handler in the service worker counts against the JS shim's
> browser-integration budget ([ADR-0001](../adr/0001-rust-wasm-everywhere.md),
> [T03](../technical/T03-browser-runtime.md)). The push payload is a binary envelope rendered in
> Rust on the server, so the service worker parses nothing (T20 (draft)).

#### ALR-055 — v1 endpoints
**MUST** · M-UI4 · SRE, NOC, Platform, Admin

Every endpoint marked **v1** in Table 7.1 MUST be available as a contact-point integration:
Slack, Microsoft Teams, Google Chat, webhook-based chat, PagerDuty, JSM Operations / Opsgenie,
incident.io, ServiceNow, Jira, email (SMTP, SES, SendGrid, with digest mode), Pulsus PWA push,
generic webhook (templated body, HMAC, mTLS, custom headers, OAuth2 client credentials),
Alertmanager-compatible webhook, forwarding to an external Alertmanager, and Kafka.

*Acceptance:* Given a contact point with one integration of each v1 type pointed at contract-test
receivers, when a test alert fires, then every receiver gets a payload that validates against that
provider's recorded contract.

#### ALR-056 — v2 endpoints
**SHOULD** · M-UI5 · SRE, NOC, Platform, Admin

Every endpoint marked **v2** in Table 7.1 SHOULD be available as a contact-point integration.

*Acceptance:* Given a contact point with one integration of each v2 type pointed at contract-test
receivers, when a test alert fires, then every receiver gets a valid payload (status pages receive a
draft, not a publication).

#### ALR-057 — Interactive chat messages
**MUST** · M-UI4 · SRE, NOC

Slack and Microsoft Teams integrations MUST support ack, silence, open RCA and assign from the
message, and MUST edit the same message in place as the incident evolves (acked, origin found,
resolved) rather than posting new messages.

*Acceptance:* Given a page posted to Slack, when a user presses Ack in Slack, then the incident is
acked in Dash under that user's linked identity (audit-logged), and the original message is edited to
show "ACK <name>"; when the incident resolves, the same message is edited to Resolved.

#### ALR-058 — Two-way sync with paging and ITSM
**MUST** · M-UI4 · SRE, IC

Paging integrations MUST sync ack/resolve in both directions where the provider API allows, and ITSM
integrations MUST sync ticket status with incident status.

*Acceptance:* Given an incident paged to PagerDuty and ticketed in ServiceNow, when it is acked in
PagerDuty, then it is acked in Dash within 10 s; when it is resolved in Dash, the PagerDuty incident
resolves and the ServiceNow ticket transitions to resolved.

#### ALR-059 — Existing contact point import
**MUST** · M-UI4 · Admin, Platform

Existing contact points, from the alerting provisioning API or YAML of existing alerting systems, MUST import 1:1 for every type in
Table 7.1 that is available at the time of import, and the import report MUST list anything
unmapped.

*Acceptance:* Given an existing alerting export with Slack, PagerDuty, email and one LINE contact point before
v2 ships, when it is imported, then the first three are created with identical settings and the
report lists LINE as unmapped.

### 7.2 Contact point editor

```
┌ Contact point · payments-oncall ───────────────────────────────────────────── health ● OK ─┐
│ Integrations (fan-out, all receive):                                                         │
│  1 PagerDuty  service: Payments (key ••••3f)   severity map: SEV1→critical SEV2→error  [Test]│
│  2 Slack      #payments-alerts  app ✓ interactive   thread per incident ✓            [Test]│
│  3 Email      payments-team@ (digest for SEV4)                                       [Test]│
│ Templates: title [default ▾]  body [payments-custom ▾]  [Preview with: INC-2041 ▾]           │
│ Delivery: retries 5 (exp. backoff) · timeout 10 s · rate limit 30/min · send resolved ✓       │
│ Used by: 3 routes · 41 rules     Last 7 d: 212 sent · 1 failed (Slack 429 at 11-15 08:02) ↗   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### ALR-060 — Contact point editor
**MUST** · M-UI4 · SRE, Admin

The contact point editor MUST show the integrations (fan-out: all receive) with per-integration
settings (e.g. PagerDuty severity map, Slack thread per incident, email digest for a severity),
template selection with preview against a chosen incident, delivery settings, health, "Used by",
and last-7-day delivery counts with the most recent failure. Delivery settings MUST default to
5 retries with exponential backoff, 10 s timeout, and send-resolved on; a rate limit (e.g. 30/min)
MUST be configurable, and excess over it MUST be coalesced into a digest rather than dropped.

*Acceptance:* Given contact point payments-oncall, when the editor opens, then it shows three
integrations, health, "Used by: 3 routes · 41 rules" and "Last 7 d: 212 sent · 1 failed (Slack 429 at
11-15 08:02)"; given a rate limit of 30/min and 45 notifications in one minute, the endpoint receives
30 notifications and one digest of 15.

#### ALR-061 — Test notification
**MUST** · M-UI4 · SRE, Admin

**Test** on an integration MUST send a real, clearly marked test notification and show the
endpoint's response (status and body excerpt) inline.

*Acceptance:* Given a Slack integration with a revoked token, when the user presses Test, then the
editor shows the Slack error response inline within the integration timeout, and the message (when
the token is valid) is marked "TEST".

#### ALR-062 — Secrets are write-only
**MUST** · M-UI4 · Admin

Integration secrets (API keys, webhook URLs) MUST be stored encrypted, MUST be write-only in the UI
(shown masked, e.g. "••••3f"), and MAY be references to Vault or a cloud secret manager
([11](11-enterprise.md), [T18](../technical/T18-security.md)).

*Acceptance:* Given a saved PagerDuty key, when the editor or its API is read by any role, then only
the masked suffix is returned; replacing it requires entering a new value.

#### ALR-063 — Used-by blast radius
**MUST** · M-UI4 · SRE, Admin

"Used by" MUST link to every route and rule that uses the contact point, and deleting or changing a
contact point MUST show that blast radius before confirmation.

*Acceptance:* Given a contact point used by 3 routes and 41 rules, when the user chooses Delete, then
the confirmation lists the 3 routes and 41 rules and requires explicit confirmation.

### 7.3 Templates

#### ALR-064 — Template language with live preview
**MUST** · M-UI4 · SRE, Admin

Notification templates MUST use one Go-template-compatible language (so templates from Alertmanager and
other existing alerting systems import) with a live preview against real past alerts, rendered as each endpoint will show
it: Slack blocks, Teams card, email HTML, SMS within 160 characters.

*Acceptance:* Given an imported Alertmanager template, when previewed with INC-2041, then it renders
without error for Slack, Teams, email and SMS, and the SMS preview is ≤ 160 characters with a
truncation marker if needed.

#### ALR-065 — Default templates carry the RCA card
**MUST** · M-UI4 · SRE, NOC, IC

Default templates MUST carry the RCA card content: the causal sentence, impact, ⊕ origin and change;
deep links into the Alert Lens with Context; and ack/silence buttons where the endpoint supports
them. Default content MUST be short enough to read on a phone lock screen
([13](13-core-flow-storyboard.md), SCN-007).

*Acceptance:* Given INC-2041 with stage-1 RCA, when the default Slack and push templates render, then
each contains impact, origin, change and an Alert Lens link carrying entity and window, and the push
body is ≤ 178 characters.

#### ALR-066 — Server-rendered chart image
**SHOULD** · M-UI4 · SRE, NOC

Templates SHOULD be able to include a chart image rendered server-side by the same wgpu renderer
running natively ([T02](../technical/T02-vis-engine.md)), for endpoints that show images.

*Acceptance:* Given an email template with a chart image block, when it renders for INC-2041, then
the email contains a PNG of the alert's series with the firing band, visually matching the browser
rendering of the same viewport.

#### ALR-067 — Redaction on every outbound payload
**MUST** · M-UI4 · Admin

Redaction rules (PII, secrets) MUST apply to every outbound notification payload, including
AI-generated text.

*Acceptance:* Given a redaction rule for email addresses and an alert whose label and causal sentence
contain an email address, when the notification renders for every integration, then no payload
contains the address.

### 7.4 Delivery observability

#### ALR-068 — Every attempt recorded
**MUST** · M-UI4 · SRE, Admin

Every notification attempt MUST be recorded with endpoint, payload hash, response code, latency and
retry count. These records MUST drive the per-alert notification status in the List (✓ delivered /
✖ failed / ⏳ retrying) and the contact point health badge (success ratio over the last hour).

*Acceptance:* Given a Slack integration returning 429 twice and then 200, when the alert fires, then
three attempts are recorded with codes and latencies, the List shows ⏳ during retries and ✓ after,
and the health badge reflects the hour's success ratio.

#### ALR-069 — Meta-alert to a fallback route
**MUST** · M-UI4 · SRE, Admin

An integration with 3 or more consecutive permanent failures, or below 50 % success over 15 min,
MUST raise a meta-alert routed to the tenant's fallback route, so a broken Slack token cannot silence
production.

*Acceptance:* Given a Slack integration whose token is revoked, when three notifications fail
permanently, then a meta-alert "contact point payments-oncall failing" is delivered to the fallback
route's receiver and the contact point health shows ✖.

#### ALR-070 — Heartbeat (dead-man's switch)
**MUST** · M-UI4 · SRE, Platform

Dash MUST send a heartbeat at least every minute to a configured external receiver (PagerDuty,
Healthchecks.io-style, Better Stack). The heartbeat MUST traverse the full evaluate → route → deliver
path (an always-firing internal Watchdog rule), so "alerting itself is down" also pages.

*Acceptance:* Given a heartbeat receiver configured, when the evaluator, the router or Postgres is
stopped, then no heartbeat reaches the receiver within 2 minutes and the receiver pages; when all are
running, heartbeats arrive at ≤ 1 min intervals.

## 8. Routing, escalation, silences, maintenance and actions

See [mockup](../mockups/12-routing-simulator.svg).

### 8.1 Notification policy tree

#### ALR-071 — Policy tree editor with traffic Sankey
**MUST** · M-UI4 · SRE, Admin

The notification policy tree MUST be editable as a collapsible tree and also shown as a Sankey of
the last 7 days of real traffic (e.g. "SEV2 payments → 92 % payments-oncall, 8 % default").

*Acceptance:* Given 7 days of deliveries, when the routing editor opens, then the Sankey's flow
widths match the delivery records per route and receiver to within 1 %.

#### ALR-072 — Routing simulator
**MUST** · M-UI4 · SRE, Admin

The routing editor MUST include a "test a label set" simulator that shows which routes match, which
receivers would be hit, and why (the matcher that matched or failed at each node), including the
effect of active silences, mute timings and maintenance windows.

*Acceptance:* Given label set `{team=payments, severity=SEV2}`, when entered in the simulator, then
the matching path is highlighted, the receivers listed, and each non-matching sibling route shows the
matcher that failed; an active silence that matches is listed as suppressing.

#### ALR-073 — Route to the owner of the origin entity
**MUST** · M-UI4 · SRE, Platform

Routes MUST be able to target owners derived from entity metadata, including "→ owner of the origin
entity" of an incident, so routing follows services rather than label-matching folklore.

*Acceptance:* Given INC-2041 whose probable origin is psp-api's client in payments (owner team
payments), when a route "→ owner of the origin entity" applies, then the payments team's contact
point is notified, and changing the entity's owner changes the receiver without editing the route.

#### ALR-074 — Grouping and timing
**MUST** · M-UI4 · SRE

Routes MUST support `group_by`, `group_wait`, `group_interval` and `repeat_interval` with
Alertmanager semantics (for import). On top of that, incident grouping (topology + time + shared
origin, [T16](../technical/T16-alert-evaluator.md)) MUST mean one page per incident rather than one
per rule.

*Acceptance:* Given the INC-2041 scenario on the replay corpus (14 related alerts), when routing runs,
then one page is sent for the incident; and an imported Alertmanager route with `group_wait: 30s`
delays its first notification by 30 s as Alertmanager does.

#### ALR-075 — Escalation chains
**MUST** · M-UI4 · SRE, Admin

Dash MUST provide a lightweight escalation chain (notify A → if not acked in 5 min notify B → …) for
customers without a paging product. Customers with one MUST be able to delegate escalation to it.

*Acceptance:* Given a chain A → (5 min) → B, when an incident is not acked within 5 min, then B is
notified at 5 min; when A acks at 4 min, B is never notified.

#### ALR-076 — Mute timings
**MUST** · M-UI4 · SRE, Admin

Routes MUST support mute timings: recurring quiet periods (e.g. no SEV4 email at weekends).

*Acceptance:* Given mute timing "weekends" on the SEV4 email route, when a SEV4 alert fires on a
Saturday, then no email is sent and the alert's notification status shows "muted (weekends)".

### 8.2 Silences

#### ALR-077 — Silences with preview, reason and audit
**MUST** · M-UI4 · SRE, NOC, Platform

Silences MUST be creatable from an alert, a selection, or a cell in the Segments or Infra view (e.g.
everything on `node-pool=gpu`). Creating one MUST show a preview of matching alerts and require a
reason. Silences MUST show expiry nudges and have an audit trail.

*Acceptance:* Given an Infra group `node-pool=gpu` with 4 firing alerts, when the user chooses
"Silence…" from the group, then the preview lists the 4 alerts, Save is disabled until a reason is
entered, the silence appears in the audit log, and 15 min before expiry the creator gets an expiry
nudge.

### 8.3 Maintenance windows

#### ALR-078 — Maintenance windows
**MUST** · M-UI4 · NOC, Platform

Maintenance windows MUST be managed in a calendar view, one-off or recurring (RRULE), scoped to
entities or segments. Matching alerts MUST be In maintenance (🛠). Windows MUST appear as 🛠 time
regions on every chart and as hatched cells on the Map and Segments views, so "that's expected" is
visible to the NOC.

*Acceptance:* Given a weekly RRULE window on cluster prod-eu-1, when it is active, then alerts on that
cluster show 🛠, prod-eu-1 is hatched on the Map and in Segments, and every chart of its entities
shows a 🛠 region for the window.

#### ALR-079 — Maintenance from a change ticket
**SHOULD** · M-UI4 · Platform, NOC

A maintenance window SHOULD be creatable from a change or deploy ticket (e.g. a ServiceNow change
request becomes a window with its scope and times).

*Acceptance:* Given a ServiceNow change request with CI payments and a 02:00–03:00 slot, when it is
imported, then a window scoped to the payments entity for 02:00–03:00 is created and linked to the CR.

### 8.4 Alert actions from incidents

#### ALR-080 — Actions run through the action framework
**MUST** · M-UI4 · SRE, Platform, Admin

Every action that changes something outside Dash (config revert, rollback webhook, scale, pipeline
trigger, automation endpoints of Table 7.1) MUST run through the action framework
([T18](../technical/T18-security.md)):
- it MUST show a confirmation sheet with the diff, the target, the approval policy and the runbook;
- it MUST execute under the confirming user's identity (or the policy's service account, if the
  policy says so);
- it MUST be written to the audit log;
- its result MUST be posted to the incident timeline.

At v1 the generic webhook is the transport for actions.

*Acceptance:* Given the ⚙ evidence for `payments.psp.timeout`, when Sam chooses Revert config, then
the sheet shows "5000 ← 2000", target, approval policy and runbook; after confirmation the webhook is
called with Sam's identity, the audit log has the entry, and the timeline shows "Sam reverted
payments.psp.timeout → 5000" with a ⚙ glyph on every chart.

#### ALR-081 — Approval policy
**MUST** · M-UI4 · Admin

Each action type MUST have an approval policy (who may run it, whether a second approver is needed).
An action whose policy is not satisfied MUST NOT execute.

*Acceptance:* Given a scale action requiring a second approver, when one user confirms, then the
action is pending approval and not executed until a second permitted user approves.

## 9. Alert hygiene

#### ALR-082 — Monthly noise report
**MUST** · M-UI5 · SRE, Platform, IC

Dash MUST produce a monthly noise report per team, drawn from estate history (§6.2), listing:
- rules that fired with no action;
- flapping rules;
- rules that never fire;
- alerts without runbooks;
- uncovered tier-1 services;
- failing contact points;
- silences repeatedly re-created ("this should be a maintenance window or a rule fix");
- the alerts-per-incident ratio trend.

*Acceptance:* Given a team with one rule that fired 41 times in 30 days with no action, one rule
without a runbook and one silence re-created 4 times, when the monthly report is generated, then each
appears in its section and the ratio trend is plotted.

#### ALR-083 — One-click hygiene fixes
**MUST** · M-UI5 · SRE, Platform

Each noise-report item MUST offer one-click fixes where applicable: convert to SLO burn, add `for`,
retire the rule, merge into a composite. Each fix MUST open the rule editor with the change
prefilled and its before/after backtest (ALR-046).

*Acceptance:* Given a flapping rule in the report, when the user clicks "add `for`", then the editor
opens with a `for` value prefilled and the backtest shows fewer firings than the current version.

## 10. Data model & storage

Per [ADR-0012](../adr/0012-derived-state-in-postgres.md), all alerting state, including history, is
in Postgres. Dash does not write alert history into PulsusDB.

**Table 10.1 — Alerting data and stores**

| Data | Store | Notes |
|---|---|---|
| Rules (versioned), contact points, policies, templates, silences, maintenance windows, mute timings | Postgres | Versioned rows + Git sync ([11](11-enterprise.md)) |
| Current alert instance state (per rule × label set) | Postgres, with in-memory evaluator state | Survives evaluator restart; HA evaluators with leader election per rule shard ([T16](../technical/T16-alert-evaluator.md)) |
| State transitions (history) | Postgres, time-partitioned | Per-tenant retention, default 13 months; about 1 KB per transition |
| Notifications & delivery attempts | Postgres, time-partitioned | Same retention as transitions; drives §7.4 |
| Incidents, evidence ledger, timeline | Postgres | Linked to transitions by id |
| Evaluator self-telemetry (evaluation latency, queue depth) | Dash self-telemetry; MAY be exported to PulsusDB | Not used by any alerting view |

#### ALR-084 — Alert history in Postgres
**MUST** · M-UI4 · SRE, Admin

State transitions and notification delivery attempts MUST be stored in Postgres in time-partitioned
tables, with per-tenant retention defaulting to 13 months and enforced by dropping partitions. Dash
MUST NOT write alert history to PulsusDB.

*Acceptance:* Given a tenant with default settings, when 14 months of transitions exist, then
partitions older than 13 months are dropped and the oldest queryable transition is 13 months old; and
a PulsusDB ingest audit over a test run shows no writes from Dash other than self-telemetry and a
configured audit export.

#### ALR-085 — History queryable as telemetry
**MUST** · M-UI4 · SRE, Platform, Engineer

The BFF MUST serve alert history through the same query interface as telemetry
([T07](../technical/T07-scene-query-planner.md)):
- the PromQL selectors `ALERTS` and `ALERTS_FOR_STATE` (with `alertname`, `alertstate`, `severity`
  and the rule's labels), and `pulsus_anomaly_score`, as virtual series;
- the log stream `{source="pulsus-dash"}` with `kind="alert_transition"` and
  `kind="notification_attempt"` events.

These selectors MUST be resolved against Postgres and never sent to PulsusDB. They MUST render with
the same vis, compare and RCA tools as telemetry, and MAY be combined with PulsusDB results in one
scene. PromQL functions over them (e.g. `rate()`) MUST be supported; binary operations joining them
with PulsusDB series are supported within the documented limits of the BFF join.

*Acceptance:* Given a week of history, when a viewport runs
`sum by (team) (count_over_time(ALERTS{alertstate="firing"}[1w]))`, then it renders "alerts per team
per week" matching the transition table; when the transition explorer queries
`{source="pulsus-dash", kind="alert_transition"}`, the rows match; and the PulsusDB query log shows
neither request.

#### ALR-086 — Prometheus-compatible read API for history
**SHOULD** · M-UI4 · Platform

Because external tools that read PulsusDB directly do not see alert history, Dash's
Prometheus-compatible read API SHOULD expose the `ALERTS` and `ALERTS_FOR_STATE` series.

*Acceptance:* Given an external dashboard tool pointed at Dash's Prometheus-compatible endpoint, when it queries
`ALERTS{alertstate="firing"}`, then it receives the same series as a Dash viewport.

#### ALR-087 — Alerting survives without PulsusDB ingest
**MUST** · M-UI4 · Platform

No alerting feature MUST depend on PulsusDB ingest being enabled for the tenant.

*Acceptance:* Given a tenant whose PulsusDB ingest endpoint rejects writes from Dash, when the full
alerting test suite runs, then every test passes.

## 11. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| [ALR-001](#alr-001--all-rule-kinds) | All rule kinds | MUST | M-UI4 |
| [ALR-002](#alr-002--entity-relative-templates-cover-new-entities) | Entity-relative templates cover new entities | MUST | M-UI4 |
| [ALR-003](#alr-003--composite-rules-page-once) | Composite rules page once | MUST | M-UI4 |
| [ALR-004](#alr-004--evaluation-independent-of-the-pulsusdb-ruler) | Evaluation independent of the PulsusDB ruler | MUST | M-UI4 |
| [ALR-005](#alr-005--one-state-vocabulary) | One state vocabulary | MUST | M-UI4 |
| [ALR-006](#alr-006--lifecycle-transitions) | Lifecycle transitions | MUST | M-UI4 |
| [ALR-007](#alr-007--nodata-and-error-are-first-class) | NoData and Error are first-class | MUST | M-UI4 |
| [ALR-008](#alr-008--flapping-detection) | Flapping detection | MUST | M-UI4 |
| [ALR-009](#alr-009--severity-maps-to-the-health-scale) | Severity maps to the health scale | MUST | M-UI4 |
| [ALR-010](#alr-010--create-alert-from-every-inspector) | Create alert from every Inspector | MUST | M-UI4 |
| [ALR-011](#alr-011--live-backtest-with-draggable-threshold) | Live backtest with draggable threshold | MUST | M-UI4 |
| [ALR-012](#alr-012--ai-suggestion-of-thresholds-and-windows) | AI suggestion of thresholds and windows | SHOULD | M-UI4 |
| [ALR-013](#alr-013--notification-preview) | Notification preview | MUST | M-UI4 |
| [ALR-014](#alr-014--blast-radius-for-entity-relative-templates) | Blast radius for entity-relative templates | MUST | M-UI4 |
| [ALR-015](#alr-015--route-and-runbook-from-entity-ownership) | Route and runbook from entity ownership | MUST | M-UI4 |
| [ALR-016](#alr-016--one-alert-set-across-views) | One alert set across views | MUST | M-UI4 |
| [ALR-017](#alr-017--animated-morph-between-views) | Animated morph between views | MUST | M-UI4 |
| [ALR-018](#alr-018--container-aggregation) | Container aggregation | MUST | M-UI4 |
| [ALR-019](#alr-019--show-what-still-needs-a-human) | Show what still needs a human | MUST | M-UI4 |
| [ALR-020](#alr-020--acknowledge-from-any-alert-view) | Acknowledge from any alert view | MUST | M-UI4 |
| [ALR-021](#alr-021--historical-replay-of-every-view) | Historical replay of every view | MUST | M-UI4 |
| [ALR-022](#alr-022--map-content) | Map content | MUST | M-UI4 |
| [ALR-023](#alr-023--map-semantic-zoom) | Map semantic zoom | MUST | M-UI4 |
| [ALR-024](#alr-024--dark-region-is-never-healthy) | Dark region is never healthy | MUST | M-UI4 |
| [ALR-025](#alr-025--segment-matrix) | Segment matrix | MUST | M-UI4 |
| [ALR-026](#alr-026--perspective-default-segmentations) | Perspective default segmentations | MUST | M-UI5 |
| [ALR-027](#alr-027--victim-aware-cells) | Victim-aware cells | MUST | M-UI4 |
| [ALR-028](#alr-028--ranked-list-and-treemap-modes) | Ranked list and treemap modes | MUST | M-UI4 |
| [ALR-029](#alr-029--silence-or-maintain-from-a-cell) | Silence or maintain from a cell | MUST | M-UI4 |
| [ALR-030](#alr-030--infra-heat-grid) | Infra heat grid | MUST | M-UI4 |
| [ALR-031](#alr-031--workload-targeted-alerts-outline-their-pods) | Workload-targeted alerts outline their pods | MUST | M-UI4 |
| [ALR-032](#alr-032--infra-scale) | Infra scale | MUST | M-UI4 |
| [ALR-033](#alr-033--lasso-and-compare) | Lasso and compare | MUST | M-UI4 |
| [ALR-034](#alr-034--alert-layer-on-topology) | Alert layer on Topology | MUST | M-UI4 |
| [ALR-035](#alr-035--alert-layer-on-city) | Alert layer on City | MUST | M-UI4 |
| [ALR-036](#alr-036--list-columns-and-grouping) | List columns and grouping | MUST | M-UI4 |
| [ALR-037](#alr-037--list-keyboard-and-bulk-actions) | List keyboard and bulk actions | MUST | M-UI4 |
| [ALR-038](#alr-038--saved-alert-views) | Saved alert views | MUST | M-UI4 |
| [ALR-039](#alr-039--incident-swimlanes) | Incident swimlanes | MUST | M-UI4 |
| [ALR-040](#alr-040--alerts-in-viewports) | Alerts in viewports | MUST | M-UI4 |
| [ALR-041](#alr-041--alerts-in-lens-chips-and-home) | Alerts in Lens, chips and Home | MUST | M-UI4 |
| [ALR-042](#alr-042--global-incident-counter) | Global incident counter | MUST | M-UI4 |
| [ALR-043](#alr-043--noc-wall-alerts) | NOC wall alerts | MUST | M-UI4 |
| [ALR-044](#alr-044--mobile-alert-handling) | Mobile alert handling | MUST | M-UI4 |
| [ALR-045](#alr-045--rule-history-view) | Rule history view | MUST | M-UI4 |
| [ALR-046](#alr-046--rule-versions-and-beforeafter-backtest) | Rule versions and before/after backtest | MUST | M-UI4 |
| [ALR-047](#alr-047--per-instance-breakdown-and-evaluation-health) | Per-instance breakdown and evaluation health | MUST | M-UI4 |
| [ALR-048](#alr-048--calendar-heatmap-of-incidents) | Calendar heatmap of incidents | MUST | M-UI4 |
| [ALR-049](#alr-049--transition-explorer) | Transition explorer | MUST | M-UI4 |
| [ALR-050](#alr-050--segment-trends) | Segment trends | MUST | M-UI4 |
| [ALR-051](#alr-051--ops-metrics) | Ops metrics | MUST | M-UI4 |
| [ALR-052](#alr-052--incident-archive) | Incident archive | MUST | M-UI4 |
| [ALR-053](#alr-053--similar-incidents-in-the-alert-lens) | Similar incidents in the Alert Lens | MUST | M-UI4 |
| [ALR-054](#alr-054--past-incidents-reopen-in-full) | Past incidents reopen in full | MUST | M-UI4 |
| [ALR-055](#alr-055--v1-endpoints) | v1 endpoints | MUST | M-UI4 |
| [ALR-056](#alr-056--v2-endpoints) | v2 endpoints | SHOULD | M-UI5 |
| [ALR-057](#alr-057--interactive-chat-messages) | Interactive chat messages | MUST | M-UI4 |
| [ALR-058](#alr-058--two-way-sync-with-paging-and-itsm) | Two-way sync with paging and ITSM | MUST | M-UI4 |
| [ALR-059](#alr-059--existing-contact-point-import) | Existing contact point import | MUST | M-UI4 |
| [ALR-060](#alr-060--contact-point-editor) | Contact point editor | MUST | M-UI4 |
| [ALR-061](#alr-061--test-notification) | Test notification | MUST | M-UI4 |
| [ALR-062](#alr-062--secrets-are-write-only) | Secrets are write-only | MUST | M-UI4 |
| [ALR-063](#alr-063--used-by-blast-radius) | Used-by blast radius | MUST | M-UI4 |
| [ALR-064](#alr-064--template-language-with-live-preview) | Template language with live preview | MUST | M-UI4 |
| [ALR-065](#alr-065--default-templates-carry-the-rca-card) | Default templates carry the RCA card | MUST | M-UI4 |
| [ALR-066](#alr-066--server-rendered-chart-image) | Server-rendered chart image | SHOULD | M-UI4 |
| [ALR-067](#alr-067--redaction-on-every-outbound-payload) | Redaction on every outbound payload | MUST | M-UI4 |
| [ALR-068](#alr-068--every-attempt-recorded) | Every attempt recorded | MUST | M-UI4 |
| [ALR-069](#alr-069--meta-alert-to-a-fallback-route) | Meta-alert to a fallback route | MUST | M-UI4 |
| [ALR-070](#alr-070--heartbeat-dead-mans-switch) | Heartbeat (dead-man's switch) | MUST | M-UI4 |
| [ALR-071](#alr-071--policy-tree-editor-with-traffic-sankey) | Policy tree editor with traffic Sankey | MUST | M-UI4 |
| [ALR-072](#alr-072--routing-simulator) | Routing simulator | MUST | M-UI4 |
| [ALR-073](#alr-073--route-to-the-owner-of-the-origin-entity) | Route to the owner of the origin entity | MUST | M-UI4 |
| [ALR-074](#alr-074--grouping-and-timing) | Grouping and timing | MUST | M-UI4 |
| [ALR-075](#alr-075--escalation-chains) | Escalation chains | MUST | M-UI4 |
| [ALR-076](#alr-076--mute-timings) | Mute timings | MUST | M-UI4 |
| [ALR-077](#alr-077--silences-with-preview-reason-and-audit) | Silences with preview, reason and audit | MUST | M-UI4 |
| [ALR-078](#alr-078--maintenance-windows) | Maintenance windows | MUST | M-UI4 |
| [ALR-079](#alr-079--maintenance-from-a-change-ticket) | Maintenance from a change ticket | SHOULD | M-UI4 |
| [ALR-080](#alr-080--actions-run-through-the-action-framework) | Actions run through the action framework | MUST | M-UI4 |
| [ALR-081](#alr-081--approval-policy) | Approval policy | MUST | M-UI4 |
| [ALR-082](#alr-082--monthly-noise-report) | Monthly noise report | MUST | M-UI5 |
| [ALR-083](#alr-083--one-click-hygiene-fixes) | One-click hygiene fixes | MUST | M-UI5 |
| [ALR-084](#alr-084--alert-history-in-postgres) | Alert history in Postgres | MUST | M-UI4 |
| [ALR-085](#alr-085--history-queryable-as-telemetry) | History queryable as telemetry | MUST | M-UI4 |
| [ALR-086](#alr-086--prometheus-compatible-read-api-for-history) | Prometheus-compatible read API for history | SHOULD | M-UI4 |
| [ALR-087](#alr-087--alerting-survives-without-pulsusdb-ingest) | Alerting survives without PulsusDB ingest | MUST | M-UI4 |

## 12. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Alert history moved to Postgres per D2 / ADR-0012 |

## Resolved during formalisation

1. **Alert history store (D2).** The draft stored transitions as OTLP logs and `ALERTS` series in
   PulsusDB, with a 30-day Postgres hot copy, and deliveries as Postgres (30 d) + PulsusDB. Per
   ADR-0012 both now live only in Postgres, time-partitioned, 13-month default retention
   (ALR-084), served as virtual selectors (ALR-085). The draft's closing paragraph (history as data,
   "alerts per team per week is just a query") still holds via ALR-085. A Prometheus-compatible read
   path (ALR-086) replaces "external dashboard tools read PulsusDB".
2. **Event-stream selector.** The draft's `{service_name="pulsus-dash", pulsus_event_kind=…}` is
   replaced by ADR-0012's `{source="pulsus-dash"}` with a `kind` label (`alert_transition`,
   `notification_attempt`). Exact label names are fixed in T07/T16.
3. **"Six views" vs seven.** The draft titled §3 "six views" but listed seven keys, and City
   (`Alt+3`) had no section. Seven views are specified; City gets ALR-035.
4. **Ack key.** The List draft used `[A] ack`; aligned to `Shift+A` everywhere (Table 5.7, ALR-020).
5. **Severity mapping.** The draft mapped three levels (critical/warning/info) to SEV1–SEV4 without
   saying which SEV is which. Table 3.3 sets SEV1 → Failing, SEV2–3 → Degraded, SEV4 → Watch
   (consistent with "INC-2041 SEV2 Checkout degraded").
6. **Unspecified numbers** taken from T16 (draft): flapping = ≥ 6 transitions / 60 min; Error after
   2 consecutive failures; Resolved → Normal after 15 min; meta-alert = ≥ 3 consecutive permanent
   failures or < 50 % over 15 min; heartbeat every minute; contact point health over 1 h. The
   editor mockup values (5 retries, 10 s, send resolved) became defaults.
7. **v2 tier milestone.** The draft said only "v2 is later"; set to M-UI5 per T16 (draft), as are the
   hygiene report and fixes. Existing contact-point import is M-UI4 for available types.
8. **Action framework.** Referenced only in the Automation row; given its own requirements (§8.4)
   using the storyboard's confirmation sheet.
9. **Push body length.** "Short enough for a lock screen" made testable as ≤ 178 characters
   (ALR-065), a common lock-screen preview limit. Needs product-owner confirmation.
