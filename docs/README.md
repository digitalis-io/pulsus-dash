# Pulsus Dash — implementation documentation

This folder documents what is **built**. It covers how each part works, and how to use, configure
and operate it. The design it implements lives in [`../designs/`](../designs/README.md).

Pages are written alongside the code, per issue, and reviewed with the code.

| Area | Page | Implements |
|---|---|---|
| Development | [Build, test and CI](development/build-and-ci.md) | T01-002, T05-002, T18-001; gates `ci:lockfile`, `ci:lint-ts`, `ci:typecheck`, `ci:token-lint`, `unit:*`, `ci:bundle-size`, `ci:dep-audit`, `ci:npm-audit`, `e2e:*`, `golden:interim-gallery`, `bench:startup`, `bench:frame-interim-line`, `ci:go-mod`, `ci:api-gen`, `ci:go-lint`, `ci:go-test`, `ci:govulncheck`, `ci:migrations`, `unit:config-strict` |
| Client | [Client application](client/README.md) | IA-002, IA-015, IA-016, IA-020, IA-021, IA-022, IA-023, INT-032, VL-001, VL-010, VL-017, VL-021, PRF-033; T01-007, T01-008, T01-010, T02-004, T03-013, T03-014, T03-017, T08-005, T08-007, T08-008, T08-010, T08-022, T08-023, T08-027, T18-001, T18-004; ADR-0014, ADR-0016, ADR-0017 |
| Client | [JavaScript supply chain](client/supply-chain.md) | T01-002, ADR-0014 §7 |
| Client | [Charts](client/charts.md) | VL-002, VL-006, VL-012, INT-033, VIZ-001, VIZ-010, VIZ-013, VIZ-069; T01-002, T01-009, T02-005; ADR-0014 §3–§4 |
| Server | [Server (BFF)](server/README.md) | T06-001, T06-003, T06-019, T06-026, T19-006, T19-007, T19-010; ADR-0015 |
| Server | [Server database](server/database.md) | ENT-020 (partial: `orgs`, `tenant_bindings` under RLS); T06-016, T11-001, T11-002, T11-003, T11-012, T11-013, T11-015, T11-023; gates `itest:rls-isolation`, `itest:no-extensions`, `itest:migrations`, `ci:migrations`; ADR-0012 |
