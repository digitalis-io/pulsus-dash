# 01 — Vision & principles

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Requirement area** | `PRN` |
| **Source draft** | plans/01-vision-and-principles.md (not tracked) |
| **Depends on** | [01a](01a-audiences-and-perspectives.md), [02](02-information-architecture.md), [03](03-interaction-model.md), [04](04-surfaces.md), [06](06-ai-copilot.md), [09](09-performance-contract.md), [11](11-enterprise.md), [12](12-roadmap.md) |
| **Mockups** | [01-landscape-map](../mockups/01-landscape-map.svg), [05-service-lens](../mockups/05-service-lens.svg), [09-alert-lens](../mockups/09-alert-lens.svg) |

## 1. Purpose & scope

This document states what Pulsus Dash is for, the success metric it is designed to, the eight
design principles every other product document applies, the personas, the ranked jobs to be done
and the v1 non-goals. The principles are normative where they are testable; the detailed
behaviour lives in the documents each requirement points to.

The market and competitor analysis that informed this vision is research and is not part of the
specification: see 01b and 01c (research, not tracked).

## 2. Definitions

| Term | Meaning |
|---|---|
| **MTTI** | Mean time to identify: the time from an alert firing to the linked investigation being marked "root cause identified", measured in-product |
| **Entity** | A thing that emits telemetry (service, host, pod, …), defined in [02](02-information-architecture.md) |
| **Context** | The sticky tuple (entity set, time window, filters, comparison baseline), defined in [02](02-information-architecture.md) |
| **Scene** | Anything rendered on the GPU canvas, defined in [02](02-information-architecture.md) |
| **Semantic zoom** | Zoom that changes the visualisation as levels of detail are crossed, defined in [03](03-interaction-model.md) |
| **Perspective** | A role-tuned bundle of presentation defaults, defined in [01a](01a-audiences-and-perspectives.md) |

## 3. The problem we design against

The panel-grid dashboard model that incumbent dashboard tools established has aged. Pulsus Dash is designed against
these specific pain points (non-normative; each answer is made normative by the requirement or
document cited).

| Panel-grid model today | Consequence for the operator | Pulsus answer | Where specified |
|---|---|---|---|
| Dashboard = grid of independent panels, each its own DOM/canvas chart firing its own queries | Slow load, janky scrolling, 40 spinners, browser falls over at ~50 panels | One GPU canvas renders every panel; queries are planned per *scene*, deduplicated and streamed | PRN-003, [09](09-performance-contract.md) |
| Datasource-first: pick a metrics, logs or traces datasource, then write a query | You must already know *where* the answer is and *how* to ask | Entity-first: pick *the thing*; all signals for it arrive automatically | PRN-004 |
| Signals live in separate apps (metrics, logs, traces, profiles) with thin links | Correlation is copy-pasting labels and time ranges between tabs | One continuous space; any selection pivots to any signal keeping entity + time context | PRN-006 |
| Charts are static images you can only box-zoom, then wait for a re-query | Exploration feels like filling forms | Inertial pan/zoom at 60 fps on client-held data; refinement streams in under the cursor | PRN-003, [03](03-interaction-model.md) |
| No sense of topology: services are rows in a table | The blast radius of a failure is invisible | The Atlas: a navigable 3D/2.5D map of the estate with live traffic edges | [15](15-estate-navigation.md), [04](04-surfaces.md) |
| Time picker is a dropdown | Comparing "now vs before" is laborious | Time is a spatial axis: scrub, rewind, ghost-overlay previous periods | [03](03-interaction-model.md) |
| Alerting bolted on; rule editor disconnected from the data | Rules are written blind and tuned by being paged | Author rules *on* a chart, with instant backtest over history | [07](07-alerting.md) |
| AI as a chat sidebar | Answers are disconnected text you must verify by hand | AI drives the same UI: builds the views, flies the camera, cites the data | PRN-009, [06](06-ai-copilot.md) |

## 4. Product statement and success metric

