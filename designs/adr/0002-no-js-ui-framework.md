# ADR-0002: No JavaScript UI framework (React, Vue, Svelte, Angular) or JS component libraries

| | |
|---|---|
| **Status** | Accepted |
| **Source** | Follows from ADR-0001 (2026-11-18) |
| **See** | [T01 §1](../technical/T01-frontend-architecture.md) |

## Context

A JS UI framework would hold UI state and logic in JavaScript, which breaks ADR-0001.

## Decision

No React or similar. DOM parts of the UI (forms, tables ≤ 10k rows, inspector, tooltips, Explorer) are Rust, using a Rust/WASM UI framework ([ADR-0004](0004-leptos-dom-rooms.md)).

## Consequences

No MUI / AG Grid / date pickers: we build a small component kit ([T08](../technical/T08-dom-component-kit.md)). No React-based panel plugins; extensibility is a declarative vis spec, later sandboxed WASM modules ([05 §11](../product/05-visualisation-catalogue.md)).
