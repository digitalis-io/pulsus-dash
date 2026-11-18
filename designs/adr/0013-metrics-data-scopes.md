# ADR-0013: Data scopes on metrics without promoted resource attributes

| | |
|---|---|
| **Status** | Proposed — **open decision** for the product owner |
| **Source** | PulsusDB finding (R16), 2026-11-18 |
| **See** | [T10 (draft)], [R16](../technical/pulsusdb-requirements.md), [11 Enterprise](../product/11-enterprise.md) |

## Context

PulsusDB does not copy OTel resource attributes (e.g. `deployment.environment`,
`k8s.namespace.name`) onto metric series. They sit only on `target_info`. A data scope such as
"env=prod only" or "namespace=payments" therefore cannot be enforced by rewriting a metrics
selector. Logs, traces and profiles are unaffected.

## Options

| | Option | Effect | Risk |
|---|---|---|---|
| A | **Fail closed** | Scoped users see no metrics unless every scope attribute is a metric label | Safe; a visible gap for regulated customers |
| B | **Label path** (recommended default) | Enforce on metric labels when the collector copies resource attributes to labels (OTel `resource_to_telemetry_conversion`, or a PulsusDB promotion list). Dash checks per metric family that the label is present; families without it fail closed, with an explanation in the coverage meter | Safe; depends on collector configuration that Dash can verify and report |
| C | **`target_info` join** | Rewrite as `… and on(job, instance) group_left target_info{scope}` | Expensive and fragile; join semantics leak series with stale `target_info` → **not safe as an enforcement mechanism** |
| D | Wait for **R16** (PulsusDB promotes configured attributes) | Clean enforcement | Timing outside our control |

## Recommendation

Adopt **B as the shipped behaviour** (it includes A as the per-family fallback). Pursue **D** with
PulsusDB as the long-term answer. Never use C for enforcement; it may be used for display only.

## Decision

Pending product owner.
