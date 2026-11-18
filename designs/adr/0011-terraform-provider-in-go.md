# ADR-0011: Terraform provider written in Go

| | |
|---|---|
| **Status** | Proposed |
| **Source** | T11 (2026-11-18) |
| **See** | [T11](../technical/T11-postgres-schema.md), [ADR-0001](0001-rust-wasm-everywhere.md) |

## Context

Customers want Dash configuration as code through Terraform. HashiCorp's supported provider SDK/framework is Go, and ADR-0001 says "Rust everywhere".

## Decision

ADR-0001 governs the product (browser and server). The Terraform provider is an external client of the public Dash API, so it is written in Go with the official plugin framework, generated where possible from the Dash OpenAPI description.

## Consequences

A small Go codebase to maintain, kept thin: no logic beyond API mapping. If an adequate Rust provider framework matures, revisit.
