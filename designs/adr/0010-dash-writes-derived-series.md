# ADR-0010: Dash may write derived telemetry (pyramids, baselines, alert history) back to PulsusDB

| | |
|---|---|
| **Status** | Rejected (2026-11-18, product owner) — superseded by [ADR-0012](0012-derived-state-in-postgres.md) |
| **Source** | T12, T13, T16 (2026-11-18) |
| **See** | T13 (draft), [T12](../technical/T12-entity-catalogue.md), [T16](../technical/T16-alert-evaluator.md) |

## Context

Several Dash features need derived series stored with the telemetry: health pyramids when the PulsusDB ruler is disabled (it is off by default and runs in mode `all` only), anomaly baselines and scores, and `ALERTS`-style alert history. ADR-0006 only covered Dash *events*.

## Decision

Dash writes derived series into PulsusDB via its standard ingest paths (Prometheus remote write, OTLP), under well-known metric names and `service.name=pulsus-dash`, into the same tenant as the source data. It never writes directly to ClickHouse. Where the PulsusDB ruler is enabled, recording rules are preferred ("self-ruler" only as fallback).

## Consequences

Dash consumes ingest capacity and storage in customer tenants, which must be visible in sizing ([T19](../technical/T19-deployment.md)) and attributed (`service.name=pulsus-dash`). Derived series inherit tenant isolation and data scopes. Amends [ADR-0006](0006-pulsusdb-and-postgres.md).
