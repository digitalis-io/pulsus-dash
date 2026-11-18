# ADR-0007: In-house vis engine built from GPU mark primitives

| | |
|---|---|
| **Status** | Accepted |
| **Source** | Follows from ADR-0001 (2026-11-18) |
| **See** | [T02](../technical/T02-vis-engine.md) |

## Context

No JS charting, mapping or 3D library is allowed. Building ~40 charts one by one would not be tractable.

## Decision

Build ~12 instanced mark primitives, shared scales/axes/layouts/picking, and express every vis as a declarative composition.

## Consequences

A dedicated vis-platform team owns L0–L4. Geomap and the guide layers (ticks, text, time zones) are the main schedule risks.
