# ADR-0009: Optional S3-compatible object storage for large artefacts

| | |
|---|---|
| **Status** | Proposed |
| **Source** | T11, T17, T19 (2026-11-18) |
| **See** | T17 (draft), [T11](../technical/T11-postgres-schema.md), [T19](../technical/T19-deployment.md) |

## Context

Flight-recorder segments, replay recordings, rendered chart images and import bundles are large, append-only blobs. Keeping them in Postgres bloats backups. ADR-0006 named only PulsusDB and Postgres.

## Decision

Dash may use an S3-compatible object store (S3, GCS via S3 API, Azure via gateway, MinIO on-prem) for large immutable artefacts, referenced from Postgres. It is **optional**: without it, the same artefacts go to Postgres large-object tables with tighter retention.

## Consequences

One more optional dependency in the deployment matrix ([T19](../technical/T19-deployment.md)). Backup must cover both stores consistently ([T11](../technical/T11-postgres-schema.md)). Amends [ADR-0006](0006-pulsusdb-and-postgres.md).
