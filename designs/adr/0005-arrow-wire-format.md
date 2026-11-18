# ADR-0005: Arrow IPC from BFF to browser; JSON only for config/CRUD

| | |
|---|---|
| **Status** | Proposed |
| **Source** | Design (2026-11-17), open question Q6 |
| **See** | [T01 §3](../technical/T01-frontend-architecture.md), [R1](../technical/pulsusdb-requirements.md) |

## Context

PulsusDB's Prometheus-style JSON sends values as strings. Decoding 10⁷ of them in WASM breaks frame and memory budgets.

## Decision

The BFF streams Arrow IPC to the browser. Until PulsusDB emits a columnar format natively (R1), the BFF converts JSON → Arrow. An M-UI0 benchmark decides between Arrow and columnar protobuf for the PulsusDB → BFF leg.

## Consequences

BFF CPU cost until R1 lands. One columnar format end to end in the browser.
