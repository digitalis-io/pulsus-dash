# Architecture Decision Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-rust-wasm-everywhere.md) | Rust/WASM everywhere; browser JS is a byte/event shim only | Accepted |
| [0002](0002-no-js-ui-framework.md) | No JavaScript UI framework (React, Vue, Svelte, Angular) or JS component libraries | Accepted |
| [0003](0003-wgpu-rendering.md) | wgpu for all rendering: WebGPU primary, WebGL2 fallback, native headless | Proposed |
| [0004](0004-leptos-dom-rooms.md) | Leptos for DOM rooms | **Accepted** (2026-11-18) |
| [0005](0005-arrow-wire-format.md) | Arrow IPC from BFF to browser; JSON only for config/CRUD | Proposed |
| [0006](0006-pulsusdb-and-postgres.md) | PulsusDB for all telemetry; PostgreSQL for configuration and state | Accepted (amended by 0009, 0012) |
| [0007](0007-in-house-vis-engine.md) | In-house vis engine built from GPU mark primitives | Accepted |
| [0008](0008-dash-alert-evaluator.md) | Pulsus Dash evaluates alerting rules first; migrate to the PulsusDB ruler later | Proposed |
| [0009](0009-optional-object-storage.md) | Optional S3-compatible object storage for large artefacts | Proposed |
| [0010](0010-dash-writes-derived-series.md) | Dash writes derived telemetry back to PulsusDB | **Rejected** (2026-11-18) → 0012 |
| [0011](0011-terraform-provider-in-go.md) | Terraform provider written in Go | Proposed |
| [0012](0012-derived-state-in-postgres.md) | Dash-derived state (alert history, baselines, anomaly scores, change events, fallback pyramids) lives in PostgreSQL | **Accepted** (2026-11-18) |
| [0013](0013-metrics-data-scopes.md) | Data scopes on metrics without promoted resource attributes | Proposed — **open decision** |

Format: context, decision, consequences. An ADR is immutable once Accepted. It can be changed
only by a later ADR that supersedes it.