> **Pulsus Dash lets an engineer go from "something is wrong" to "this is why" in under two
> minutes, by navigating all telemetry as one continuous, GPU-rendered space — with an AI partner
> that can drive that space.**

#### PRN-001 — MTTI is measured in-product
**MUST** · M-UI4 · SRE, IC, Admin

Pulsus Dash MUST measure MTTI for every incident as the interval from the first alert firing to the
linked investigation being marked "root cause identified", and MUST make the per-incident value and
the rolling mean available to the incident's participants and to administrators.

*Acceptance:* Given an alert that fired at T0 and whose investigation is marked "root cause
identified" at T1, when the investigation is viewed, then it shows MTTI = T1 − T0 (to the second),
and the tenant's MTTI report includes that incident in its rolling mean.

#### PRN-002 — Two-minute identification target on the validation scenario
**SHOULD** · M-UI4 · SRE, Engineer

On the validation scenario of [01a](01a-audiences-and-perspectives.md) §8 replayed from recorded
telemetry, a trained on-call engineer SHOULD reach "root cause identified" in under two minutes
from opening the alert, without writing a query.

*Acceptance:* In timed usability tests on the replayed scenario (n ≥ 5 participants), the median
time from opening the alert to marking root cause identified is < 120 s and no participant types a
query.

## 5. Design principles

The eight principles below rank ahead of feature requests: a feature that violates one is
redesigned or dropped.

#### PRN-003 — Speed is the feature
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

Interaction MUST run at 60 fps (120 fps where the display supports it), input to photon MUST be
under one frame, and no interaction MAY block on the network: the UI shows the data it has and
refines it. The numbers are the performance contract in [09](09-performance-contract.md).

*Acceptance:* Every requirement in [09](09-performance-contract.md) passes its CI gate; in
particular PRF-001 (60 fps), PRF-003 (≤ 1 frame input to photon) and PRF-006 (no network wait
during interaction).

#### PRN-004 — Entity first, query last
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support

Users MUST be able to reach every signal (metrics, logs, traces, profiles) for an entity by choosing
the entity (a service, host, deployment, …), without first choosing a datasource or writing a query.
Queries MUST remain visible and editable for every view, as an expert tool rather than the front
door.

*Acceptance:* Given a service that emits all four signals, when a user selects it from the command
palette, then its Lens shows metrics, logs, traces and profiles with no datasource picker shown and
no query typed, and each viewport's Inspector shows its editable query.

#### PRN-005 — One space, many depths
**MUST** · M-UI3 · SRE, Platform, Engineer

Fleet → cluster → service → instance → span → stack frame MUST be a single continuous semantic zoom
in which every level shows the visualisation appropriate to that level automatically
([03](03-interaction-model.md) §5).

*Acceptance:* Starting from the Landscape, a user reaches a stack frame of a span by zoom and dive
gestures only, with no page load and with each level's visualisation chosen without user input.

#### PRN-006 — Context is sticky
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Entity, time range, filters and comparison baseline MUST travel across every view and pivot under
the propagation rules of [02](02-information-architecture.md) §4. A user MUST never have to re-type
a label or re-pick a time range to continue the same line of enquiry.

*Acceptance:* Given a Context with a filter and a brushed time range, when the user pivots from a
metric to logs, traces and profiles in turn, then each target view opens with the same entity set,
time window, translated filters and baseline, and no input is required.

#### PRN-007 — Navigate like a game
**MUST** · M-UI3 · SRE, Platform, Engineer, NOC

Navigation MUST offer direct manipulation, inertia, a predictable camera, muscle-memory keys, a
minimap and waypoints ([03](03-interaction-model.md)). The core navigation MUST be learnable in one
minute.

*Acceptance:* In a usability test, ≥ 80% of first-time participants complete "find the failing
service, dive into it and come back out" within 60 s after a 60 s introduction.

#### PRN-008 — Anomalies find you
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business

