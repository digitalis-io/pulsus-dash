# 01a — Audiences & perspectives

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Requirement area** | `AUD` |
| **Source draft** | plans/01a-audiences-and-perspectives.md (not tracked) |
| **Depends on** | [01](01-vision-and-principles.md), [02](02-information-architecture.md), [03](03-interaction-model.md), [04](04-surfaces.md), [06](06-ai-copilot.md), [07](07-alerting.md), [08](08-visual-language.md), [11](11-enterprise.md), [15](15-estate-navigation.md) |
| **Mockups** | [02-atlas-topology](../mockups/02-atlas-topology.svg), [03-infra-cluster](../mockups/03-infra-cluster.svg), [05-service-lens](../mockups/05-service-lens.svg), [09-alert-lens](../mockups/09-alert-lens.svg), [13-investigation](../mockups/13-investigation.svg), [17-mobile-alert-card](../mockups/17-mobile-alert-card.svg), [18-noc-wall](../mockups/18-noc-wall.svg) |

## 1. Purpose & scope

This is the most important document in the specification. Everything else (Atlas, Lens, GPU
rendering, AI) exists to serve what is described here. **If a feature cannot be traced to a
question a real person asks under pressure, it does not ship.**

This document specifies:
- the altitudes at which people look at the same telemetry;
- the universal drill path (the Problem Funnel) and the primitives that answer each step;
- what each audience must see in the first five seconds, how they drill and what is hidden from
  them;
- the presentation principles for finding problems fast;
- the Perspective mechanism;
- the validation scenario used as an acceptance test.

The ASCII sketches are illustrative; the requirements and the mockups referenced next to them are
what is normative and what illustrates it, respectively.

## 2. Definitions

| Term | Meaning |
|---|---|
| **Altitude** | A level of abstraction at which an audience thinks about the estate (§3) |
| **Problem Funnel** | The six-step drill path Detect → Assess → Localise → Explain → Act → Learn (§4) |
| **Health state** | The five-state ordinal scale OK / Watch / Degraded / Failing / Unknown (§4.2) |
| **Probable origin (⊕)** | The entity the origin heuristic ranks as the most likely start of a degradation (§4.1) |
| **Victim** | A degraded entity whose degradation is explained by a dependency (§4.1) |
| **Care score** | The default ranking of every collection (§4.3) |
| **Change Feed** | The first-class stream of changes correlated to anomalies (§4.4) |
| **Journey** | A business-level entity: a user-facing flow (Sign-in, Checkout), defined in [02](02-information-architecture.md) |
| **Perspective** | A named bundle of presentation defaults over the same space and data (§7) |
| **Incident** | A group of correlated alerts, defined in [02](02-information-architecture.md) |

Audience short names used in requirement blocks: **NOC**, **SRE**, **Platform**, **Engineer**,
**Business** (product owners and executives), **Support**, **IC** (incident commander) and **Admin**.

## 3. Same data, different altitudes

An enterprise has one underlying truth, the telemetry, but people look at it from different
altitudes, each with its own vocabulary and its own definition of "a problem".

| Altitude | Who lives here | "A problem" means… | Unit of thought |
|---|---|---|---|
| 5 Business | Exec, product owner, support | Customers can't buy / sign in | Journeys, KPIs, customers, revenue |
| 4 Experience | NOC, incident commander | A user-facing service is degraded | Services, SLOs, incidents |
| 3 Service | SRE, app engineer | My service is slow / erroring | Services, endpoints, deps, deploys |
| 2 Platform | DevOps / platform engineer | A cluster / node / DB is saturated | Clusters, nodes, DBs, queues |
| 1 Code | App engineer | This function / query got slower | Spans, stack frames, log lines |

Most tools serve a single altitude. Pulsus's job is to connect them, so that a business user sees
*"Checkout success 91% (normally 99.4%) — €38k/hour at risk"* and in one click sees which service
is responsible; an engineer starting from a red service sees which customers and journeys it is
hurting; and everyone looks at the same incident, the same time window and the same facts, phrased
for them.

#### AUD-001 — Altitudes are connected in one click
**MUST** · M-UI5 · Business, Support, Engineer, SRE

From a Journey's impact (altitude 5) a user with permission MUST reach the service responsible in
one click, and from a degraded service (altitude 3) a user MUST see which Journeys and, where
customer attributes are configured, which customers it affects, in one click.

*Acceptance:* Given the storyboard incident (checkout degraded, origin `psp-api`), when a Business
user clicks the Checkout journey's impact, then the responsible service is shown; when an Engineer
opens the `checkout` Lens and clicks "affected journeys", then Checkout and its € at risk are shown.

#### AUD-002 — One incident, one set of facts
**MUST** · M-UI4 · NOC, SRE, IC, Business, Support

Every audience viewing the same incident MUST see the same time window, the same health states and
the same impact figures; only vocabulary and presentation MAY differ by Perspective.

*Acceptance:* Opening INC-2041 in the Business, NOC and SRE Perspectives shows the same onset time,
the same affected-request count and the same € at risk, with different labels.

## 4. The universal drill path: the Problem Funnel

Across every role, finding and fixing a problem follows the same six steps. Each step has a
canonical UI answer that is present on every surface, so the gesture vocabulary is the same in the
Atlas, a Lens or a Board.

| Step | The question | UI primitive that answers it | Where it lives |
|---|---|---|---|
| **1. Detect** | *Is something wrong?* | Health state (one ordinal scale everywhere) + anomaly glow + alerts | Every node, tile, chart, crumb |
| **2. Assess** | *How bad? Who is affected? Since when?* | Impact line: human units (users, requests, €, SLO budget) + onset time | Inspector header, Lens header, alert card |
| **3. Localise** | *Where exactly?* | Blast-radius view + probable-origin marker + breakdown ranking (by pod, route, region, version, customer) | Atlas, Lens "where" tile, Compare |
| **4. Explain** | *What changed? Why?* | Change feed correlated to onset + attribute compare (what is different about the bad requests) + evidence across signals | Lens "what changed" rail, Traces compare, Log patterns NEW |
| **5. Act** | *What do I do now?* | Runbook links, rollback / feature-flag actions, silence, escalate, open investigation | Inspector actions, alert card |
| **6. Learn** | *Will it happen again?* | Investigation → post-mortem, alert-tuning suggestions, SLO adjustments | Investigation, Alerts |

