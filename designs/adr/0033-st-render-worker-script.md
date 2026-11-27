# ADR-0033: The `pulsus-engine` policy admits the single-thread render worker; browsers without `Atomics.waitAsync` and pages that are not isolated get the ST engine; amends 0026

| | |
|---|---|
| **Status** | Accepted (2026-11-27, on merge of #68 Part C2d2, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0026](0026-engine-csp-and-worker-policy.md) decision 2 (the policy admits three worker scripts of the build, not two) and its §Consequences (no `Atomics.waitAsync`, or no cross-origin isolation, selects the single-thread engine, not Canvas 2D). Exact-URL matching, the single policy, the CSP string and decisions 1 and 3 are unchanged |
| **Source** | Issue #68 Part C2d2 (`dash-core-st` and the ST mode) |
| **See** | [T03](../technical/T03-browser-runtime.md) §4.1, §5.2, §7.3, §9.2; [T18](../technical/T18-security.md) T18-005, T18-006; [T05](../technical/T05-testing-and-performance.md) §7.1 (`e2e:mode-matrix`, `e2e:csp-violations`); [ADR-0016](0016-asset-integrity-verified-by-bff.md) |

## Context

T03 §9.2 runs `dash-core-st` when the page is not cross-origin isolated: the same engine built
without shared memory, in one render worker, with input sent by batches. Part C1 drew those pages
with Canvas 2D until the ST engine existed. A browser that is isolated but has no
`Atomics.waitAsync` was also sent to Canvas 2D, because wasm-bindgen's fallback for the threaded
engine starts a worker from a `blob:` URL, which the policy refuses (ADR-0026 §Consequences). The ST
engine has no pool and does not need `Atomics.waitAsync`, so it serves that browser as well.

The ST render worker is a third worker script of the build (`render-st.worker.ts`). ADR-0026
decision 2 lets the `pulsus-engine` policy admit exactly two, the render and pool workers, so the
ST worker cannot be started under the production CSP.

## Decision

1. **Three worker scripts.** `pulsus-engine`'s `createScriptURL(u)` returns `u` only when `u`,
   resolved against the page, is exactly one of the three engine worker scripts of this build: the
   render worker, the pool worker and the ST render worker (each a `?worker&url` import in
   `client/src/engine/wasm/workerUrls.ts`). It throws for anything else: another path or name,
   another origin or port, a `blob:` or `data:` URL, or a query added to an engine URL.
2. **The rest of ADR-0026 decision 2 holds.** One policy, created once per page, only in
   `client/src/engine/wasm/workers.ts`; no `createHTML` or `createScript`. The document CSP is
   byte-identical (`worker-src 'self'`, `trusted-types pulsus-sanitised pulsus-engine`).
3. **ST, not Canvas 2D.** A page that is not cross-origin isolated, or is isolated but has no
   `Atomics.waitAsync`, runs the ST engine (with OffscreenCanvas and a GPU API; T03 §9.2), with the
   banner for its reason. Its wasm is integrity-checked against the BFF-verified manifest as the
   threaded engine's is (ADR-0016); a refused or failed ST boot marks the session as any engine
   boot does.

## Consequences

- `e2e:csp-violations` gains an ST leg: the ST engine boots under the production policy with no
  CSP or Trusted Types violation, and a page script can start no other worker script (a string URL
  is refused by the sink, and a second `pulsus-engine` policy cannot be made); and the page's own policy, called through the fault build's probe, refuses an unrelated same-origin script with a `TypeError` and starts no worker.
- `unit:worker-policy` admits the three URLs and rejects the ST worker's URL with a query, another
  file under `assets/`, the same path on another port, `blob:` and `data:`.
- `e2e:mode-matrix` M7 (`?mode=st`), M9 (not isolated) and M11 (no `Atomics.waitAsync`) run the ST
  engine; MT-R (#269) and Static (#270) still draw with Canvas 2D.
- A future worker (a data worker, Part D) is still added to the policy's list by name, in the same
  file.
