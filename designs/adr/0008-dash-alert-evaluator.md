# ADR-0008: Pulsus Dash evaluates alerting rules first; migrate to the PulsusDB ruler later

| | |
|---|---|
| **Status** | Proposed |
| **Source** | Open question Q3 |
| **See** | [07 §1](../product/07-alerting.md), [R15](../technical/pulsusdb-requirements.md) |

## Context

The PulsusDB ruler evaluates recording rules today, and alerting-rule evaluation comes post-1.0.

## Decision

Dash runs its own HA rule evaluator against PulsusDB. The UI is agnostic, so evaluation can move to PulsusDB when R15 lands.

## Consequences

Dash owns evaluation scaling and correctness for now.
