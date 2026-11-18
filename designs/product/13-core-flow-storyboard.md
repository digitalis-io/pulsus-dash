# 13 — Core flow storyboard: from page to post-mortem

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Requirement area** | `SCN` (acceptance scenarios) |
| **Source draft** | plans/13-core-flow-storyboard.md (not tracked) |
| **Depends on** | [01a](01a-audiences-and-perspectives.md), [03](03-interaction-model.md), [04](04-surfaces.md), [06](06-ai-copilot.md), [07](07-alerting.md), [09](09-performance-contract.md), [15](15-estate-navigation.md) |
| **Technical designs** | [T05](../technical/T05-testing-and-performance.md) (test gates), [T16](../technical/T16-alert-evaluator.md), T13 local analytics engine (draft), T15 AI/RCA/MCP (draft), T17 collaboration (draft) |
| **Mockups** | [09 Alert Lens](../mockups/09-alert-lens.svg) · [02 Atlas topology](../mockups/02-atlas-topology.svg) · [05 Service Lens](../mockups/05-service-lens.svg) (Edge Lens) · [13 Investigation](../mockups/13-investigation.svg) · [17 Mobile alert card](../mockups/17-mobile-alert-card.svg) · [18 NOC wall](../mockups/18-noc-wall.svg) |

## 1. Purpose & scope

This is the flagship flow. It pulls together the audiences
([01a](01a-audiences-and-perspectives.md)), the interaction model ([03](03-interaction-model.md)),
alerting ([07](07-alerting.md)) and RCA ([06](06-ai-copilot.md)) into one continuous experience.
Each frame lists what is on screen, what the user does, the transition into the next frame, and the
data and timing behind it. **The prototype and the M-UI4 demo are built from this document.**

Every frame and step is an acceptance scenario `SCN-NNN`. The scenarios are run end to end on the
incident replay corpus ([06](06-ai-copilot.md)) by the storyboard test gate of
[T05](../technical/T05-testing-and-performance.md). Requirements in other docs are the normative
source for each feature; these scenarios prove that they compose.

**Scenario.** At 12:19 someone changes `payments.psp.timeout` from 5 s to 2 s. psp-api's p95 is
2.3 s, so calls start timing out, and checkout fails. Sam, the on-call SRE, is paged at 12:23. The
incident is INC-2041 and its investigation INV-2041. This is the same incident as the "one incident,
five screens" validation scenario of [01a](01a-audiences-and-perspectives.md) (SCN-038).

**Targets:** page → origin identified **< 2 min**; origin → mitigation **< 5 min**; **zero queries
typed** (natural-language questions to the agent are not queries).

## 2. Definitions

| Term | Meaning |
|---|---|
| **t** | Time since Sam opens the page link (F1 onwards) |
| **Characters** | Sam (SRE, on call), Priya (Engineer), Lee (Platform), Ana (IC), a Support agent, the NOC operator |
| **Local engine** | The in-browser analytics engine over summary pyramids, marked ⚡ (T13 (draft)) |
| **Coarse / refined** | First approximate render, then the exact one ([09](09-performance-contract.md)) |

## 3. F0 — Before the page (machine time, no human)

| t | Event | System |
|---|---|---|
| 12:19:02 | Config change event ingested | Change feed records ⚙ on `payments` |
| 12:19:40 | psp-api edge latency deviates | Anomaly sweep sets payments→psp-api to Watch ◐ |
| 12:21:05–12:22:00 | payments → checkout → gateway → Journey "Checkout" degrade | Health states escalate; alerts begin pending |
| 12:22:50 | `HighErrorRate checkout` fires | **RCA stage 1** starts (causal engine, < 5 s) |
| 12:22:55 | Candidates ranked: ⊕ psp-api edge, with the ⚙ timeout change adjacent | **RCA stage 2** agent starts (budget 90 s) |
| 12:23:00 | Incident INC-2041 created; 14 related alerts merged in | NOC queue shows 1 incident, not 14 alerts |
| 12:23:05 | Page delivered with the stage-1 summary | Slack/PagerDuty: *"Checkout 4% failing. Probable origin: payments→psp-api timeouts since 12:21. Change: psp timeout 5s→2s at 12:19."* |

The page itself already answers "how bad / where / what changed". Sam can decide how urgent this is
from the lock screen.

#### SCN-001 — Config change recorded
**MUST** · M-UI4 · SRE, Engineer

The change feed MUST record an ingested config change on its entity.

*Acceptance:* Given the replay corpus at 12:19:02, when the config change event for
`payments.psp.timeout` 5000→2000 is ingested, then the change feed shows ⚙ on `payments` with
timestamp 12:19:02, author and PR #4411.

#### SCN-002 — Anomaly sweep flags the edge
**MUST** · M-UI4 · SRE, NOC

The anomaly sweep MUST flag the deviating edge as Watch before any alert fires.

*Acceptance:* Given psp-api edge latency deviating from 12:19:40, when the next sweep runs, then the
payments→psp-api edge is Watch ◐ on the Atlas, and no alert has fired yet.

#### SCN-003 — Health escalates along the path
**MUST** · M-UI4 · SRE, NOC, Business

Health states MUST escalate along the degrading path, and alerts MUST begin Pending.

*Acceptance:* Given degradation of payments, checkout, gateway and Journey "Checkout" between 12:21:05
and 12:22:00, when health is evaluated, then each entity escalates in that order and their rules are
◔ Pending by 12:22:00.

#### SCN-004 — Stage 1 on fire
**MUST** · M-UI4 · SRE

Stage 1 MUST start when the alert fires and rank candidates within 5 s.

*Acceptance:* Given `HighErrorRate checkout` firing at 12:22:50, when stage 1 runs, then by 12:22:55
the ranked candidates list ⊕ psp-api edge first with the ⚙ timeout change adjacent.

#### SCN-005 — Stage 2 starts with its budget
**MUST** · M-UI4 · SRE

Stage 2 MUST start as soon as stage 1 completes, with a 90 s budget.

*Acceptance:* Given stage 1 completing at 12:22:55, when stage 2 starts, then its budget is 90 s
wall clock and it has concluded by 12:24:25.

#### SCN-006 — One incident, not 14 alerts
**MUST** · M-UI4 · NOC, SRE

Related alerts MUST be merged into one incident before paging.

*Acceptance:* Given the corpus, when grouping runs, then INC-2041 exists at 12:23:00 with 14 related
alerts, and the NOC queue shows 1 incident, not 14 alerts.

#### SCN-007 — The page answers how bad, where, what changed
**MUST** · M-UI4 · SRE, IC

The page MUST be delivered within 15 s of the first firing and carry the stage-1 summary: impact,
probable origin, and change, short enough to read on a lock screen.

*Acceptance:* Given INC-2041, when the page is delivered at 12:23:05 to Slack and PagerDuty, then the
text reads like *"Checkout 4% failing. Probable origin: payments→psp-api timeouts since 12:21. Change:
psp timeout 5s→2s at 12:19."* and fits the lock-screen preview ([mockup](../mockups/17-mobile-alert-card.svg)).

## 4. F1 — Alert Lens (t = 0 s, Sam opens the link)

```
┌ ⚠ INC-2041 · Checkout degraded · SEV2 · FIRING 1m ─────────────────── ● REC  👤 Sam ────────────┐
│ ┌ Causal sentence ──────────────────────────────────────────────────────────────────────────────┐│
│ │ Checkout success fell to 95.9% (≈ 2 900 users/10 min) because payments calls to psp-api time  ││
│ │ out after a timeout change at 12:19; psp-api itself is unchanged.      confidence HIGH 0.86 ⓘ ││
│ └───────────────────────────────────────────────────────────────────────────────────────────────┘│
│ IMPACT ▁▁▁▂▅█▇ rising    WHERE all pods · all regions · POST /pay     CHANGED ⚙ 12:19  ◆ 12:20  │
│ ┌ mini-Atlas (live) ───────────────────┐ ┌ First Light (onset order) ──────────────────────────┐ │
│ │ gateway ⇢ checkout ⇢ payments ⇢ ⊕psp │ │ ⊕ psp-api   ░░░░▓████████  12:19:40 ◀ first          │ │
│ │ (victims dashed, origin glowing)     │ │   payments  ░░░░░▓███████  +85 s                     │ │
│ └──────────────────────────────────────┘ │   checkout  ░░░░░░▓██████  +110 s                    │ │
│ EVIDENCE [1 ⚙ change] [2 edge failed 38%] [3 span compare] [4 NEW pattern] [5 psp unchanged]   │
│ RULED OUT ✖ deploy v2.31 (canary clean before 12:19) ✖ pg-orders                               │
│ ACT [Revert config ↺] [Open runbook] [Ack ✓] [Silence ▾] [Page payments]   ✦ agent: 3/5 checks …│
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

See [mockup](../mockups/09-alert-lens.svg).

#### SCN-008 — Alert Lens paints instantly
**MUST** · M-UI4 · SRE

The Alert Lens MUST load in < 300 ms with no spinners. The card is precomputed; the mini-Atlas and
First Light come from the local pyramid, which the Alert Lens prefetches using the entity and window
carried in the page link.

*Acceptance:* Given the page link for INC-2041 opened on the reference laptop with a warm app cache,
when the Lens loads, then all sections paint within 300 ms, no spinner is shown at any time, and
the mini-Atlas and First Light make no server round trip after the prefetch.

#### SCN-009 — Alert Lens content
**MUST** · M-UI4 · SRE, IC

The Alert Lens MUST show the causal sentence with confidence, IMPACT (trend), WHERE, CHANGED, the
live mini-Atlas (victims dashed, origin glowing), First Light in onset order, EVIDENCE chips, RULED OUT
and ACT controls, plus the ● REC indicator and present users.

*Acceptance:* Given INC-2041 at t = 0, when the Lens renders, then the causal sentence reads
"Checkout success fell to 95.9% (≈ 2 900 users/10 min) … confidence HIGH 0.86", First Light lists
psp-api 12:19:40 first, payments +85 s, checkout +110 s, and ACT contains Revert config, Open runbook,
Ack, Silence and Page payments.

#### SCN-010 — Evidence arrives without reordering
**MUST** · M-UI4 · SRE

While stage 2 finishes, its progress MUST show as a ✦ ticker, and evidence chips MUST slide in as they
are confirmed and never reorder under the cursor.

*Acceptance:* Given the Lens open at "✦ agent: 3/5 checks", when the remaining checks complete, then
chips 4 and 5 slide in after chip 3, the ticker reaches 5/5, and no chip moves while the pointer is
over the evidence row.

#### SCN-011 — Sam acks
**MUST** · M-UI4 · SRE, NOC

`Shift+A` in the Alert Lens MUST ack the incident everywhere.

*Acceptance:* Given Sam on the Lens, when he presses `Shift+A`, then within 1 s the NOC wall's
salience for INC-2041 drops and "ACK Sam" shows on the wall, the List, the Slack message and every
collaborator's view.

#### SCN-012 — Mini-Atlas grows into the Atlas
**MUST** · M-UI4 · SRE

Clicking the mini-Atlas or pressing `Enter` on ⊕ MUST make the mini-Atlas grow into the full Atlas
in 250 ms, keeping spatial continuity, from the local pyramid and entity-graph cache.

*Acceptance:* Given the Lens, when Sam presses `Enter` on ⊕, then the mini-Atlas animates into the
full Atlas in 250 ms with every node continuous from its mini-Atlas position and no network wait.

## 5. F2 — Atlas with causal path (t ≈ 15 s)

```
┌ Atlas · prod · Topology · causal path INC-2041 ──────────────────────── [X anomalous only ✓] ─┐
│                                                                                                │
│        ( gateway ◌ )═══►( checkout ◌ )═══►( payments ◌ )═══╸╸╸►[ psp-api ⊕ ]                    │
│                                              ⚙                red rain on this edge only       │
│        everything else collapsed into team super-nodes, dimmed:  [search ▢] [catalog ▢] [+31]   │
│                                                                                                │
├────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Ribbon  ░░░░░░░░░░▒▓██████  ⚙12:19 ◆12:20 ⚠12:22     ◀ Replay ▶                               │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

See [mockup](../mockups/02-atlas-topology.svg).

#### SCN-013 — Atlas frames the causal path
**MUST** · M-UI4 · SRE, IC

Opened from an incident, the Atlas MUST ease out (250 ms) to frame the causal path, with `X`
(anomalous subgraph only) on by default and everything else collapsed into dimmed team super-nodes.

*Acceptance:* Given F1 → F2, when the Atlas settles, then the viewport contains gateway, checkout,
payments and psp-api, `X` is on, ⚙ marks payments, and other services appear as dimmed super-nodes
("search", "catalog", "+31").

#### SCN-014 — The scrub explains the cause in seconds
**MUST** · M-UI4 · SRE, IC

Holding `Space` and dragging MUST scrub time on the local engine only, at ≤ 16 ms per frame, with a ⚡
badge. Propagation MUST appear in First Light order.

*Acceptance:* Given the Atlas, when Sam holds `Space` and drags back to 12:18, then every node goes
calm; dragging forward, psp-api's edge turns red first and colour spreads leftwards to gateway in
First Light order; no network request is made during the scrub, p95 frame time is ≤ 16 ms, and ⚡ is
shown.

#### SCN-015 — Why tooltip on ⊕
**MUST** · M-UI4 · SRE

Hovering ⊕ MUST show why it is the probable origin.

*Acceptance:* Given the Atlas, when Sam hovers psp-api ⊕, then the tooltip reads like *"earliest
onset; errors originate at the payments→psp-api client span; psp-api latency vs −7d unchanged"*.

#### SCN-016 — Dive into the Edge Lens
**MUST** · M-UI4 · SRE, Engineer

Double-clicking an edge MUST open the Edge Lens (the relationship between two entities) with the
edge expanding into the lane stack; coarse data in < 300 ms and refined in < 1.5 s from the server
(span scatter via R2, patterns, heatmap).

*Acceptance:* Given the Atlas, when Sam double-clicks payments→psp-api, then the Edge Lens shows all
lanes coarse within 300 ms and refined within 1.5 s.

## 6. F3 — Edge Lens + Correlate stack (t ≈ 40 s)

```
┌ payments → psp-api (rpc) · A: 12:10–12:40  B: −7d  [C A/B ✓] ───────────────────────────────────┐
│ calls     ▁▁▁▁▁▁▁▁▁▁▁▁  ≈ unchanged vs B                                                         │
│ failed    ▁▁▁▁▁▂▇████  38% (B 0.2%)                     ← diff band                              │
│ latency   heatmap: psp-api p95 2.3s both A and B   ← "unchanged" (DDx lesson)                    │
│ spans     ··:::⁘⁘⁘⁘⁘ scatter: failed spans pinned at exactly 2.0 s  ◀ striking horizontal line    │
│ logs      pattern "timeout calling psp-api after <*>ms" NEW ×1 832  (all <*> = 2000)             │
│ changes   ⚙ 12:19:02 payments.psp.timeout 5000→2000 (by deploy-bot, PR #4411)                   │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

See [mockup](../mockups/05-service-lens.svg).

#### SCN-017 — Correlate stack with A/B on
**MUST** · M-UI4 · SRE, Engineer

The Correlate stack MUST put every signal on one time axis, with A/B diff mode on by default when
opened from an incident (A = incident window, B = −7d).

*Acceptance:* Given the Edge Lens from INC-2041, when it renders, then A is 12:10–12:40, B is −7d,
`C A/B` is on, and the rows calls (≈ unchanged), failed (38% vs B 0.2% with diff band), latency
heatmap (p95 2.3 s in A and B), spans, logs (NEW pattern ×1 832) and changes (⚙ 12:19:02, PR #4411)
are shown.

#### SCN-018 — The flat line at 2.0 s
**MUST** · M-UI4 · SRE, NOC, Support

The span scatter MUST render failed spans at their exact durations, so a client timeout appears as a
flat line, and the heatmap row MUST show the server latency unchanged.

*Acceptance:* Given the Edge Lens, when the spans row renders, then failed spans lie on a horizontal
line at 2.0 s (± 1 px at default zoom), and the latency row shows psp-api p95 2.3 s in both A and B.

#### SCN-019 — Draw-to-ask confirms H1
**MUST** · M-UI4 · SRE

Drawing around a feature with `D` and asking MUST get an anchored answer within 10 s, and the answer
MUST update the ledger.

*Acceptance:* Given the scatter, when Sam presses `D`, circles the 2.0 s line and types "why exactly
2s?", then within 10 s the agent's reply anchors to the ink, cites the ⚙ change evidence and links PR
#4411, and H1 is marked validated in the ledger.

#### SCN-020 — Compare shows the provider and the unchanged keys
**MUST** · M-UI4 · SRE, Engineer

`B` on a circled region MUST run Universal Compare, first from the local sample (< 16 ms, ⚡) and then
exact from the server (< 1 s, ✓), and MUST list unchanged keys.

*Acceptance:* Given the circled region, when Sam presses `B`, then compare panes slide up showing
`payment.provider=psp-a` at 100% (0% other providers) within 16 ms marked ⚡, replaced by the exact
result within 1 s marked ✓, with pod, region and version listed as unchanged.

## 7. F4 — Act (t ≈ 1 min 30 s)

#### SCN-021 — Revert config through the action framework
**MUST** · M-UI4 · SRE

The revert MUST go through the confirmation sheet and run under Sam's identity with an audit entry
([07](07-alerting.md)).

*Acceptance:* Given the ⚙ evidence, when Sam chooses Revert config ↺, then the sheet shows the diff
(5000 ← 2000), the target, the approval policy and the runbook; after Sam confirms, the webhook to the
config system is called under Sam's identity and the audit log records it.

#### SCN-022 — Mitigation on the timeline and every chart
**MUST** · M-UI4 · SRE, IC

The action MUST be recorded on the incident timeline and drawn as a ⚙ glyph on every chart.

*Acceptance:* Given the revert, when it completes, then the timeline reads *"12:24:40 Sam reverted
payments.psp.timeout → 5000"* and every open chart of the affected entities shows ⚙ at 12:24:40.

#### SCN-023 — Watching recovery
**MUST** · M-UI4 · SRE, NOC

Recovery MUST be visible without any action: the Alert Lens trend flips ↘, First Light lanes show
recovery in reverse order (origin first), and the NOC wall's incident row turns "↘ improving".

*Acceptance:* Given the revert at 12:24:40, when errors drop, then the Lens IMPACT trend shows ↘,
First Light shows psp-api's recovery onset before payments, checkout and gateway, and the wall row for
INC-2041 reads "↘ improving".

#### SCN-024 — Journey status line updates
**MUST** · M-UI5 · Business

The business Journeys row MUST update its status line when a fix is applied.

*Acceptance:* Given the revert, when the Journeys view is shown, then the Checkout row's status line
reads *"Fix applied 12:24, recovering"*.

#### SCN-025 — Flow time targets
**MUST** · M-UI4 · SRE, IC

The flow MUST meet the targets: page → origin identified < 2 min (storyboard: ~70 s), origin →
mitigation < 5 min (storyboard: mitigation ~100 s after the page), and zero queries typed.

*Acceptance:* Given a scripted run of F1–F4 on the corpus, and a moderated usability run with SREs
new to the scenario, when timings are measured from page open, then origin is identified < 2 min and
mitigation applied < 5 min after that, and the input log contains no typed PromQL, LogQL or TraceQL.

## 8. F5 — Collaborate (in parallel, t ≈ 1–5 min)

#### SCN-026 — Priya rules out the deploy
**MUST** · M-UI5 · Engineer

An engineer joining from the Slack link MUST appear as a present participant and be able to
invalidate a hypothesis with Release Compare evidence.

*Acceptance:* Given Priya opening the Slack link, when she joins, then her presence avatar appears for
Sam; when she opens Release Compare for v2.31, it shows no regression before 12:19, and she marks H2
"deploy v2.31" **invalidated** with that comparison attached as evidence.

#### SCN-027 — Ana follows and briefs execs
**MUST** · M-UI4 · IC, Business

The incident commander MUST be able to follow another participant's camera and get a stakeholder
update drafted from the causal sentence in Business-Perspective language, which she edits and posts.

*Acceptance:* Given Ana on the bridge call, when she chooses "follow Sam's camera", then her view
tracks Sam's; when she asks ✦ for a stakeholder update, a Business-Perspective draft opens, and after
her edit it is posted to #exec-incidents only when she posts it.

#### SCN-028 — Support sees the banner
**MUST** · M-UI5 · Support

Customer lookup MUST show an incident banner for affected customers, with a status line ready to
paste.

*Acceptance:* Given a Support agent looking up ACME, when ACME is affected by INC-2041, then a banner
links INC-2041 with a copyable status line, which the agent pastes into ACME's ticket.

#### SCN-029 — Lee doesn't have to join
**MUST** · M-UI4 · Platform

Owners of ruled-out areas MUST be notified that they are ruled out.

*Acceptance:* Given infra ruled out in INV-2041, when the verdict is recorded, then Lee receives a
"ruled out: infra" notification with a link to the evidence, and is not paged.

## 9. F6 — Resolve & learn (t ≈ 20 min, then next day)

#### SCN-030 — Resolution and root cause
**MUST** · M-UI4 · SRE, IC

When the alert resolves, the incident MUST move to *monitoring*, then *resolved*; the root-cause field
MUST be pre-filled from the validated hypothesis for confirmation; and 👍 on the RCA card MUST become
an evaluation label.

*Acceptance:* Given recovery, when the alert resolves, then INC-2041 shows *monitoring* and later
*resolved*; the root-cause field shows H1 pre-filled; after Sam confirms it and presses 👍, a label for
the RCA exists in the feedback store.

#### SCN-031 — Post-mortem draft from the ledger
**MUST** · M-UI4 · IC, SRE

A post-mortem draft MUST be generated from the evidence ledger, timeline and causal sentence, linking
to flight-recorder moments rather than screenshots, with metrics filled in automatically.

*Acceptance:* Given INC-2041 resolved, when the post-mortem draft is generated, then it states time to
page 4 min after the change, time to first correct look 15 s (the F2 scrub), and time to mitigation
100 s, and every figure links to a flight-recorder moment.

#### SCN-032 — Learning loop
**MUST** · M-UI4 · SRE, Platform

After resolution, the system MUST:
- suggest a guardrail alert (e.g. "payments client timeout < psp-api p99");
- note in alert hygiene that the 13 merged sub-alerts added no value, and propose dropping them from
  paging;
- embed the incident for similar-incident retrieval.

*Acceptance:* Given INC-2041 resolved, when the next day's view of the incident is opened, then the
guardrail rule draft (with backtest) is offered, the hygiene note lists the 13 sub-alerts with a
"stop paging" fix, and a new incident with the same signature retrieves INC-2041 as similar.

## 10. Transition & timing summary

| From → To | Gesture | Animation | Data source | Budget |
|---|---|---|---|---|
| Page → F1 Alert Lens | open link | none (instant paint) | precomputed card + local pyramid | < 300 ms |
| F1 → F2 Atlas | `Enter` on ⊕ / click mini-Atlas | mini-Atlas grows into full scene | local pyramid + entity graph cache | 250 ms |
| F2 scrub | hold `Space` + drag | per-frame state | local engine only | 16 ms/frame |
| F2 → F3 Edge Lens | double-click edge | edge expands into lane stack | server (scatter R2, patterns, heatmap), coarse first | coarse < 300 ms, refined < 1.5 s |
| F3 draw-to-ask | `D` + draw | ink stays, agent's reply anchors to it | agent tools | answer < 10 s |
| F3 Compare | `B` | compare panes slide up | local sample ⚡ then server ✓ | < 16 ms local, < 1 s exact |
| F4 action | confirm sheet | — | webhook | — |
| Back out anywhere | `Esc` | reverse of entry transition | cached scenes | 250 ms |

The rows are verified by SCN-008, SCN-012, SCN-014, SCN-016, SCN-019, SCN-020, SCN-021 and SCN-033.

#### SCN-033 — Back out anywhere
**MUST** · M-UI4 · SRE

`Esc` MUST reverse the entry transition from any frame in 250 ms from cached scenes.

*Acceptance:* Given F3, when Sam presses `Esc` twice, then the Edge Lens collapses back to the edge in
the Atlas and the Atlas shrinks back into the Alert Lens mini-Atlas, each in 250 ms with no network
wait.

## 11. What the prototype must prove (M-UI0 → M-UI4)

#### SCN-034 — The scrub is instant on an iGPU
**MUST** · M-UI3 · SRE, NOC

The F2 scrub MUST feel instant on an integrated-GPU laptop with 2 000 entities. This is the
local-engine claim.

*Acceptance:* Given the reference iGPU laptop of [09](09-performance-contract.md) and an Atlas of
2 000 entities, when the scrub of SCN-014 is performed for 10 s, then p95 frame time is ≤ 16 ms and no
frame exceeds 33 ms.

#### SCN-035 — Users stay oriented
**MUST** · M-UI4 · SRE, Engineer

The F1 → F2 → F3 transitions MUST keep users oriented.

*Acceptance:* Given a usability test with at least 5 participants, when each completes F1–F3 and is
asked to point to where they are in the estate, then at least 80% point correctly.

#### SCN-036 — The flat line is readable by non-experts
**MUST** · M-UI4 · NOC, Support

The F3 "flat line at 2.0 s" moment MUST be readable by non-experts.

*Acceptance:* Given a five-second test with NOC and Support staff, when shown the F3 Edge Lens for
five seconds, then at least 80% say that calls are being cut off at a fixed time (a timeout).

#### SCN-037 — The causal sentence and First Light are trusted
**MUST** · M-UI4 · SRE, NOC, IC

Participants MUST act on the causal sentence and First Light without opening raw data, and be right to.

*Acceptance:* Given a moderated test across corpus scenarios (including at least one where the
displayed confidence is not HIGH), when participants decide on a mitigation, then the share who act
without opening raw data and the share of those decisions that are correct are both recorded; the
M-UI4 gate is that at least 80% of acting-without-raw-data decisions are correct.

## 12. End to end: one incident, five screens

#### SCN-038 — One incident, five screens
**MUST** · M-UI5 · NOC, SRE, Engineer, Platform, Business, Support

The "one incident, five screens" table in [01a](01a-audiences-and-perspectives.md) is the
end-to-end acceptance test for the milestones. At the same moment of INC-2041, every person in that
table MUST see what the table says they see, without doing anything, and reach their "next click"
without writing a query or opening a second tool.

*Acceptance:* Given INC-2041 replayed to the moment of the table, when each row's person (exec on
phone, Support, NOC, Sam, Priya, Lee) opens Dash with their Perspective, then the screen shows that
row's "what they see" content with no interaction, and the row's "next click" is completed with no
typed query and no other tool; any row that needs a query or a second tool fails the scenario.
Rows that depend on M-UI5 features (exec Business push, Support customer lookup, Priya's Release
Compare) are checked from M-UI5; the NOC, Sam and Lee rows are checked from M-UI4.

## 13. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| [SCN-001](#scn-001--config-change-recorded) | Config change recorded | MUST | M-UI4 |
| [SCN-002](#scn-002--anomaly-sweep-flags-the-edge) | Anomaly sweep flags the edge | MUST | M-UI4 |
| [SCN-003](#scn-003--health-escalates-along-the-path) | Health escalates along the path | MUST | M-UI4 |
| [SCN-004](#scn-004--stage-1-on-fire) | Stage 1 on fire | MUST | M-UI4 |
| [SCN-005](#scn-005--stage-2-starts-with-its-budget) | Stage 2 starts with its budget | MUST | M-UI4 |
| [SCN-006](#scn-006--one-incident-not-14-alerts) | One incident, not 14 alerts | MUST | M-UI4 |
| [SCN-007](#scn-007--the-page-answers-how-bad-where-what-changed) | The page answers how bad, where, what changed | MUST | M-UI4 |
| [SCN-008](#scn-008--alert-lens-paints-instantly) | Alert Lens paints instantly | MUST | M-UI4 |
| [SCN-009](#scn-009--alert-lens-content) | Alert Lens content | MUST | M-UI4 |
| [SCN-010](#scn-010--evidence-arrives-without-reordering) | Evidence arrives without reordering | MUST | M-UI4 |
| [SCN-011](#scn-011--sam-acks) | Sam acks | MUST | M-UI4 |
| [SCN-012](#scn-012--mini-atlas-grows-into-the-atlas) | Mini-Atlas grows into the Atlas | MUST | M-UI4 |
| [SCN-013](#scn-013--atlas-frames-the-causal-path) | Atlas frames the causal path | MUST | M-UI4 |
| [SCN-014](#scn-014--the-scrub-explains-the-cause-in-seconds) | The scrub explains the cause in seconds | MUST | M-UI4 |
| [SCN-015](#scn-015--why-tooltip-on-) | Why tooltip on ⊕ | MUST | M-UI4 |
| [SCN-016](#scn-016--dive-into-the-edge-lens) | Dive into the Edge Lens | MUST | M-UI4 |
| [SCN-017](#scn-017--correlate-stack-with-ab-on) | Correlate stack with A/B on | MUST | M-UI4 |
| [SCN-018](#scn-018--the-flat-line-at-20-s) | The flat line at 2.0 s | MUST | M-UI4 |
| [SCN-019](#scn-019--draw-to-ask-confirms-h1) | Draw-to-ask confirms H1 | MUST | M-UI4 |
| [SCN-020](#scn-020--compare-shows-the-provider-and-the-unchanged-keys) | Compare shows the provider and the unchanged keys | MUST | M-UI4 |
| [SCN-021](#scn-021--revert-config-through-the-action-framework) | Revert config through the action framework | MUST | M-UI4 |
| [SCN-022](#scn-022--mitigation-on-the-timeline-and-every-chart) | Mitigation on the timeline and every chart | MUST | M-UI4 |
| [SCN-023](#scn-023--watching-recovery) | Watching recovery | MUST | M-UI4 |
| [SCN-024](#scn-024--journey-status-line-updates) | Journey status line updates | MUST | M-UI5 |
| [SCN-025](#scn-025--flow-time-targets) | Flow time targets | MUST | M-UI4 |
| [SCN-026](#scn-026--priya-rules-out-the-deploy) | Priya rules out the deploy | MUST | M-UI5 |
| [SCN-027](#scn-027--ana-follows-and-briefs-execs) | Ana follows and briefs execs | MUST | M-UI4 |
| [SCN-028](#scn-028--support-sees-the-banner) | Support sees the banner | MUST | M-UI5 |
| [SCN-029](#scn-029--lee-doesnt-have-to-join) | Lee doesn't have to join | MUST | M-UI4 |
| [SCN-030](#scn-030--resolution-and-root-cause) | Resolution and root cause | MUST | M-UI4 |
| [SCN-031](#scn-031--post-mortem-draft-from-the-ledger) | Post-mortem draft from the ledger | MUST | M-UI4 |
| [SCN-032](#scn-032--learning-loop) | Learning loop | MUST | M-UI4 |
| [SCN-033](#scn-033--back-out-anywhere) | Back out anywhere | MUST | M-UI4 |
| [SCN-034](#scn-034--the-scrub-is-instant-on-an-igpu) | The scrub is instant on an iGPU | MUST | M-UI3 |
| [SCN-035](#scn-035--users-stay-oriented) | Users stay oriented | MUST | M-UI4 |
| [SCN-036](#scn-036--the-flat-line-is-readable-by-non-experts) | The flat line is readable by non-experts | MUST | M-UI4 |
| [SCN-037](#scn-037--the-causal-sentence-and-first-light-are-trusted) | The causal sentence and First Light are trusted | MUST | M-UI4 |
| [SCN-038](#scn-038--one-incident-five-screens) | One incident, five screens | MUST | M-UI5 |

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Frames converted to acceptance scenarios |

## Resolved during formalisation

1. **Milestones.** The draft says the M-UI4 demo is built from this doc, but Release Compare, Journeys
   and customer lookup ship in M-UI5 (roadmap). SCN-024, SCN-026, SCN-028 and SCN-038 are M-UI5;
   SCN-034 (local-engine scrub) is M-UI3 with the Atlas.
2. **"Zero queries typed"** clarified: natural-language questions to the agent (SCN-019, SCN-027) do
   not count as queries.
3. **Page time** was implicit (fire 12:22:50, page 12:23:05); SCN-007 makes it ≤ 15 s after first
   firing.
4. **Stage 2 end.** SCN-005 makes the 90 s budget testable as "concluded by 12:24:25".
5. **Usability thresholds.** The draft's prototype proofs had no pass marks; ≥ 5 participants and
   ≥ 80% are set (SCN-035–037). Needs product-owner confirmation.
6. **Esc back-out** had no frame; added as SCN-033 from the transition table.
7. **Inconsistency with 01a §6.** 01a's table (at 12:30) says "~9% of purchases failing" and has Priya
   mark H1 confirmed after finding a new `PaymentTimeoutException`; this storyboard has 4% failing
   (95.9% success) and Priya invalidating H2. SCN-038 tests the table's structure (no query, no second
   tool), not its numbers. **Aligned (2026-11-18):** the figures describe a worsening incident, not a
   contradiction. 4% failing at 12:23 (first page) rises to ~9% by 12:30 (the 01a §6 snapshot). Priya
   invalidates H2 (code regression) in both docs. H1 is confirmed by Sam via draw-to-ask (SCN-019).
8. **"Five screens"** has six rows (exec, Support, NOC, Sam, Priya, Lee); SCN-038 checks all six.
