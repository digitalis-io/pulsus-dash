# ADR-0001: Rust/WASM everywhere; browser JS is a byte/event shim only

| | |
|---|---|
| **Status** | **Superseded** (2026-11-19): browser part by [ADR-0014](0014-typescript-react-web-client.md), server part by [ADR-0015](0015-go-bff.md) |
| **Source** | Product owner mandate (2026-11-17) |
| **See** | [T01 §1](../technical/T01-frontend-architecture.md) |

## Context

Snappiness on a par with high-performance charting libraries and 10⁸-point scenes need predictable memory and CPU, with zero-copy data paths. JS application logic, GC pauses and JSON parsing in JS work against all of these.

## Decision

All application logic, state, decoding, layout and rendering is Rust compiled to WASM. Browser JS is limited to bootstrap, a network byte pump, input forwarding and thin browser integrations: a target of < 300 hand-written lines, no npm runtime dependencies, and a CI line budget.

## Consequences

No JS ecosystem libraries. Everything visual is built in-house ([ADR-0007](0007-in-house-vis-engine.md)). Hiring skews to Rust. The renderer and logic can run natively too (server-side images, desktop).