#### AUD-003 — Funnel primitives on every surface
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every surface MUST present the Problem Funnel primitive for each step in the table above at the
locations listed in its "Where it lives" column.

*Acceptance:* A review of each surface in [04](04-surfaces.md) against the table finds the health
state, impact line, localisation aid, change evidence and actions present where listed; a missing
primitive is a defect.

#### AUD-004 — How bad, where, what changed: never leave the screen
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer, Business, Support, IC

At any point in the product the user MUST be able to answer "how bad", "where" and "what changed"
for the focused entity or incident within one hover or one click, without navigating away.

*Acceptance:* On every surface, with an entity or incident focused, impact, localisation and
correlated changes are each shown either in place or after exactly one hover or click, and the
camera and Context are unchanged afterwards.

### 4.1 Victim vs origin

The most common time-waster in incidents: ten services are red and people investigate the wrong
one. Pulsus computes and shows causal direction.

```
   ( gateway ● )  ──►  ( checkout ● )  ──►  ( payments ◉ )  ──►  [ psp-api.ext ◉ ]
     victim              victim               victim               ⊕ PROBABLE ORIGIN
     errors because      errors because        timeouts to          p99 +2.4s since 12:21,
     checkout errors     payments times out    psp-api              before anything else turned red
```

[mockup](../mockups/02-atlas-topology.svg)

#### AUD-005 — Probable-origin heuristic
**MUST** · M-UI3 · NOC, SRE, Engineer, Platform

Along service-graph edges, Pulsus MUST mark as **⊕ probable origin** the deepest degraded dependency
whose onset is earliest and whose degradation explains the callers' errors, using error attribution
from spans (where `status=error` originates vs where it propagates). The marker MUST carry a "why?"
tooltip listing the evidence, and MUST NOT be presented as certain.

*Acceptance:* On the storyboard replay, `psp-api` is marked ⊕ with a tooltip citing its onset
(12:21, before every caller) and the share of caller errors that originate at it; the wording uses
"probable", never "root cause".

#### AUD-006 — Victims recede, origins pop
**MUST** · M-UI3 · NOC, SRE, Engineer, Platform

Victims MUST be rendered desaturated red with a dashed ring, and the probable origin at full
saturation with the ⊕ glyph ([08](08-visual-language.md)).

*Acceptance:* On the storyboard replay, gateway, checkout and payments render desaturated with a
dashed ring and `psp-api` renders at full saturation with ⊕, in every estate view.

### 4.2 Health is computed, never eyeballed

One five-state scale, identical everywhere: Atlas node, breadcrumb, board tile, home strip, NOC wall.

| State | Meaning | Rule of thumb (defaults) |
|---|---|---|
| ● **OK** | Within SLO and baseline | — |
| ◐ **Watch** | Statistically unusual but inside SLO | Anomaly score high, budget burn < 1× |
| ● **Degraded** | SLO burning faster than sustainable | Burn rate > 2× (configurable) or warning alert |
| ● **Failing** | Users materially affected | Burn > 10× or critical alert or error spike |
| ○ **Unknown** | No / stale data | Freshness > 2× scrape interval |

#### AUD-007 — Five-state health, computed the same everywhere
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every entity MUST have exactly one health state from the table above, computed by the rules in it
(burn-rate thresholds configurable per tenant, defaults 2× and 10×), and every surface that shows
the entity MUST show that same state.

*Acceptance:* Given an entity with SLO burn 3× and no alert, it shows Degraded in the Atlas,
breadcrumb, board tile, home strip and NOC wall; raising the tenant's Degraded threshold to 4× turns
it Watch everywhere.

#### AUD-008 — Missing data is never healthy
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support, IC

An entity whose newest data is older than 2× its scrape interval MUST be shown as Unknown (hatched
grey), never as OK.

*Acceptance:* Given an entity scraped every 15 s that stops reporting, its state changes from OK to
Unknown no later than 30 s after the last sample, plus one evaluation interval.

#### AUD-009 — Every non-OK state explains itself
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every non-OK state MUST have a one-line "why" available on hover, stating the signal, the current
value, the baseline and the onset (e.g. "p99 2.8 s vs 0.4 s baseline since 12:22").

*Acceptance:* Hovering any Watch, Degraded, Failing or Unknown entity on any surface shows a
one-line explanation containing a value, a baseline or freshness, and an onset time.

### 4.3 Rank, don't list

```
  care = impact (users/requests/€ affected, tier of entity)
       × deviation (how far from baseline / SLO)
       × confidence (data completeness, statistical strength)
       × recency (onset recency, still getting worse?)
```

#### AUD-010 — Care is the default order
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer

Every collection (entities, alerts, series, pods, log patterns, traces, frames) MUST be sorted by
default by the care score above. `Tab` MUST cycle selection in this order on every surface
([03](03-interaction-model.md)). Alphabetical sort MUST be available and MUST NOT be the default.

*Acceptance:* Given three alerts with differing impact and deviation, the list, the Atlas `Tab`
order and the alert drawer all show the highest-care alert first; choosing "A–Z" re-sorts, and the
choice is not the default on reload.

### 4.4 Change is the first suspect

About 70% of incidents follow a change, so the Change Feed is a first-class stream, not annotations
buried in a dashboard.

| Change kind | Source |
|---|---|
| Deploys / version changes | `service.version` transitions in telemetry (zero config), plus CI/CD webhooks |
| Config changes, feature-flag flips | Webhooks / integrations |
| Scaling events, infra changes (node replaced, DB failover) | Telemetry and integrations |
| Traffic shifts (new region, sudden client mix) | Derived from telemetry |
| New log patterns, new error types / exception classes | Derived from logs and spans |
| New span attribute values, new dependencies in the graph | Derived from traces / service graph |

#### AUD-011 — Change Feed sources
**MUST** · M-UI3 · SRE, Engineer, Platform, NOC

The Change Feed MUST include every change kind in the table above. Changes derived by Dash are
Dash-derived state stored in PostgreSQL and MUST NOT be written into PulsusDB (decision D2,
[ADR-0012](../adr/0012-derived-state-in-postgres.md)).

*Acceptance:* On the storyboard replay, the feed contains the `checkout` v2.31 deploy (from a
`service.version` transition with no webhook configured), the `psp-api` timeout config change, and
the new log pattern "timeout calling payments"; no write is sent to PulsusDB.

