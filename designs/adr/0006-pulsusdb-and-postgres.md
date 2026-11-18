# ADR-0006: PulsusDB for all telemetry; PostgreSQL for configuration and state

| | |
|---|---|
| **Status** | Accepted (amended by [ADR-0009](0009-optional-object-storage.md), [ADR-0012](0012-derived-state-in-postgres.md)) |
| **Source** | Product owner mandate (2026-11-17) |
| **See** | [11](../product/11-enterprise.md), [07 §8](../product/07-alerting.md) |

## Context

Unified metrics, logs, traces and profiles come from one store. Enterprise configuration needs a transactional store.

## Decision

Telemetry is read from PulsusDB. Boards, alert rules, RBAC, preferences, investigations, incidents and contact points live in Postgres. Dash-originated events and derived state (alert transitions, notification deliveries, baselines, anomaly scores, change events, fallback pyramids) live in Postgres ([ADR-0012](0012-derived-state-in-postgres.md)). Dash writes to PulsusDB only its **own self-telemetry** (it is an ordinary instrumented service) and, if an operator configures it, the audit export sink.

## Consequences

No other telemetry stores in v1 beyond Prometheus-API-compatible read-only sources (Q5).
