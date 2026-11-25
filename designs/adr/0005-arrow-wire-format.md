# ADR-0005: Arrow IPC from BFF to browser; JSON only for config/CRUD

| | |
|---|---|
| **Status** | Proposed; amended 2026-11-25 (owner direction, #68 Part B: the BFF converts, R1 optional, the engine's own reader) |
| **Source** | Design (2026-11-17), open question Q6 |
| **See** | [T01 §3](../technical/T01-frontend-architecture.md), [T04](../technical/T04-wire-format-and-data-plane.md), [R1](../technical/pulsusdb-requirements.md) |

## Context

PulsusDB's Prometheus-style JSON sends values as strings. Decoding 10⁷ of them in WASM breaks frame and memory budgets.

PulsusDB answers only in JSON today and nothing more is asked of it for Dash to work (owner
direction 2026-11-25).

## Decision

The BFF streams Arrow IPC in DSF frames to the browser. The BFF converts PulsusDB's JSON to Arrow
(`server/internal/arrowwire`, from the decode of `internal/pulsusdb`). This is the committed path
and needs nothing from PulsusDB. A native columnar output from PulsusDB (R1) is an optional
future. The PulsusDB → BFF benchmark of Arrow against columnar protobuf runs only if R1 is offered.

The browser engine reads Arrow IPC with its own reader for the v1 schemas (`dash-wire`), not
arrow-rs. This is an owner decision of 2026-11-25: arrow-array pulls a CC0-1.0 crate into the
wasm32 build, and CC0-1.0 is outside the [ADR-0014](0014-typescript-react-web-client.md) §7
licence set.

## Consequences

The BFF's conversion CPU is permanent. It is measured by T06 `bench:json-to-arrow`. There is one
columnar format end to end in the browser. The engine's reader supports only the types and
schemas it reads; a new schema or a dictionary adds reader support and its tests first.
