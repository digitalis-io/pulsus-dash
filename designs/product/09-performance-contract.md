# 09 — Performance contract

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc3 · 2026-11-19 |
| **Requirement area** | `PRF` |
| **Source draft** | plans/09-performance-contract.md (not tracked); mobile targets from T20 (draft) §6 |
| **Depends on** | [01](01-vision-and-principles.md), [03](03-interaction-model.md), [08](08-visual-language.md), [T04](../technical/T04-wire-format-and-data-plane.md), [T05](../technical/T05-testing-and-performance.md), [T07](../technical/T07-scene-query-planner.md), [pulsusdb-requirements](../technical/pulsusdb-requirements.md) |
| **Mockups** | [06-metrics-workbench](../mockups/06-metrics-workbench.svg) (data-source badges), [22-topology-3d](../mockups/22-topology-3d.svg) (Atlas volume), [17-mobile-alert-card](../mockups/17-mobile-alert-card.svg) (mobile), [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg) (3D City/Infra volume), [23-semantic-zoom-flight](../mockups/23-semantic-zoom-flight.svg) (flight), [25-fleet-line-stack-3d](../mockups/25-fleet-line-stack-3d.svg) (fleet line stack) |

## 1. Purpose & scope

Speed is the product (PRN-003 in [01](01-vision-and-principles.md)). This document is the
acceptance contract that engineering must meet: frame and input budgets, load and data latency,
data volumes per viewport and scene, the progressive data strategy that users can see, mobile
budgets, and how all of it is enforced in CI. Every target and hard limit below is a requirement
whose number appears in its acceptance criterion. How the numbers are measured (harness, traces,
seeded data) is specified in [T05](../technical/T05-testing-and-performance.md).

## 2. Definitions

### 2.1 Reference hardware

All targets are measured on the reference hardware below unless a requirement names another
device. Changing this list re-baselines every gate (assumption A2 in the
[designs README](../README.md)).

| Ref | Device | Browser / runtime | Used for |
|---|---|---|---|
| **(a)** | 2022 MacBook Air M2 | Chrome stable | Desktop default; memory budget |
| **(b)** | Windows laptop with Intel Iris Xe integrated GPU | Chrome stable | Desktop floor (worst supported desktop GPU) |
| **(c)** | 4K wall PC with mid-range discrete GPU | Chrome stable | NOC wall |
| **(d)** | Mid-range Android phone (~2022, 6 GB RAM) | Chrome stable | Mobile PWA (read / ack / AI only) |
| **(e)** | iPhone 13-class device | Current iOS, Safari, Home-Screen app | Mobile PWA (read / ack / AI only) |

### 2.2 Terms

| Term | Meaning |
|---|---|
| **Interaction** | Pan, zoom, orbit, hover, scrub, brush or any other direct manipulation of a scene |
| **Input → photon** | Time from the input event to the first displayed frame that reflects it |
| **Frame** | One display refresh at the display's native rate (16.7 ms at 60 Hz) |
| **Long task** | A main-thread task running longer than 16 ms |
| **Coarse data** | The first, low-resolution answer to a viewport's query (§5) |
| **Fully refined** | Every visible viewport shows full-resolution data for its visible range |
| **p99** | 99th percentile over the benchmark's frames or samples |

## 3. Frame & input

| Metric | Target | Hard limit | Requirement |
|---|---|---|---|
| Frame rate during pan/zoom/orbit | 60 fps (120 fps on ProMotion/high-Hz displays) | never < 45 fps p99 on (b) | PRF-001, PRF-002 |
| Input → photon (pan, hover crosshair) | ≤ 1 frame | ≤ 2 frames | PRF-003, PRF-004 |
| Main-thread long tasks during interaction | 0 tasks > 16 ms | — | PRF-005 |
| Camera transition | ≤ 250 ms | — | PRF-007 |

#### PRF-001 — Frame rate during interaction
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

Scenes MUST render at 60 fps during pan, zoom and orbit on reference hardware (a)–(c), and at 120 fps
on displays with a refresh rate of 120 Hz or more.

*Acceptance:* In the headless GPU benchmark of each visualisation at the volumes of §5, the median
frame rate during scripted pan/zoom/orbit is ≥ 60 fps on (a), (b) and (c), and ≥ 120 fps on (a)
driving a 120 Hz display.

#### PRF-002 — Frame-rate floor
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

