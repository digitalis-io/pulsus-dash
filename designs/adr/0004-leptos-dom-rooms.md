# ADR-0004: Leptos for DOM rooms

| | |
|---|---|
| **Status** | **Superseded** (2026-11-19) by [ADR-0014](0014-typescript-react-web-client.md); was Accepted 2026-11-18 |
| **Source** | Open question Q1 |
| **See** | [T01 §3](../technical/T01-frontend-architecture.md), [12 Q1](../product/12-roadmap.md) |

## Context

Enterprise forms, accessibility (WCAG 2.2 AA), IME and autofill need real DOM. Drawing everything on the canvas (egui) would mean reinventing them.

## Decision

Use Leptos (fine-grained reactive, Rust → WASM) for DOM rooms and panels. The GPU canvas is separate (ADR-0003).

## Consequences

Leptos is a smaller ecosystem than React; we own more components ([T08](../technical/T08-dom-component-kit.md)). Dioxus was the alternative and is not pursued. The M-UI1 forms + table + tree work is now a build risk check, not a selection spike: if it exposes a blocker, this ADR is reopened.
