# ADR-0012: Dash-derived state lives in PostgreSQL, not PulsusDB

| | |
|---|---|
| **Status** | Accepted (2026-11-18, product owner) |
| **Source** | Decision on ADR-0010 |
| **Supersedes** | [ADR-0010](0010-dash-writes-derived-series.md) |
| **See** | [T11](../technical/T11-postgres-schema.md), [T16](../technical/T16-alert-evaluator.md), [07 Alerting](../product/07-alerting.md) |

## Context

Dash produces state that is derived from telemetry rather than being telemetry:
- alert transitions and notification deliveries (alert history);
- `ALERTS` / `ALERTS_FOR_STATE`-style state for queries;
- anomaly baselines and scores;
- entity change events;
- health pyramids when PulsusDB cannot serve rollups (R4).

ADR-0010 proposed writing these into customer PulsusDB tenants through ingest. That was rejected.
Dash must not consume customers' ingest capacity, must not depend on ingest being enabled for
its own correctness, and must keep its product state in the one store it operates and backs up.

## Decision

1. All Dash-derived state is stored in PostgreSQL, in tenant-scoped tables under row-level
   security ([T11](../technical/T11-postgres-schema.md)).
2. High-volume tables are **natively partitioned by time** (daily or monthly) with per-tenant
   retention enforced by dropping partitions. No extension (TimescaleDB, etc.) is required. An
   operator MAY enable one, but Dash MUST NOT depend on it.
3. Query integration: the BFF exposes this state through the **same query interface** as
   telemetry. The planner ([T07](../technical/T07-scene-query-planner.md)) resolves the reserved
   selectors `ALERTS`, `ALERTS_FOR_STATE`, `pulsus_anomaly_score` and the `{source="pulsus-dash"}`
   event stream against Postgres-backed virtual sources. It never sends them to PulsusDB. These
   virtual sources can be mixed with PulsusDB results in one scene, and in PromQL only as
   whole-selector operands joined in the BFF.
4. Fallback pyramids (R4 absent) are stored as compressed Arrow tiles (`bytea`, one row per
   entity × signal × level × tile) with short retention (7 days by default), regenerated on demand.
5. Dash writes to PulsusDB only its own self-telemetry, plus the audit export when configured.

## Consequences

- **Postgres sizing grows.** It becomes part of [T19](../technical/T19-deployment.md) sizing, with
  reference figures:
  - **Alert history:** about 1 KB per transition, with 13-month default retention.
  - **Anomaly scores:** 5-minute resolution per entity × signal, retained 30 days.
  - **Fallback pyramids:** bounded by entity count, retained 7 days.
- **PromQL limits.** PromQL functions over the virtual series run in the BFF, not in PulsusDB.
  Operators like `rate()` over `ALERTS` are supported. Arbitrary joins between virtual and
  PulsusDB series are supported only through the BFF's binary-op join, which has documented
  limits ([T07](../technical/T07-scene-query-planner.md)).
- **No dashboard-tool access through PulsusDB.** External tools reading PulsusDB directly do not see alert
  history. Dash's Prometheus-compatible read API exposes it instead.
- **Simpler security.** Customer telemetry tenants are never written by Dash, so tenant
  isolation and data scopes for derived state are enforced in one place (Postgres RLS + T10).