The frame rate during interaction MUST NOT drop below 45 fps at p99 on reference hardware (b).

*Acceptance:* In the same benchmark on (b), the p99 frame time is ≤ 22.2 ms (≥ 45 fps).

#### PRF-003 — Input to photon
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

The median input-to-photon latency for pan and hover crosshair MUST be ≤ 1 frame.

*Acceptance:* With trace instrumentation on (a) and (b), the median input-to-photon latency for pan
and hover-crosshair events is ≤ 1 frame (≤ 16.7 ms at 60 Hz).

#### PRF-004 — Input to photon hard limit
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

Input to photon for pan and hover crosshair MUST NOT exceed 2 frames at p99.

*Acceptance:* In the same traces, the p99 input-to-photon latency is ≤ 2 frames (≤ 33.3 ms at 60 Hz).

#### PRF-005 — No main-thread long tasks during interaction
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

The browser main thread MUST NOT run any task longer than 16 ms while an interaction is in progress.

*Acceptance:* A performance trace of every scripted interaction benchmark on (a) and (b) contains
0 main-thread tasks > 16 ms between the first and last input event.

*Verification note:* until the reference lab exists, CI's browser trace is the merge gate (no
main-thread task > 16 ms thread or > 50 ms wall time in interaction); then `bench:long-tasks` on
(a), (b) blocks merges. M-UI0 is not complete until it passes.

#### PRF-006 — No interaction waits on the network
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

Pan, zoom, orbit, hover, scrub and brush MUST operate on client-held data. New data MUST stream in
and refine coarse → fine without blocking interaction.

*Acceptance:* With the network throttled to 0 bytes/s after first paint, scripted pan/zoom/scrub
still meets PRF-001 and PRF-003 (0 frames blocked on a request), and when the network is restored
the visible data refines without any interaction being interrupted.

#### PRF-007 — Camera transition duration
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every programmatic camera move (focus, back, dive, AI "show me") MUST complete in ≤ 250 ms, and MUST
be instant when `prefers-reduced-motion` is set ([03](03-interaction-model.md), [08](08-visual-language.md)).

*Acceptance:* Measured from trigger to final camera pose, 100% of scripted transitions complete in
≤ 250 ms on (a) and (b); with `prefers-reduced-motion: reduce`, the next frame shows the final pose.

## 4. Load & data latency

| Metric | Target | Requirement |
|---|---|---|
| Cold app load to interactive shell (WASM + shell, cached CDN) | < 1.0 s | PRF-008 |
| Core WASM size | < 3 MB brotli; workbenches lazy-loaded | PRF-009 |
| Warm navigation to a Lens with first coarse data | < 300 ms | PRF-010 |
| Lens fully refined (typical service, 1 h) | < 1.5 s | PRF-011 |
| Atlas of 2 000 entities, first paint | < 800 ms | PRF-012 |
| Alert notification → RCA card ready, Stage 1 | < 10 s | PRF-013 |
| RCA Stage 2 (agent) | < 90 s | PRF-014 |
| Live tail latency (ingest → screen) | < 2 s | PRF-015 |

#### PRF-008 — Cold load to interactive shell
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

A cold app load, with WASM and shell assets served from a warm CDN cache, MUST reach an interactive
shell (top bar, Time Ribbon and command palette responsive) in < 1.0 s.

*Acceptance:* On (a) and (b) over the CI network profile, the time from navigation start to the
shell accepting `⌘K`/`Ctrl+K` is < 1.0 s at p75 over 20 runs.

#### PRF-009 — Core bundle size and lazy loading
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

The core WASM needed for the shell MUST be < 3 MB brotli-compressed. Signal workbenches MUST be
lazy-loaded on first use and MUST NOT be part of the core download.

*Acceptance:* The CI bundle gate reports the brotli size of the core WASM < 3 MB, and a network
trace of a cold load that opens no workbench fetches no workbench module.

#### PRF-010 — Warm navigation to first coarse Lens data
**MUST** · M-UI2 · SRE, Platform, Engineer

Warm navigation (app already loaded) to a Lens MUST paint first coarse data in < 300 ms.

*Acceptance:* In the synthetic Lens load against the seeded PulsusDB, the time from the dive input
to the first frame with data in every visible Lens viewport is < 300 ms at p75.

#### PRF-011 — Lens fully refined
**MUST** · M-UI2 · SRE, Platform, Engineer

A Lens for a typical service over a 1 h window MUST be fully refined in < 1.5 s.

*Acceptance:* In the same synthetic load ("typical service" as defined by the seeded dataset in
[T05](../technical/T05-testing-and-performance.md)), every visible viewport shows full-resolution
data < 1.5 s after the dive input, at p75.

#### PRF-012 — Atlas first paint
**MUST** · M-UI3 · NOC, SRE, Platform

An Atlas of 2 000 entities MUST reach first paint in < 800 ms.

*Acceptance:* Opening the Atlas on a seeded estate of 2 000 entities on (a) and (b) shows every
entity (at its current LOD) < 800 ms after navigation, at p75.

#### PRF-013 — RCA Stage 1 ready
**MUST** · M-UI4 · SRE, NOC, IC

The RCA card (Stage 1, the causal engine) MUST be ready < 10 s after the alert notification is
sent, so it is available when the responder opens it ([06](06-ai-copilot.md)).

*Acceptance:* On the replay corpus, for ≥ 95% of alerts the Stage 1 card is persisted and servable
< 10 s after the notification send timestamp.

#### PRF-014 — RCA Stage 2 ready
**MUST** · M-UI4 · SRE, NOC, IC

The agent RCA (Stage 2) MUST complete or report its partial result < 90 s after the notification.

*Acceptance:* On the replay corpus, for 100% of alerts Stage 2 has produced a final or explicitly
partial result < 90 s after the notification send timestamp.

#### PRF-015 — Live tail latency
**MUST** · M-UI2 · SRE, Engineer, NOC

In LIVE mode, data MUST appear on screen < 2 s after ingest into PulsusDB.

*Acceptance:* With a synthetic emitter writing timestamped log lines and samples, the p95 delay
between the PulsusDB ingest acknowledgement and the line or sample being drawn is < 2 s.

## 5. Volume targets (single viewport or scene)

| Content | Target | Requirement |
|---|---|---|
| Line chart raw points held client-side | 10⁸ | PRF-016 |
| Scatter points | 10⁷ | PRF-017 |
| Series on one scene | 10⁴ (band + outlier LOD) | PRF-018 |
| Atlas entities / edges | 10⁴ / 5×10⁴ | PRF-019 |
| Log lines scrollable | 10⁶ in memory window; unbounded with paging | PRF-020 |
| Flame graph frames | 10⁵ | PRF-021 |
| Viewports in a board | 200 (single canvas; off-screen viewports neither render nor query) | PRF-022 |
| Tab memory, heaviest scene, on (a) | < 1.5 GB | PRF-023 |
| 3D City / Infra scene | 10⁴ buildings + 5×10⁴ pod blocks | PRF-043 |
| Same scene on the WebGL2 tier | Same geometry, reduced effects | PRF-044 |
| 3D semantic-zoom flight and floors | Each leg ≤ 250 ms, no dropped floor | PRF-045 |
| Fleet line stack | 2 000 lanes × full window | PRF-046 |

Every volume requirement is met while also meeting PRF-001 to PRF-005.

#### PRF-016 — 10⁸ line-chart points
**MUST** · M-UI0 · Platform, Engineer, SRE

A line chart MUST hold and interactively pan/zoom 10⁸ raw points client-side. Points are held as
columnar Float64/Int64 buffers in memory and uploaded to the GPU as Float32 relative to a per-chunk
origin (the GPU has no f64), with GPU-resident decimation ([T04](../technical/T04-wire-format-and-data-plane.md)).

*Acceptance:* The line-chart benchmark loads 10⁸ points and passes PRF-001 to PRF-005 on (a) and (b),
with no visible precision error at the deepest zoom (adjacent 1 ms samples at epoch-scale timestamps
render as distinct x positions).

#### PRF-017 — 10⁷ scatter points
**MUST** · M-UI0 · Engineer, SRE

A scatter plot MUST render and interact with 10⁷ points.

*Acceptance:* The scatter benchmark at 10⁷ points passes PRF-001 to PRF-005 on (a) and (b).

#### PRF-018 — 10⁴ series per scene
**MUST** · M-UI1 · Platform, Engineer, SRE

A scene MUST render 10⁴ series, using band + outlier level of detail when individual lines would
not be distinguishable.

*Acceptance:* A scene with 10⁴ series passes PRF-001 to PRF-005 on (a) and (b), and outlier series
(outside the band) are drawn individually.

#### PRF-019 — Atlas 10⁴ entities and 5×10⁴ edges
**MUST** · M-UI3 · NOC, SRE, Platform

The Atlas MUST render 10⁴ entities and 5×10⁴ edges. This relies on assumption A1 (the PulsusDB
service-graph cap raised to ≥ 50 000 edges); if A1 does not hold, the client-side aggregation
fallback of [pulsusdb-requirements](../technical/pulsusdb-requirements.md) R5 applies and the
edge-count coverage meter shows the truncation.

*Acceptance:* An Atlas of 10⁴ entities and 5×10⁴ edges passes PRF-001 to PRF-005 on (a), (b) and (c),
in both the 3D layered Topology (its default at this size) and its 2D equivalent;
with the service-graph source capped at 1 000 edges, the coverage meter shows "1 000 of N edges".

#### PRF-020 — 10⁶ log lines scrollable
**MUST** · M-UI1 · SRE, Engineer, Support

The log stream MUST hold a window of 10⁶ lines in memory for smooth scrolling and MUST page beyond it
without an upper bound.

*Acceptance:* Scrolling through 10⁶ in-memory lines passes PRF-001 and PRF-003 on (a) and (b), and
scrolling past the window end loads the next page without a scroll stall > 1 frame.

#### PRF-021 — 10⁵ flame-graph frames
**MUST** · M-UI2 · Engineer, Platform

A flame graph MUST render and interact with 10⁵ frames.

*Acceptance:* The flame-graph benchmark at 10⁵ frames passes PRF-001 to PRF-005 on (a) and (b).

#### PRF-022 — 200 viewports per board
**MUST** · M-UI5 · NOC, Platform, Engineer, Business

A board MUST support 200 viewports on a single canvas. Off-screen viewports MUST neither render nor
query.

*Acceptance:* Scrolling a 200-viewport board passes PRF-001 on (a) and (b), and a network and GPU
trace shows 0 queries and 0 draw calls for viewports that have not entered the visible area.

#### PRF-023 — Memory budget
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer

The heaviest scene in the benchmark suite MUST stay under 1.5 GB of tab memory on (a).

*Acceptance:* The peak tab memory reported during the heaviest benchmark scene on (a) is < 1.5 GB.

#### PRF-024 — Graceful degradation under memory pressure
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

Under memory pressure the client MUST degrade (drop raw data and fall back to rollups) and MUST NOT
crash.

*Acceptance:* With memory pressure induced past the 1.5 GB budget, the tab does not crash, the
affected viewports switch to rollup data within 1 s, and their source badge reflects the change.

### 5.1 3D scenes

The estate is 3D-first ([15](15-estate-navigation.md) EST-055). These targets are measured on the
Large fixture of [15](15-estate-navigation.md) Table 15-7 with the depth cues of
[08](08-visual-language.md) §10 enabled, and are gated in CI by PRF-032.

#### PRF-043 — 3D City and Infra scene volume
**MUST** · M-UI3 · NOC, SRE, Platform

The 3D City and Infra scenes MUST render 10 000 buildings and 50 000 pod blocks, with labels
(VIZ-076), arcs with traffic particles, lighting, fog, ground grid, contact shadows and deviation
glow, at 60 fps median on reference hardware (a) and ≥ 45 fps at p99 on (b) during scripted orbit,
dolly and pan, on WebGPU.

*Acceptance:* The CI benchmark "city-10k-50k" orbits 360°, dollies L1 → L3 and pans for 30 s on (a)
and (b); median frame rate is ≥ 60 fps on (a), p99 frame time is ≤ 22.2 ms on (b), and PRF-005 holds.
A regression on either number fails the build.

#### PRF-044 — WebGL2 tier: same geometry, reduced effects
**MUST** · M-UI3 · NOC, SRE, Platform

Where WebGPU is unavailable, the 3D scenes MUST render on WebGL2 with the same geometry, layout,
encodings and labels, and MAY reduce effects only: deviation glow at half resolution, contact
shadows as pre-blurred quads, fog per vertex, and traffic particles capped at 25 % of the WebGPU
count. Glow intensity MUST stay proportional to anomaly score (VL-004). The WebGL2 tier MUST meet the
PRF-043 targets on (a) and (b); where a device cannot, the estate MUST open in its 2D equivalent
([15](15-estate-navigation.md) EST-063).

*Acceptance:* The "city-10k-50k" benchmark run with WebGPU disabled meets PRF-043 on (a) and (b); a
frame-by-frame comparison with the WebGPU run shows identical building positions, sizes and colours
(ΔE ≤ 2 on faces); and a failing run fails the build.

#### PRF-045 — 3D flight and floors hold the frame floor
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

During a semantic-zoom flight ([15](15-estate-navigation.md) EST-060) and a hold-`V` transition to
the 3D floors (EST-012), each camera leg MUST complete in ≤ 250 ms (PRF-007), frame time MUST stay
≤ 22.2 ms at p99 on (b), and the arriving level's data MUST already be present (PRF-029).

*Acceptance:* The CI benchmark "flight-l0-l5" double-clicks region → cluster → node → pod on the Large
fixture and holds `V` on a service; on (a) and (b) every leg completes in ≤ 250 ms, p99 frame time is
≤ 22.2 ms on (b), and no frame shows a level without its data. A failing run fails the build.

#### PRF-046 — Fleet line stack volume
**MUST** · M-UI3 · SRE, Platform, Engineer

The fleet line stack ([05](05-visualisation-catalogue.md) VIZ-085) MUST render 2 000 lanes over the
full time window at 60 fps median on reference hardware (a) and ≥ 45 fps at p99 on (b), using band +
outlier LOD for distant lanes.

*Acceptance:* The CI benchmark "fleet-stack-2000" orbits and dollies along depth for 30 s over 2 000
series of 6 h at 15 s resolution; median frame rate is ≥ 60 fps on (a) and p99 frame time ≤ 22.2 ms
on (b). A failing run fails the build.

## 6. Progressive data strategy

The strategy is visible to users: every viewport shows where its data came from with a badge
(⚡ local · ☁ server · ✓ exact), and stale or partial data is marked, never hidden.

| Step | Behaviour | Requirement |
|---|---|---|
| 0. Local first | Summary pyramids of entity health signals in the browser; WASM columnar engine answers in < 16 ms | PRF-025 |
| 1. Show cached | Last-viewed data from IndexedDB, hatched as stale | PRF-026 |
| 2. Coarse first | Query at ≈ (pixel width / 4) step, then paint | PRF-027 |
| 3. Refine | Full resolution for the visible range, then pre-fetch ±1 window | PRF-028 |
| 4. Approach pre-fetch | Semantic-zoom targets fetched on approach or 300 ms dwell | PRF-029 |
| 5. Cancel aggressively | Superseded requests aborted | PRF-030 |
| 6. Truncation honesty | `truncated` / `422` surfaced with a "narrow" suggestion | PRF-031 |

#### PRF-025 — Local-first analytics
**MUST** · M-UI3 · SRE, Platform, Engineer, NOC

Summary pyramids of entity health signals MUST be held in the browser at the levels 10 s (live),
1 m, 12 m, 2 h and 1 d, matching PulsusDB's rollup lattice (T13 (draft)). A Rust columnar engine in
WASM MUST answer every query it can (scrub, re-facet, Compare on the loaded sample) in < 16 ms, and the
server MUST refine the same query through the same query interface. Each viewport MUST show its
source badge: ⚡ local, ☁ server or ✓ exact. Where PulsusDB cannot serve rollups, the fallback
pyramids are Dash-derived state stored in PostgreSQL, never written into PulsusDB (decision D2,
[ADR-0012](../adr/0012-derived-state-in-postgres.md)).

*Acceptance:* With the pyramids loaded, scrubbing, re-faceting and Universal Compare on the loaded
sample return in < 16 ms (p99) with the ⚡ badge, then switch to ☁ or ✓ when the server answer
arrives; no write request is sent to PulsusDB.

#### PRF-026 — Show cached, marked stale
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

On opening a view, the last-viewed data for it MUST be shown from IndexedDB, marked stale with subtle
hatching, until fresh data replaces it.

*Acceptance:* Re-opening a previously viewed scene with the network delayed by 2 s shows the cached
data hatched within the first frame after the scene opens, and the hatching disappears when fresh data
paints.

#### PRF-027 — Coarse first
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

The first query for a time-series viewport MUST use a step of about (pixel width / 4) of the visible
range and paint that result before refinement.

*Acceptance:* For a 1 200 px wide viewport over 1 h, the first query issued has a step of
≈ 3 600 s / 300 = 12 s (±1 rollup level), and its result is painted before the refined query
returns.

#### PRF-028 — Refine and pre-fetch neighbours
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

After the coarse paint, the client MUST fetch full resolution for the visible range and then
pre-fetch one window width either side, so that panning by up to one window needs no new request.

*Acceptance:* After a view is fully refined, panning by one window width left or right issues no new
query for the revealed range and shows full-resolution data in the first frame.

#### PRF-029 — Approach pre-fetch
**MUST** · M-UI2 · SRE, Platform, Engineer

The next semantic-zoom level's data MUST be requested at low resolution when the camera approaches
the level threshold or dwells on an entity for > 300 ms ([03](03-interaction-model.md) §5).

*Acceptance:* Dwelling the camera on an entity for 300 ms issues the low-resolution query for its
Lens; diving after that shows coarse data in the first frame of arrival.

#### PRF-030 — Cancel superseded requests
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

Any request superseded by newer user intent MUST be aborted (HTTP/2 stream reset), and a stale
response MUST NOT paint over a fresh one.

*Acceptance:* Changing the time window 10 times in 1 s results in 9 cancelled requests visible in the
network trace and only the last window's data painted.

#### PRF-031 — Truncation honesty
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support

A PulsusDB `truncated` flag or `422` "too broad" response MUST be shown as an explicit badge on the
affected viewport with a one-click "narrow" suggestion, and MUST NOT be silently dropped.

*Acceptance:* Given a seeded query that returns `truncated=true`, the viewport shows a partial-data
badge; given one that returns `422`, the viewport shows the error with a "narrow" action that, when
clicked, re-issues a narrower query.

## 7. Mobile PWA budgets

Mobile is read, acknowledge and AI only (PRN-014 in [01](01-vision-and-principles.md)). These
budgets apply on reference devices (d) and (e). They are measured nightly on a real-device lab,
not per pull request ([T05](../technical/T05-testing-and-performance.md)).

| Metric | Target on (d)/(e) | Hard limit | Requirement |
|---|---|---|---|
| Notification tap → card text visible, warm (app in memory) | ≤ 300 ms | 500 ms | PRF-035 |
| Notification tap → card text visible, cold (service-worker cache + IndexedDB) | ≤ 1.5 s | 2.5 s | PRF-036 |
| Card refresh from network (4G) | ≤ 1.5 s | — | PRF-037 |
| Mobile shell + core WASM together | ≤ 1.5 MB brotli | 2 MB | PRF-038 |
| Scroll/pan | 60 fps (≥ 45 fps p99 on (d)) | — | PRF-039 |
| Tab memory | ≤ 300 MB | 400 MB | PRF-040 |
| Service-worker `push` handler wall time | ≤ 50 ms | — | PRF-041 |
| Idle CPU (foreground, no interaction) | ~0 (no rAF loop) | — | PRF-042 |

## 8. Budgets enforced in CI

#### PRF-032 — Per-visualisation GPU benchmarks in CI
**MUST** · M-UI0 · Platform, Engineer

CI MUST run headless GPU benchmarks (Chrome with WebGPU and with WebGL2) on runners matching (a) and
(b) for every visualisation, reporting frame time p50 and p99, and MUST fail the build when PRF-001
or PRF-002 is not met.

*Acceptance:* A change that raises a visualisation's p99 frame time on (b) above 22.2 ms fails CI
with that visualisation's p50/p99 in the report.

#### PRF-033 — Bundle-size and DOM-room gates
**MUST** · M-UI0 · Platform, Engineer, Admin

CI MUST enforce a bundle-size budget per crate (with the core total of PRF-009) and MUST run
Lighthouse with an INP check on the DOM rooms, failing when INP exceeds 200 ms.

*Acceptance:* A change that pushes the core WASM to ≥ 3 MB brotli, or a crate past its own budget,
or a DOM room's INP above 200 ms, fails CI.

#### PRF-034 — Synthetic Lens load
**MUST** · M-UI2 · Platform, Engineer

CI MUST run a synthetic Lens load against a seeded PulsusDB with known data volumes and MUST fail when
PRF-010 or PRF-011 is not met.

*Acceptance:* A change that raises the p75 time to fully refined Lens above 1.5 s on the seeded
dataset fails CI.

## 9. Mobile requirements

#### PRF-035 — Mobile warm open from notification
**MUST** · M-UI4 · SRE, Business, Support

With the app in memory, tapping a notification MUST show the alert card text in ≤ 300 ms, and MUST
NOT exceed 500 ms.

*Acceptance:* On (d) and (e), median warm tap-to-text is ≤ 300 ms and the maximum over 20 runs is
≤ 500 ms.

#### PRF-036 — Mobile cold open from notification
**MUST** · M-UI4 · SRE, Business, Support

From a cold start, served from the service-worker cache and IndexedDB, tapping a notification MUST
show the alert card text in ≤ 1.5 s, and MUST NOT exceed 2.5 s.

*Acceptance:* On (d) and (e), median cold tap-to-text is ≤ 1.5 s and the maximum over 20 runs is
≤ 2.5 s.

#### PRF-037 — Mobile card refresh
**MUST** · M-UI4 · SRE, Business, Support

Refreshing an open card from the network over 4G MUST complete in ≤ 1.5 s.

*Acceptance:* On (d) and (e) with a 4G network profile, median card refresh is ≤ 1.5 s.

#### PRF-038 — Mobile bundle size
**MUST** · M-UI4 · SRE, Business, Support

The mobile shell and mobile core WASM together MUST be ≤ 1.5 MB brotli, and MUST NOT exceed 2 MB.

*Acceptance:* The CI bundle gate reports the combined brotli size ≤ 1.5 MB, and fails the build at
> 2 MB.

#### PRF-039 — Mobile scroll and pan
**MUST** · M-UI4 · SRE, Business, Support

Scroll and pan on mobile MUST run at 60 fps, and MUST NOT drop below 45 fps at p99 on (d).

*Acceptance:* On (d) and (e), median frame rate during scripted scroll/pan is ≥ 60 fps, and p99 frame
time on (d) is ≤ 22.2 ms.

#### PRF-040 — Mobile memory
**MUST** · M-UI4 · SRE, Business, Support

Mobile tab memory MUST be ≤ 300 MB and MUST NOT exceed 400 MB.

*Acceptance:* Peak tab memory during the mobile benchmark on (d) and (e) is ≤ 300 MB, and never
exceeds 400 MB.

#### PRF-041 — Push handler wall time
**MUST** · M-UI4 · SRE, Business, Support

The service-worker `push` handler MUST complete in ≤ 50 ms of wall time.

*Acceptance:* On (d) and (e), the p95 `push` handler duration in device traces is ≤ 50 ms.

#### PRF-042 — Mobile idle CPU
**MUST** · M-UI4 · SRE, Business, Support

In the foreground with no interaction, the mobile app MUST use approximately zero CPU and MUST NOT run
a requestAnimationFrame loop.

*Acceptance:* A 60 s idle trace on (d) and (e) shows no rAF callbacks and < 1% average CPU.

## 10. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| PRF-001 | Frame rate during interaction | MUST | M-UI0 |
| PRF-002 | Frame-rate floor | MUST | M-UI0 |
| PRF-003 | Input to photon | MUST | M-UI0 |
| PRF-004 | Input to photon hard limit | MUST | M-UI0 |
| PRF-005 | No main-thread long tasks during interaction | MUST | M-UI0 |
| PRF-006 | No interaction waits on the network | MUST | M-UI0 |
| PRF-007 | Camera transition duration | MUST | M-UI1 |
| PRF-008 | Cold load to interactive shell | MUST | M-UI1 |
| PRF-009 | Core bundle size and lazy loading | MUST | M-UI0 |
| PRF-010 | Warm navigation to first coarse Lens data | MUST | M-UI2 |
| PRF-011 | Lens fully refined | MUST | M-UI2 |
| PRF-012 | Atlas first paint | MUST | M-UI3 |
| PRF-013 | RCA Stage 1 ready | MUST | M-UI4 |
| PRF-014 | RCA Stage 2 ready | MUST | M-UI4 |
| PRF-015 | Live tail latency | MUST | M-UI2 |
| PRF-016 | 10⁸ line-chart points | MUST | M-UI0 |
| PRF-017 | 10⁷ scatter points | MUST | M-UI0 |
| PRF-018 | 10⁴ series per scene | MUST | M-UI1 |
| PRF-019 | Atlas 10⁴ entities and 5×10⁴ edges | MUST | M-UI3 |
| PRF-020 | 10⁶ log lines scrollable | MUST | M-UI1 |
| PRF-021 | 10⁵ flame-graph frames | MUST | M-UI2 |
| PRF-022 | 200 viewports per board | MUST | M-UI5 |
| PRF-023 | Memory budget | MUST | M-UI0 |
| PRF-024 | Graceful degradation under memory pressure | MUST | M-UI1 |
| PRF-025 | Local-first analytics | MUST | M-UI3 |
| PRF-026 | Show cached, marked stale | MUST | M-UI1 |
| PRF-027 | Coarse first | MUST | M-UI1 |
| PRF-028 | Refine and pre-fetch neighbours | MUST | M-UI1 |
| PRF-029 | Approach pre-fetch | MUST | M-UI2 |
| PRF-030 | Cancel superseded requests | MUST | M-UI1 |
| PRF-031 | Truncation honesty | MUST | M-UI1 |
| PRF-032 | Per-visualisation GPU benchmarks in CI | MUST | M-UI0 |
| PRF-033 | Bundle-size and DOM-room gates | MUST | M-UI0 |
| PRF-034 | Synthetic Lens load | MUST | M-UI2 |
| PRF-035 | Mobile warm open from notification | MUST | M-UI4 |
| PRF-036 | Mobile cold open from notification | MUST | M-UI4 |
| PRF-037 | Mobile card refresh | MUST | M-UI4 |
| PRF-038 | Mobile bundle size | MUST | M-UI4 |
| PRF-039 | Mobile scroll and pan | MUST | M-UI4 |
| PRF-040 | Mobile memory | MUST | M-UI4 |
| PRF-041 | Push handler wall time | MUST | M-UI4 |
| PRF-042 | Mobile idle CPU | MUST | M-UI4 |
| PRF-043 | 3D City and Infra scene volume | MUST | M-UI3 |
| PRF-044 | WebGL2 tier: same geometry, reduced effects | MUST | M-UI3 |
| PRF-045 | 3D flight and floors hold the frame floor | MUST | M-UI3 |
| PRF-046 | Fleet line stack volume | MUST | M-UI3 |

## 11. Resolved during formalisation

1. **Mobile targets.** The draft deferred mobile targets to T20 §6, which is still a draft. A
   performance contract cannot rest on an unpromoted document, so the T20 (draft) §6 table is
   carried here as PRF-035 to PRF-042. T20 should reference these IDs when promoted.
2. **Target vs hard limit.** Where the draft gave both, the target and the hard limit are separate
   requirements (e.g. PRF-001/PRF-002, PRF-003/PRF-004), so that each gate has one number.
3. **INP threshold.** The draft required "Lighthouse/INP on the DOM rooms" without a number. PRF-033
   sets 200 ms (the Web Vitals "good" threshold).
4. **Percentiles and sample counts.** The draft gave latency targets without a percentile. Latency
   targets use p75 (load) or p95 (pipelines), and the mobile hard limits are a maximum over 20 runs.
   RCA Stage 1 uses ≥ 95% of alerts; Stage 2 must always produce at least a partial result.
5. **Atlas edge volume vs PulsusDB cap.** 5×10⁴ edges exceeds PulsusDB's current 1 000-edge
   service-graph cap. PRF-019 relies on assumption A1 and states the fallback.
6. **Fallback pyramids.** Where PulsusDB cannot serve rollups, the client's pyramids come from
   Dash-derived tiles in PostgreSQL (D2); PRF-025 forbids writing them to PulsusDB.
7. **Wall hardware (c).** The draft listed (c) but set no wall-specific target. PRF-001 and
   PRF-019 apply on (c); wall-specific attention behaviour is in [08](08-visual-language.md).
8. **3D-first estate (1.0-rc2).** The owner's brief makes the estate a 3D scene by default, so the
   3D City/Infra volume (PRF-043), the WebGL2 tier (PRF-044), the flight and floors (PRF-045) and
   the fleet line stack (PRF-046) became gated requirements; PRF-019 now covers the 3D Topology.

## 12. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft; mobile budgets imported from T20 (draft) §6 |
| 1.0-rc2 | 2026-11-18 | 3D-first estate per owner brief: §5 table rows and PRF-019 acceptance edited; §5.1 PRF-043 to PRF-046 added; resolution 8 |
| 1.0-rc2 | 2026-11-18 | #23: PRF-005 verification note (CI browser trace as the merge gate until the reference lab exists) |
| 1.0-rc3 | 2026-11-19 | Roadmap D5 ([12](12-roadmap.md) §2.1): PRF-020 moves M-UI2 → M-UI1 (delivered by #49) |
