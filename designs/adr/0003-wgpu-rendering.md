# ADR-0003: wgpu for all rendering: WebGPU primary, WebGL2 fallback, native headless

| | |
|---|---|
| **Status** | Proposed |
| **Source** | Design (2026-11-17) |
| **See** | [T02 §7](../technical/T02-vis-engine.md) |

## Context

We need one GPU code path across browsers that have WebGPU, browsers that only have WebGL2, and server-side rendering for notification images and tests.

## Decision

Use `wgpu`. Compute-shader features (decimation, KDE, binning) are on the WebGPU tier, with CPU/WASM-SIMD fallbacks on WebGL2. The same renderer runs natively and headless.

## Consequences

Two capability tiers to test. Scale ceilings differ by tier, and the coverage meter discloses which tier is in use.