#### AUD-012 — Changes ranked and shown in three places
**MUST** · M-UI3 · SRE, Engineer, Platform, NOC

Changes MUST be ranked by temporal proximity to the anomaly onset and topological proximity to the
affected entity, and MUST be rendered as glyphs on the Time Ribbon, as a rail in every Lens and as a
section in every alert.

*Acceptance:* On the storyboard replay, the ⚙ timeout change at 12:19 ranks first for `checkout`
and appears on the Time Ribbon, in the `checkout` Lens rail and in the HighErrorRate alert's
"Changed" section.

## 5. Audiences

For each audience: the moment they open Pulsus, the questions in their head, what they must see in
the first five seconds, how they drill, what is hidden from them and the requirements that follow.

### 5.1 NOC operator

**Moment:** a 12-hour shift in front of a wall of screens and a console; watches hundreds of
services and owns none; escalates to the right team. Often first to notice, rarely the one who fixes.

**Questions:** "Is anything red right now? Is it new or already being handled?" · "Is it big enough
to wake someone? Whose is it?" · "Is this one incident or five?" · "Did it get better after the team
did something?"

**First five seconds:** a calm estate view where only problems have colour; a count of active
incidents by severity with owner, acknowledged-by and elapsed time; anything new and un-owned blinks
once and then glows.

**Drill path:** wall shows a red territory → console: click → alert group with correlated alerts
merged into one incident ("14 alerts, 1 probable origin: psp-api") → owner team + on-call person →
one-click page/escalate → watch the recovery curve.

**Hide:** queries, raw metrics, PromQL, flame graphs. They need status, ownership and trend.

```
┌ NOC · prod · 14:02 ───────────────────────────────────────────────────── 3 incidents  2 unowned ┐
│      [ ATLAS — Hierarchy "city" view, everything grey-calm except problems ]                     │
│                     ▲ payments district: tall red tower, pulsing  ⊕ psp-api                      │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ SEV2  Checkout degraded   ⊕ psp-api (external)   14 alerts merged   ACK @sam 12m   ▁▂▅█▇▆▅ ↘ improving│
│ SEV3  Search latency      ⊕ es-cluster-2         3 alerts           ⚠ UNOWNED 4m  [Page search-oncall]│
│ SEV4  Batch delay         ⊕ etl-nightly          1 alert            ACK @lee 40m   ▁▁▂▂▂▂ → flat     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

[mockup](../mockups/18-noc-wall.svg)

#### AUD-013 — Alerts grouped into incidents by topology and time
**MUST** · M-UI4 · NOC, SRE, IC

Correlated alerts MUST be grouped into one incident by topology (service-graph adjacency) and time,
not by labels alone, and the incident MUST show the merged alert count and its probable origin
([07](07-alerting.md)).

*Acceptance:* On the storyboard replay, the 14 alerts on gateway, checkout, payments and `psp-api`
form one incident labelled "14 alerts merged · ⊕ psp-api", although they share no grouping label.

#### AUD-014 — NOC incident queue
**MUST** · M-UI4 · NOC

The NOC view MUST show active incidents with, per row: severity, plain title, probable origin,
merged alert count, owner state (ACK by whom and for how long, or UNOWNED with elapsed time), a
trend sparkline with a trend word (improving / worsening / flat) and arrow, and for unowned
incidents a one-click page/escalate action. The header MUST show the count of incidents and of
unowned incidents.

*Acceptance:* On the storyboard replay at 14:02, the queue shows three rows matching the sketch
above, the header reads "3 incidents 2 unowned", and clicking "Page search-oncall" pages the owning
team's on-call.

#### AUD-015 — New, un-owned problems announce themselves once
**MUST** · M-UI4 · NOC

A new, un-owned incident MUST blink once and then glow until it is owned; everything healthy MUST
stay calm (no colour, low motion).

*Acceptance:* When a new incident is created with no owner, its row and map marker blink exactly
once, then hold a glow; on acknowledgement the glow stops within 1 s.

#### AUD-016 — Wall readability and attract mode
**MUST** · M-UI6 · NOC

The NOC wall MUST use big-screen typography (Wall density, [08](08-visual-language.md)) and the
colour-blind-safe palette, readable from 5 m, and its attract-mode camera MUST return to the worst
current problem when idle.

*Acceptance:* In the wall test (§9), participants including people with colour-vision deficiencies
read incident severity, origin and owner from 5 m on reference hardware (c); after the idle timeout,
the camera flies to the highest-care incident.

### 5.2 On-call SRE

**Moment:** paged, possibly at 03:00, on a laptop. Has five minutes to decide: mitigate, escalate,
or go back to sleep. May not know the paging service well.

**Questions:** "Is this real? Are users affected? How many?" · "Is it getting worse?" · "Is it us or
a dependency?" · "What changed?" → "Can I roll back?" · "Who else needs to know?"

**First five seconds:** the alert opens straight into an Alert Lens, not a rule definition.

```
┌ ⚠ HighErrorRate · checkout · FIRING 7m ─────────────────────────────────────────────────────────┐
│ IMPACT   4.1% of checkout requests failing (normal 0.1%)  ≈ 2 900 users / 10 min   SLO burn 14× │
│ TREND    ▁▁▁▁▂▅█▇▇█  still rising                                                               │
│ WHERE    all pods equally · all regions · route POST /pay only   ⊕ origin: payments → psp-api    │
│ CHANGED  ◆ checkout v2.31 deployed 12:20 (2 min before onset)   ⚙ psp-api timeout 5s→2s 12:19  │
│ EVIDENCE [p99 chart] [pattern "timeout calling payments" NEW ×1832] [slowest trace] [AI summary]│
│ ACT      [Rollback v2.31 runbook] [Open investigation] [Ack] [Silence ▾] [Page payments]        │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

[mockup](../mockups/09-alert-lens.svg)

**Drill path:** card → any evidence chip flies into the relevant Lens/workbench with Context set →
Correlate stack (metrics + logs + spans + profile on one time axis) → pin to investigation.

**Hide by default:** board catalogues, admin, unrelated services. **Show** ownership of upstream and
downstream.

#### AUD-017 — An alert opens into the Alert Lens
**MUST** · M-UI4 · SRE, NOC, IC