Every view that shows an entity or series MUST paint its deviation from baseline (heat, glow or
bands) so that attention goes to the problem before a number is read.

*Acceptance:* Given a scene where one series deviates beyond its baseline band, when it renders,
then that series is visibly encoded (glow, heat or band breach per [08](08-visual-language.md)) and
in-baseline series are not.

#### PRN-009 — AI is a co-pilot, not an oracle
**MUST** · M-UI4 · SRE, Engineer, Platform, IC, Business

The AI MUST act through the same UI the human uses, MUST show every query it runs, MUST cite every
claim with a clickable view, and MUST NOT mutate production configuration without explicit human
confirmation. Details are in [06](06-ai-copilot.md).

*Acceptance:* For every AI answer in the evaluation corpus, every claim carries a citation that
opens the cited view, every query run is listed, and every proposed configuration change requires a
confirmation click that is recorded in the audit log before it is applied.

#### PRN-010 — Enterprise without ceremony
**MUST** · M-UI6 · Admin, SRE, IC

RBAC, audit, multi-tenancy, SSO and version history MUST be present and strict but invisible until
needed: no administration screen MAY be in the critical path of an incident ([11](11-enterprise.md)).

*Acceptance:* The validation scenario of [01a](01a-audiences-and-perspectives.md) §8 is completed
by every role without visiting an administration screen, while every view and change made is in the
audit log.

## 6. Personas

The short persona set is below; each audience's questions, first-five-seconds view and drill path
are in [01a](01a-audiences-and-perspectives.md). The **Audience** column is the short name used in
requirement blocks.

| Persona | Audience | Context | What they need from Pulsus |
|---|---|---|---|
| On-call SRE ("Sam") | SRE | Paged at 03:00 on a laptop, half awake | One click from alert to the failing entity with evidence pre-gathered; zero query writing; fast enough on hotel Wi-Fi |
| Service owner ("Priya") | Engineer | Owns 6 microservices, ships daily | "Did my deploy break anything?": before/after comparison, her services' health at a glance, latency/profile diffs per release |
| Platform engineer ("Lee") | Platform | Runs the Kubernetes estate / ClickHouse / networks | Fleet-wide topology, saturation, capacity trends; builds boards for others; writes PromQL fluently |
| Incident commander ("Ana") | IC | Coordinates a SEV1 with 10 people | A shared investigation space, timeline, who-is-looking-at-what, an exportable post-mortem |
| Engineering manager / exec ("Jo") | Business | Weekly review, large display / NOC wall | SLOs, error budgets, a beautiful ambient overview that is honest |
| Business / support ("Morgan") | Business, Support | Product owner, support agent, exec on a phone | Journeys and customers, not services; impact in € and users; plain-language incident status |
| NOC operator ("Ravi") | NOC | Wall of screens, hundreds of services owned by others | Calm estate view, merged incidents, owner + trend, one-click escalate |
| Admin ("Kai") | Admin | Owns SSO, RBAC, tenants, compliance | Teams, roles, folders, audit log, data-access policies per tenant |

## 7. Jobs to be done

Ranked; the rank breaks ties between competing designs.

| Rank | Job | Description |
|---|---|---|
| 1 | Triage an alert | What is broken, how badly, since when, blast radius |
| 2 | Find root cause | Correlate metrics ⇄ logs ⇄ traces ⇄ profiles for the affected entity and window |
| 3 | Validate a change | Deploy / config / scaling: compare before vs after |
| 4 | Ambient awareness | NOC wall / team TV: the estate at a glance |
| 5 | Build and share views | Boards for a team, links in Slack, embeds in runbooks |
| 6 | Define alerting | Rules that fire on the right thing, tuned against history |
| 7 | Capacity & cost | Trends, saturation, top talkers (log volume, cardinality) |
| 8 | Govern | Who can see which tenant's data; audit what was viewed/changed |

#### PRN-011 — Every surface traces to a job
**MUST** · M-UI1 · Admin

Every surface specified in [04](04-surfaces.md) MUST name the job or jobs (by rank in §7) that it
serves. A surface that serves none MUST NOT ship.

*Acceptance:* Every surface section in [04](04-surfaces.md) lists at least one job rank from §7;
a review of the document finds no surface without one.

## 8. Non-goals (v1)

#### PRN-012 — Observability signals only, not general BI
**MUST** · M-UI1 · Platform, Admin

v1 MUST visualise observability signals from PulsusDB, plus (later) a small set of compatible
Prometheus-API sources read-only. It MUST NOT be a general BI/SQL tool or a plugin marketplace for
arbitrary datasources.

*Acceptance:* The datasource configuration offers only PulsusDB and, once enabled, Prometheus-API
compatible read-only sources; no SQL datasource or third-party datasource plugin can be installed.

#### PRN-013 — Dashboard importer, not a clone of existing dashboard tools
**MUST** · M-UI5 · Platform, Engineer

Pulsus Dash MUST provide a dashboard importer that maps existing dashboards (common open dashboard
JSON formats) into Boards with the panel parity defined in [05](05-visualisation-catalogue.md) §11.
Pixel compatibility with the source tool's panels is a non-goal.

*Acceptance:* Importing an existing dashboard JSON produces a Board whose viewports correspond one to
one to the source panels per the [05](05-visualisation-catalogue.md) §11 mapping, with unmapped
features listed in an import report.

#### PRN-014 — Mobile is read, acknowledge and AI only
**MUST** · M-UI4 · SRE, Business, Support

The mobile client MUST support reading, acknowledging and AI chat, and MUST NOT offer authoring
(boards, rules, routing, administration). Mobile-first authoring is a non-goal.

*Acceptance:* On reference device (d) or (e) of [09](09-performance-contract.md), a user can open
an alert, acknowledge it and ask the AI about it; no edit or create action for boards, rules,
routing or administration is reachable.

## 9. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| PRN-001 | MTTI is measured in-product | MUST | M-UI4 |
| PRN-002 | Two-minute identification target on the validation scenario | SHOULD | M-UI4 |
| PRN-003 | Speed is the feature | MUST | M-UI0 |
| PRN-004 | Entity first, query last | MUST | M-UI2 |
| PRN-005 | One space, many depths | MUST | M-UI3 |
| PRN-006 | Context is sticky | MUST | M-UI1 |
| PRN-007 | Navigate like a game | MUST | M-UI3 |
| PRN-008 | Anomalies find you | MUST | M-UI2 |
| PRN-009 | AI is a co-pilot, not an oracle | MUST | M-UI4 |
| PRN-010 | Enterprise without ceremony | MUST | M-UI6 |
| PRN-011 | Every surface traces to a job | MUST | M-UI1 |
| PRN-012 | Observability signals only, not general BI | MUST | M-UI1 |
| PRN-013 | Dashboard importer, not a clone of existing dashboard tools | MUST | M-UI5 |
| PRN-014 | Mobile is read, acknowledge and AI only | MUST | M-UI4 |

## 10. Resolved during formalisation

1. **Exec persona vs audience list.** The draft persona "Jo" (manager/exec) has no audience short
   name in the conventions. Jo is mapped to **Business**; the Exec Perspective still exists
   ([01a](01a-audiences-and-perspectives.md) §5).
2. **Product statement as a requirement.** The draft's "under two minutes" is a design target, not
   a guarantee for every incident. It is formalised as SHOULD PRN-002 on the replayed validation
   scenario; the measurable MUST is PRN-001 (MTTI instrumentation).
3. **Prometheus-API sources.** The non-goal said "later, a small set of compatible Prometheus-API
   sources"; the roadmap leaning (Q5) is read-only Prometheus-API compatible sources. PRN-012
   adopts read-only.
4. **Competitive narrative.** The problem table is kept as design rationale; the market framing
   was moved out to 01b/01c (research, not tracked).

## 11. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft |
