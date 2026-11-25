# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-rust-wasm-everywhere.md) | Rust/WASM everywhere; browser JS is a byte/event shim only | **Superseded** (2026-11-19) → 0014, 0015 |
| [0002](0002-no-js-ui-framework.md) | No JavaScript UI framework (React, Vue, Svelte, Angular) or JS component libraries | **Superseded** (2026-11-19) → 0014 |
| [0003](0003-wgpu-rendering.md) | wgpu for all rendering: WebGPU primary, WebGL2 fallback, native headless | Proposed |
| [0004](0004-leptos-dom-rooms.md) | Leptos for DOM rooms | **Superseded** (2026-11-19) → 0014 |
| [0005](0005-arrow-wire-format.md) | Arrow IPC from BFF to browser; JSON only for config/CRUD | Proposed; applies from the chart engine on (0014 §5) |
| [0006](0006-pulsusdb-and-postgres.md) | PulsusDB for all telemetry; PostgreSQL for configuration and state | Accepted (amended by 0009, 0012) |
| [0007](0007-in-house-vis-engine.md) | In-house vis engine built from GPU mark primitives | Accepted |
| [0008](0008-dash-alert-evaluator.md) | Pulsus Dash evaluates alerting rules first; migrate to the PulsusDB ruler later | Proposed |
| [0009](0009-optional-object-storage.md) | Optional S3-compatible object storage for large artefacts | Proposed |
| [0010](0010-dash-writes-derived-series.md) | Dash writes derived telemetry back to PulsusDB | **Rejected** (2026-11-18) → 0012 |
| [0011](0011-terraform-provider-in-go.md) | Terraform provider written in Go | Proposed |
| [0012](0012-derived-state-in-postgres.md) | Dash-derived state (alert history, baselines, anomaly scores, change events, fallback pyramids) lives in PostgreSQL | **Accepted** (2026-11-18) |
| [0013](0013-metrics-data-scopes.md) | Data scopes on metrics without promoted resource attributes | Proposed — **open decision** |
| [0014](0014-typescript-react-web-client.md) | TypeScript, React and Vite web client; a WASM chart engine later behind a typed API | **Accepted** (2026-11-19; amended by 0016, 0017, 0019, 0020, 0022, 0023, 0024, 0025) |
| [0015](0015-go-bff.md) | The BFF is written in Go | **Accepted** (2026-11-19; amended by 0021, query validation) |
| [0016](0016-asset-integrity-verified-by-bff.md) | Asset integrity is verified by the BFF, not per module in the browser (amends 0014's lazy-chunk SRI) | **Accepted** (2026-11-19) |
| [0017](0017-react-router.md) | React Router (data mode) replaces TanStack Router | **Accepted** (2026-11-19) |
| [0018](0018-query-language-modules.md) | One PulsusDB client with a module per query language; one QueryLanguage per language in the browser | **Accepted** (2026-11-21) |
| [0019](0019-chart-frame-drawn-event-and-frame-id.md) | The chart engine seam reports completed draws (`drawn`) and carries a frame identity (`FrameInit.id`); amends 0014 §3 | **Accepted** (2026-11-21) |
| [0020](0020-chart-camera-commit-and-value-range.md) | The chart engine seam reports camera commits (`commit`) and carries a value-axis range (`valueRange`, `valueAxis`); amends 0014 §3 | **Accepted** (2026-11-21) |
| [0021](0021-query-planning-is-server-side.md) | Query planning (substitution, rate rewrites, size limits) is server-side, in the Go language modules; the browser sends inputs, not a plan; amends 0015 "Query validation" | **Accepted** (2026-11-21) |
| [0022](0022-chart-thresholds-and-stat-sparkline.md) | The chart engine seam carries threshold lines (`thresholds`, `thresholdLabels`) and draws a stat sparkline; amends 0014 §3 | **Accepted** (2026-11-22) |
| [0023](0023-chart-event-markers.md) | The chart engine seam carries event markers (`setEvents`, `eventLabels`), drawn as lines over the series with labels in a band above the plot; amends 0014 §3 | **Accepted** (2026-11-23) |
| [0024](0024-markdown-runtime-dependencies.md) | Markdown runtime dependencies: `commonmark`, `parse5` and `parse5-sax-parser` join the runtime allowlist, the parse5 tree and tokenizer used together as a union; amends 0014 §7 | **Accepted** (2026-11-25) |
| [0025](0025-chart-frame-selection.md) | The chart engine seam carries the selection (`setSelection`, the `select` item) and draws it in the layer pass; amends 0014 §3 | **Accepted** (2026-11-25) |

Format: context, decision, consequences. An ADR is immutable once Accepted. It can be changed
only by a later ADR that supersedes it.