Opening an alert (from a notification, the alert drawer or a link) MUST open the Alert Lens, not the
rule definition. The Alert Lens MUST show the rows IMPACT (human units, baseline, SLO burn), TREND
(sparkline and direction), WHERE (breakdown and ⊕ origin), CHANGED (ranked changes with time
relative to onset), EVIDENCE (chips for chart, new log pattern, slowest trace, AI summary) and ACT
(runbook, open investigation, Ack, Silence, Page owner). It MUST be pre-computed so it is ready when
opened (PRF-013 in [09](09-performance-contract.md)).

*Acceptance:* On the storyboard replay, opening the HighErrorRate page shows all six rows populated
as in the sketch, with no spinner, when opened ≥ 10 s after the notification.

#### AUD-018 — Evidence chips fly with Context
**MUST** · M-UI4 · SRE, Engineer

Each evidence chip MUST open its target Lens or workbench with the alert's Context (entity, window,
filters, baseline) applied, from which the Correlate stack and pin to investigation are one action
each.

*Acceptance:* Clicking the "timeout calling payments" chip opens the Logs workbench filtered to that
pattern on `checkout` over the alert window; from there "Correlate" shows metrics, logs, spans and
profile on one time axis and `P` pins it.

#### AUD-019 — Show dependency ownership to the SRE
**MUST** · M-UI4 · SRE

In the SRE Perspective, the Alert Lens and entity Lens MUST show the owning team and on-call for the
entity's upstream callers and downstream dependencies, and MUST hide board catalogues, admin and
unrelated services by default.

*Acceptance:* The `checkout` Alert Lens lists the owners of gateway and payments with their on-call
person and a page action; no board catalogue or admin entry is shown in the SRE home.

### 5.3 Platform / DevOps engineer

**Moment:** owns shared infrastructure (Kubernetes clusters, nodes, networking, databases, queues,
CI/CD, the observability pipeline itself). Thinks in capacity, saturation and rollouts.

**Questions:** "Which clusters/nodes/DBs are saturated or about to be?" (USE: utilisation,
saturation, errors) · "Is this app problem actually an infra problem?" (noisy neighbour, node
pressure, DNS, network) · "Is the rollout healthy? Should I pause it?" · "What's costing us?" (log
volume, metric cardinality, over-provisioning) · "Is telemetry itself healthy?" (ingest lag, dropped
data from PulsusDB `/metrics`)

**First five seconds:** the Atlas in the Platform Perspective, laid out by cluster → node rather
than by service graph, with saturation encodings.

```
┌ Platform · clusters ───────────────────────────────────────────────────────────────────────────┐
│ k8s-core (eu-west-1)          CPU ▓▓▓▓▓▓▓░░ 71%  Mem ▓▓▓▓▓▓▓▓░ 84% ⚠  Pods 1 812/2 000          │
│   nodes ▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦▦ ▣▣ ← 2 nodes memory-pressure (heat-grid, 1 cell per node)    │
│ k8s-batch (eu-west-1)         CPU ▓▓▓▓▓▓▓▓▓ 93% ◐ (expected: nightly ETL)                        │
│ pg-orders (primary)           conns 480/500 ⚠  repl lag 0.2s  slow queries ▁▂▂█                 │
│ kafka-main                    consumer lag: orders-consumer ▁▁▂▅█ rising                          │
│ ROLLOUTS  checkout v2.31  ▓▓▓▓▓▓░░ 75%  canary error Δ +3.9pp ✖  [Pause] [Compare canary]        │
│ TELEMETRY ingest 1.2M samples/s · lag 0.8s · dropped 0 · log volume top: search (38%)           │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

[mockup](../mockups/03-infra-cluster.svg)

#### AUD-020 — Platform home: saturation by cluster and node
**MUST** · M-UI5 · Platform

The Platform Perspective home MUST lay out the estate by cluster → node and MUST show, as in the
sketch: per cluster CPU, memory and pod-count saturation; a heat grid with one cell per node; per
database connections vs limit, replication lag and slow queries; per queue consumer lag; active
rollouts; and telemetry-pipeline health (ingest rate, lag, dropped data, top log-volume sources).

*Acceptance:* On the seeded estate, the Platform home shows each listed item for `k8s-core`,
`k8s-batch`, `pg-orders`, `kafka-main`, the `checkout` v2.31 rollout and the telemetry line, with
⚠ on memory at 84% and connections at 480/500.

#### AUD-021 — Heat grids scale to thousands of instances
**MUST** · M-UI3 · Platform, NOC

Heat grids with one cell per node or pod MUST render thousands of instances in one view
([15](15-estate-navigation.md)), within the volume targets of [09](09-performance-contract.md).

*Acceptance:* A heat grid of 5 000 pods renders every pod as a cell and passes PRF-001 on (a).

#### AUD-022 — Rollout and canary compare
**MUST** · M-UI5 · Platform, Engineer, SRE

A rollout MUST be a first-class object showing progress and a baseline-vs-canary comparison on every
golden signal, with Pause and Compare canary actions.

*Acceptance:* For the `checkout` v2.31 rollout at 75%, the rollout row shows canary error Δ +3.9pp
marked ✖, and "Compare canary" opens a baseline-vs-canary view of latency, errors, traffic and
saturation.

#### AUD-023 — Cost lenses
**MUST** · M-UI3 · Platform

The product MUST provide cost views of log volume by service (PulsusDB `/volume`), a series
cardinality treemap and top label offenders.

*Acceptance:* On the seeded estate, the Cost layer shows `search` as the top log-volume source at
38%, a cardinality treemap by metric, and a ranked list of the labels contributing most series.

#### AUD-024 — Capacity forecasts
**SHOULD** · M-UI3 · Platform

Saturation views SHOULD show forecast lines with a plain-language horizon (e.g. "disk full in 6 days
at current growth").

*Acceptance:* Given a disk with linear growth that reaches capacity in 6 days, its capacity view
shows a forecast line and the text "full in 6 days at current growth".

### 5.4 Application engineer (service owner)

**Moment:** owns a handful of services, ships code daily; opens Pulsus after a deploy, when a ticket
mentions slowness, or when asked "is it your service?". Fluent in their code, less so in infra.

**Questions:** "Did my deploy make anything worse?" (latency, errors, CPU/memory, new log errors) ·
"Why is this endpoint slow? Which code path? Which query?" · "Which customers / tenants / requests
hit the bug?" · "Is it my code or my dependency?" · "Where do I spend CPU / allocate memory?"

**First five seconds:** a "My services" strip with release markers, and a Release Compare for the
latest deploy.

```
┌ checkout · v2.31 vs v2.30 ─────────────────────────────────────────────────────────────────────┐
│ Golden signals          v2.30       v2.31        Δ                                                │
│ p99 POST /pay           410 ms      2.84 s       ▲ 6.9×   [traces] [profile diff]                 │
│ errors                  0.1 %       4.1 %        ▲        [new pattern: "timeout calling…"]       │
│ CPU / req               3.1 ms      3.4 ms       ▲ 10%    [flame diff: json::encode +8%]          │
│ alloc / req             220 kB      221 kB       ≈                                                 │
│ New exception types     —           PaymentTimeoutException (×1 832)                               │
│ Endpoints most changed  POST /pay ▲▲▲  GET /cart ≈  POST /cart/item ≈                              │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

[mockup](../mockups/05-service-lens.svg)

#### AUD-025 — My services and Release Compare
**MUST** · M-UI5 · Engineer

The Engineer Perspective home MUST show a "My services" strip (the services the user's teams own)
with release markers, and a Release Compare of the latest deploy vs the previous version showing,
per golden signal and per changed endpoint, both values and the Δ, new exception types with counts,
and links to traces, profile diff, flame diff and new log patterns.

*Acceptance:* For `checkout` v2.31 vs v2.30 on the storyboard data, the compare shows the rows in
the sketch with Δ values ▲ 6.9× (p99 POST /pay) and ▲ 10% (CPU/req), and the
PaymentTimeoutException count ×1 832, without the user choosing any time range.

#### AUD-026 — Engineer drill path to code
**MUST** · M-UI3 · Engineer

From an endpoint the engineer MUST be able to drill: span scatter brush → attribute compare (e.g.
"slow requests: 100% have `payment.provider=psp-a`") → waterfall with critical path → span → that
span's profile or logs → code frame, with the code frame linking to the repository at the deployed
commit (via `service.version` → git SHA).

*Acceptance:* On the storyboard data, each step of the path is one gesture from the previous, and
the code-frame link opens the repository at the SHA mapped from `checkout` v2.31.

#### AUD-027 — Infra causes in plain English for engineers
**MUST** · M-UI3 · Engineer

Cluster plumbing MUST be hidden from the Engineer Perspective unless it is the probable origin; then
it MUST be shown as ⊕ origin with a plain-English explanation (e.g. "node ip-10-2-3-4 is under memory
pressure; 3 of your pods run there").

*Acceptance:* Given a node under memory pressure hosting 3 of a service's pods and ranked ⊕, the
service's Lens shows that sentence; with no infra origin, no node-level entity appears in the Lens.

### 5.5 Business users: product owners, executives, customer support

**Moment:** the product owner checks the morning numbers; an exec is asked "was yesterday's outage
material?"; support takes a call "customer ACME can't log in — is it us?". They will never write a
query and should never see one unless they ask.

**Questions:** "Can customers do the things that make us money right now?" (sign up, log in, search,
check out, pay) · "How much did the incident cost? How many customers were affected?" · "Are we
meeting our SLAs to key customers?" · Support: "Is customer X affected? Since when? When will it be
fixed?"

**First five seconds:** Journeys, not services.

```
┌ Business · Customer journeys · last 24h ───────────────────────────────────────────────────────┐
│ Journey         Health   Success   Volume (vs last wk)     Impact now          SLA (30d)          │
│ Sign-in         ●        99.97%    ▁▂▃▅▇▇▅▃▂ (+2%)         —                   99.95% ✓           │
│ Search          ●        99.90%    ▁▂▃▅▇▇▅▃▂ (−1%)         —                   99.9%  ✓           │
│ Checkout        ●        91.2%     ▁▂▃▅▇▆▃▂▂ (−9%)         €38k/h at risk      99.5%  ⚠ at risk   │
│                 └ Incident INC-2041 · payments provider slow · team on it 12m · ETA: rollback   │
│ Account mgmt    ●        99.99%    ...                     —                   ✓                  │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Checkout funnel   Cart 12.4k ─► Address 11.9k ─► Payment 11.6k ─► Confirm 10.6k  (−8.6% at Payment)│
│ Key customers     ACME ● Globex ◐ Initech ●   [Lookup customer…]                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### AUD-028 — Journeys home
**MUST** · M-UI5 · Business, Support

The Business Perspective home MUST list Journeys with, per row: health state, success rate, volume
sparkline with change vs last week, impact now (€ at risk), and SLA attainment over 30 days with
status; a Journey with an active incident MUST show the incident ID, plain-language summary, owner
engagement time and ETA. Below, it MUST show the funnel of the most-impacted Journey and the health
of key customers with a customer lookup.

*Acceptance:* On the storyboard data, the home matches the sketch: Checkout 91.2%, −9%, €38k/h at
risk, SLA ⚠ at risk, INC-2041 line, funnel with −8.6% at Payment, and ACME/Globex/Initech states.

#### AUD-029 — Journeys are defined once and proposed automatically
**MUST** · M-UI5 · Engineer, Business

A Journey MUST be definable (once, by an engineer) as a set of entry routes/spans, success criteria,
ordered steps and optional business metrics (e.g. `orders_total`, average order value). Pulsus MUST
propose candidate Journeys from the top HTTP routes in traces; a proposal MUST NOT become active
until a human names and approves it.

*Acceptance:* On the seeded estate, the Journey editor lists proposals derived from the top routes;
an unapproved proposal does not appear on the Journeys home; after naming and approval it does.

#### AUD-030 — Transparent impact in money and people
**MUST** · M-UI5 · Business, Support, IC

Impact MUST be shown in money and people where configured, and every figure MUST show its formula on
hover (e.g. "failed checkouts × avg order value (€74)"). The source of business values MAY be
configuration constants, business metrics in PulsusDB, or both.

*Acceptance:* Hovering "€38k/h at risk" shows the formula, its inputs and their sources.

#### AUD-031 — Funnel steps map to services
**MUST** · M-UI5 · Business, Engineer

The Journey funnel MUST show where users drop between steps and MUST map each step to the service
responsible; clicking a step MUST open the engineer view of that service if the user is permitted.

*Acceptance:* Clicking the Payment step opens the `payments` Lens for a user with access, and shows
"you don't have access to this service's details" for one without.

#### AUD-032 — Customer lookup
**MUST** · M-UI5 · Support, Business

Support MUST be able to look up a customer or tenant by an identifier taken from a configurable span
or log attribute (e.g. `enduser.id`, `tenant.id`) and receive a plain-language summary: request count
and failures in the last hour, where they failed, since when, linked incident and its status.
Customer identifiers are PII-governed ([11](11-enterprise.md)).

*Acceptance:* Looking up ACME on the storyboard data returns "ACME: 312 requests in last hour, 41
failed, all at Payment step, since 12:22, linked incident INC-2041, status: rollback in progress."

#### AUD-033 — Plain-language incident status
**MUST** · M-UI4 · Business, Support, IC

Each incident MUST have a plain-language status written and kept fresh by the incident commander or
drafted by the AI from the Investigation; business users MUST see that summary and MUST NOT see raw
logs unless RBAC grants it.

*Acceptance:* A Business user opening INC-2041 sees the status line and its last-updated time, and
no log, trace or query content.

#### AUD-034 — Business users never see a query unless they ask
**MUST** · M-UI5 · Business, Support

The Business and Support Perspectives MUST NOT show query text by default; a user MAY reveal it
explicitly.

*Acceptance:* No query text is visible on any Business or Support Perspective surface until the user
chooses "show query".

#### AUD-035 — Exec digest
**SHOULD** · M-UI5 · Business

Pulsus SHOULD produce a weekly and monthly digest page of SLA attainment, incident minutes and top
causes: a page, not a dashboard.

*Acceptance:* The digest for a seeded month lists SLA attainment per Journey, total incident minutes
and the top three causes, as one readable page.

### 5.6 Incident commander

**Moment:** coordinating a SEV1/SEV2 with many responders: not debugging, orchestrating.

**Questions:** "What do we know? Who is doing what? What's the current hypothesis? What's the
customer impact right now? What do I tell stakeholders?"

[mockup](../mockups/13-investigation.svg)

#### AUD-036 — Investigation for the incident commander
**MUST** · M-UI4 · IC, SRE

The Investigation surface ([04](04-surfaces.md)) MUST provide a live impact header (from the
Business Perspective), a hypotheses board, presence (who is looking at what) with "follow camera",
task assignment, and an AI-drafted stakeholder update (e.g. "draft status update for
#exec-incidents") that the IC edits before it is posted.

*Acceptance:* In INV-2041, the IC sees the €38k/h impact header, the hypothesis H1, each
participant's current view, can follow Sam's camera, assign a task, and post an AI draft only after
editing or confirming it.

### 5.7 Summary matrix

| | NOC | SRE on-call | Platform/DevOps | App engineer | Business / support |
|---|---|---|---|---|---|
| **Primary object** | Incident | Alert → entity | Cluster/node/DB, rollout | Service, endpoint, release | Journey, customer |
| **Altitude** | 4 | 3–4 | 2 | 1–3 | 5 |
| **Home view** | Wall + incident queue | Alert Lens / My on-call | Platform Atlas | My services + release compare | Journeys + customer lookup |
| **Key encoding** | Status, owner, trend | Impact, origin, change | Saturation heat grids, forecasts | Deltas vs previous release | Success %, € at risk, SLA |
| **Typical drill** | Incident → owner → page | Card → evidence → correlate | Cluster → node → pods | Endpoint → spans → profile → code | Journey → step → (handoff) |
| **Writes queries?** | Never | Rarely | Often (PromQL) | Sometimes (TraceQL/LogQL) | Never |
| **AI's main role** | Group alerts, summarise | First-pass triage, hypotheses | Capacity forecasts, anomaly scan | Release regression explanation | Plain-language status & impact |
| **Device** | 4K wall + console | Laptop, phone | Large monitor | Laptop | Laptop, phone |

## 6. Presentation principles for finding problems fast

| # | Principle | Requirement |
|---|---|---|
| 1 | Calm by default | AUD-037 |
| 2 | Three numbers max per tile at first glance | AUD-038 |
| 3 | Always show the baseline | AUD-039 |
| 4 | Human units first, technical units on demand | AUD-040 |
| 5 | Every red explains itself | AUD-009 |
| 6 | Victims recede, origins pop | AUD-006 |
| 7 | Show data trust | AUD-041 |
| 8 | Consistent drill gesture | AUD-042 |
| 9 | Words match the reader | AUD-043 |
| 10 | No dead ends | AUD-044 |

#### AUD-037 — Calm by default
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business

A healthy estate MUST look quiet: neutral greys and low motion. Colour and motion MUST be reserved for
things that need attention ([08](08-visual-language.md)).

*Acceptance:* A seeded all-OK estate renders with no semantic state colour and no motion other than
traffic particles; turning one entity Degraded makes it the only coloured element.

#### AUD-038 — Three numbers max per tile
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support

A tile MUST show at most three numbers at first glance; everything else MUST be on hover or inspect.

*Acceptance:* A review of every tile type in [05](05-visualisation-catalogue.md) finds no tile with
more than three numbers in its default state.

#### AUD-039 — Always show the baseline
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support

Every value shown MUST come with its expected range (a ghost band, or text such as "normal 0.1%").

*Acceptance:* Every impact line, tile value and Alert Lens figure on the storyboard replay shows a
baseline value or band.

#### AUD-040 — Human units first
**MUST** · M-UI2 · NOC, SRE, Business, Support, IC

Values MUST lead with human units ("2 900 users" before "4.1%"; "since 12:22 (40 min)" before a
timestamp), with technical units available on demand.

*Acceptance:* The Alert Lens IMPACT row shows the affected-user estimate and the relative onset
before the percentage and the absolute timestamp.

#### AUD-041 — Show data trust
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support

Every viewport MUST show a freshness indicator; gaps in data MUST be drawn as gaps and never
interpolated; and truncated results MUST show a "partial data" badge (PRF-031 in
[09](09-performance-contract.md)).

*Acceptance:* A series with a 5-minute gap renders a visible break, not a line across it; a PulsusDB
response with `truncated=true` shows the partial-data badge; every viewport shows its data age.

#### AUD-042 — Consistent drill gesture
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support, IC

Double-click and `Enter` MUST always mean "go deeper here", and `Esc` MUST always mean "go back up",
on every surface with no surface-specific exception ([03](03-interaction-model.md)).

*Acceptance:* On every surface in [04](04-surfaces.md), double-click and `Enter` on a selected item
descend one level and `Esc` ascends one level.

#### AUD-043 — Words match the reader
**MUST** · M-UI5 · Business, Support, Engineer

Each entity MUST support a business display name and a technical name; the Perspective MUST choose
which is shown (e.g. Business: "Checkout", "customers", "payment step"; Engineer: `checkout`,
`POST /pay`, `payments-svc`).

*Acceptance:* The same entity shows "Checkout" in the Business Perspective and `checkout` in the
Engineer Perspective, on the same URL.

#### AUD-044 — No dead ends
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every view MUST offer at least one pivot deeper and one pivot sideways. A screen that shows a problem
and offers no next step is a defect.

*Acceptance:* A review of every surface and every Lens template finds at least one deeper and one
sideways pivot available from each view.

## 7. Perspectives

A **Perspective** is a named bundle of presentation defaults over the same space and data.

| Perspective setting | Example: Business | Example: Platform |
|---|---|---|
| Home surface | Journeys | Platform Atlas |
| Default Atlas layout & grouping | Journeys → services (flow) | Cluster → node |
| Node encodings | Success %, € at risk | CPU/mem saturation, pod density |
| Vocabulary / display names | Business names | Technical names |
| Detail ceiling | Stops at service level unless the user opts in | Full depth |
| Lens template set | "Journey Lens" | "Node Lens", "DB Lens" |
| Alert view | Incidents only, plain language | All alerts incl. infra |
| AI tone | Plain language, impact first | Technical, query first |

#### AUD-045 — Perspective settings
**MUST** · M-UI5 · NOC, SRE, Platform, Engineer, Business, Support, Admin

A Perspective MUST define every setting in the table above: home surface, default Atlas layout and
grouping, node encodings, vocabulary, detail ceiling, Lens template set, alert view and AI tone.

*Acceptance:* Switching between the Business and Platform Perspectives changes each of the eight
settings as in the table, with the same Context.

#### AUD-046 — Built-in and custom Perspectives
**MUST** · M-UI5 · Admin

Pulsus MUST ship the built-in Perspectives NOC, SRE, Platform, Engineer, Business, Support and Exec.
Organisations MUST be able to clone and edit them; built-ins and org overrides are stored in
PostgreSQL.

*Acceptance:* An admin clones "Platform" to "DB team", changes its home to the DB Lens, and members
assigned to it land there; the original "Platform" is unchanged.

#### AUD-047 — Perspectives set defaults; RBAC limits
**MUST** · M-UI5 · Business, Support, Admin

A user's default Perspective MUST come from their team or role. A Perspective MUST only set
defaults; access limits come from RBAC ([11](11-enterprise.md)). A user with permission MUST always
be able to "view as engineer".

*Acceptance:* A Business user with Engineer-level read permission can switch to "view as engineer"
and see the full depth; one without it gets the RBAC-limited view regardless of Perspective.

#### AUD-048 — Same URL, recipient's Perspective
**MUST** · M-UI5 · NOC, SRE, Business, Support, IC

A shared link MUST carry Context; the recipient MUST see it in their own Perspective unless the
sender pinned one.

*Acceptance:* An SRE shares an incident link with a VP; the VP sees it in the Exec Perspective; when
the SRE pins "SRE" before sharing, the VP sees it in SRE.

#### AUD-049 — Perspective switcher
**MUST** · M-UI5 · NOC, SRE, Platform, Engineer, Business, Support

The Perspective MUST be switchable from the top-bar avatar menu and from the command palette with
"view as…".

*Acceptance:* Both the avatar menu and `⌘K` "view as Platform" switch the Perspective without
changing Context.

## 8. One incident, six screens (validation scenario)

The same moment, 12:30: the external payment provider is slow after a timeout config change. If any
of these people would need to write a query or open a second tool to reach their "next click", the
design has failed the scenario.

| Who | What they see without doing anything | Their next click |
|---|---|---|
| **Exec (phone)** | Push: "Checkout degraded — ~9% of purchases failing, ~€38k/h at risk. Team engaged, rollback in progress." | None; trusts the status line |
| **Support** | Banner in customer lookup: "Checkout issue affecting card payments since 12:22 (INC-2041)." ACME → affected | Copies the status into the ticket reply |
| **NOC** | One merged incident (14 alerts), ⊕ psp-api, ACK @sam, trend ↗ | Pages the payments team (owner of the psp-api client) |
| **SRE (Sam)** | Alert Lens: impact, ⊕ origin, ⚙ timeout change 12:19 adjacent to onset | Reverts config; watches trend flip ↘ |
| **App engineer (Priya)** | Release compare v2.31: new `PaymentTimeoutException`; flame diff unchanged → not a code regression | Adds retry-budget fix; marks hypothesis H2 (code regression) invalidated |
| **Platform (Lee)** | Nothing red in clusters; `pg-orders` fine → ruled out in seconds | Adds note "infra ruled out" to the investigation |

[mockup](../mockups/17-mobile-alert-card.svg)

#### AUD-050 — Validation scenario is an acceptance test
**MUST** · M-UI5 · NOC, SRE, Platform, Engineer, Business, Support, IC

On the replayed scenario above, each of the six roles MUST see the content in the "What they see"
column without any action beyond opening Pulsus in their Perspective (or the notification), and MUST
reach their "next click" without writing a query or opening a second tool. Each milestone from
M-UI4 MUST pass the rows whose features it delivers; M-UI5 MUST pass all six.

*Acceptance:* Scripted run of the replay per role: every "What they see" item is on screen on first
paint, and the "next click" is reachable with zero typed queries and no navigation outside Pulsus.

## 9. Validation and research

The design research plan is non-normative except for in-product telemetry:

1. **Interviews** (5–8 per audience) at Digitalis customers: walk through their last real incident;
   map the actual drill path and every tool switch. Output: journey maps per persona.
2. **Task-based usability tests** on prototypes with timed tasks: "find the cause" (MTTI), "is
   customer X affected" (time-to-answer), "did the deploy regress", against a baseline of the incumbent dashboard tool.
3. **Five-second tests** for each Perspective home: show it for 5 s, ask "what's wrong and where?".
4. **Wall test:** NOC view read at 5 m by people with colour-vision deficiencies (AUD-016).
5. **In-product telemetry** (AUD-051).

#### AUD-051 — Privacy-respecting product telemetry
**SHOULD** · M-UI4 · Admin, SRE

Pulsus SHOULD record, in a privacy-respecting way (aggregate, no telemetry content), clicks to root
cause, pivot usage, dead-end rate (views left with no further action) and time on the Alert Lens
before action, and expose them to administrators.

*Acceptance:* After the replay scenario, the product-usage report shows clicks to root cause, pivot
counts by type, dead-end rate and Alert Lens dwell time, with no entity names or telemetry values.

## 10. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| AUD-001 | Altitudes are connected in one click | MUST | M-UI5 |
| AUD-002 | One incident, one set of facts | MUST | M-UI4 |
| AUD-003 | Funnel primitives on every surface | MUST | M-UI2 |
| AUD-004 | How bad, where, what changed: never leave the screen | MUST | M-UI3 |
| AUD-005 | Probable-origin heuristic | MUST | M-UI3 |
| AUD-006 | Victims recede, origins pop | MUST | M-UI3 |
| AUD-007 | Five-state health, computed the same everywhere | MUST | M-UI2 |
| AUD-008 | Missing data is never healthy | MUST | M-UI2 |
| AUD-009 | Every non-OK state explains itself | MUST | M-UI2 |
| AUD-010 | Care is the default order | MUST | M-UI2 |
| AUD-011 | Change Feed sources | MUST | M-UI3 |
| AUD-012 | Changes ranked and shown in three places | MUST | M-UI3 |
| AUD-013 | Alerts grouped into incidents by topology and time | MUST | M-UI4 |
| AUD-014 | NOC incident queue | MUST | M-UI4 |
| AUD-015 | New, un-owned problems announce themselves once | MUST | M-UI4 |
| AUD-016 | Wall readability and attract mode | MUST | M-UI6 |
| AUD-017 | An alert opens into the Alert Lens | MUST | M-UI4 |
| AUD-018 | Evidence chips fly with Context | MUST | M-UI4 |
| AUD-019 | Show dependency ownership to the SRE | MUST | M-UI4 |
| AUD-020 | Platform home: saturation by cluster and node | MUST | M-UI5 |
| AUD-021 | Heat grids scale to thousands of instances | MUST | M-UI3 |
| AUD-022 | Rollout and canary compare | MUST | M-UI5 |
| AUD-023 | Cost lenses | MUST | M-UI3 |
| AUD-024 | Capacity forecasts | SHOULD | M-UI3 |
| AUD-025 | My services and Release Compare | MUST | M-UI5 |
| AUD-026 | Engineer drill path to code | MUST | M-UI3 |
| AUD-027 | Infra causes in plain English for engineers | MUST | M-UI3 |
| AUD-028 | Journeys home | MUST | M-UI5 |
| AUD-029 | Journeys are defined once and proposed automatically | MUST | M-UI5 |
| AUD-030 | Transparent impact in money and people | MUST | M-UI5 |
| AUD-031 | Funnel steps map to services | MUST | M-UI5 |
| AUD-032 | Customer lookup | MUST | M-UI5 |
| AUD-033 | Plain-language incident status | MUST | M-UI4 |
| AUD-034 | Business users never see a query unless they ask | MUST | M-UI5 |
| AUD-035 | Exec digest | SHOULD | M-UI5 |
| AUD-036 | Investigation for the incident commander | MUST | M-UI4 |
| AUD-037 | Calm by default | MUST | M-UI2 |
| AUD-038 | Three numbers max per tile | MUST | M-UI2 |
| AUD-039 | Always show the baseline | MUST | M-UI2 |
| AUD-040 | Human units first | MUST | M-UI2 |
| AUD-041 | Show data trust | MUST | M-UI1 |
| AUD-042 | Consistent drill gesture | MUST | M-UI2 |
| AUD-043 | Words match the reader | MUST | M-UI5 |
| AUD-044 | No dead ends | MUST | M-UI2 |
| AUD-045 | Perspective settings | MUST | M-UI5 |
| AUD-046 | Built-in and custom Perspectives | MUST | M-UI5 |
| AUD-047 | Perspectives set defaults; RBAC limits | MUST | M-UI5 |
| AUD-048 | Same URL, recipient's Perspective | MUST | M-UI5 |
| AUD-049 | Perspective switcher | MUST | M-UI5 |
| AUD-050 | Validation scenario is an acceptance test | MUST | M-UI5 |
| AUD-051 | Privacy-respecting product telemetry | SHOULD | M-UI4 |

## 11. Resolved during formalisation

1. **"Five screens" vs six rows.** The draft's validation scenario was titled "one incident, five
   screens" but lists six roles. Retitled "six screens"; all six rows are acceptance criteria
   (AUD-050).
2. **Validation scenario vs milestones.** The draft made the scenario an acceptance test "for M-UI
   milestones" generally, but Business, Support and Release Compare land in M-UI5. AUD-050 requires
   each milestone from M-UI4 to pass the rows it can and M-UI5 to pass all six.
3. **NOC trend arrow in the scenario.** The scenario shows the NOC trend as ↗ while the NOC sketch
   shows ↘ improving later (14:02). Both are kept: they are different moments (12:30 vs 14:02).
4. **Exec as an audience.** The Exec Perspective is kept; Exec maps to the **Business** audience
   short name in requirement blocks.
5. **Health thresholds.** The draft made only the Degraded threshold explicitly configurable.
   AUD-007 makes both burn thresholds (2×, 10×) tenant-configurable defaults, to avoid an asymmetric
   rule.
6. **Unknown timing.** "Freshness > 2× scrape interval" gives no evaluation tolerance; AUD-008 allows
   one evaluation interval on top.
7. **Change-feed storage.** Derived change events are Dash-derived state and live in PostgreSQL (D2).
8. **Business value source.** The draft left the € source open (roadmap Q9, leaning "both"). AUD-030
   permits both with the formula always visible.

## 12. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft |
