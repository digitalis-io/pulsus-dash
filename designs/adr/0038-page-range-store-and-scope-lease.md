# ADR-0038: Board range data from a page-wide store of 256-step buckets, under a scope epoch and a lease

| | |
|---|---|
| **Status** | Accepted (on merge of #304, owner's delegate, 2026-11-27) |
| **Amends** | [ADR-0021](0021-query-planning-is-server-side.md) §1 (the step comes from the chart width: the client may now choose a ladder step, the server validates and still plans); [ADR-0014](0014-typescript-react-web-client.md) §3 (a line frame may hold more than its window, with a `fit`); [ADR-0034](0034-grid-part-joined-into-one-chunk.md) §3 (stitched spans are copied once on the main thread, bounded by the store's budgets; the worker table is unchanged) |
| **Source** | Issue #304 (smooth zoom and pan: overscan, prefetch, progressive refine) |
| **See** | [T04](../technical/T04-wire-format-and-data-plane.md) §4.4 v1 note, T04-017, T04-018; [T07](../technical/T07-scene-query-planner.md) §4.6 v1 note, T07-012; [T02](../technical/T02-vis-engine.md) §4.3; [T06](../technical/T06-bff-architecture.md) bootstrap; [09](../product/09-performance-contract.md) PRF-026, PRF-028, PRF-030 |

## Context

PRF-028 asks that a refined view prefetch one window either side so that a pan of up to one window
needs no query, and PRF-030 that a newer view cancel the older one's requests. Board panels ran
one TanStack query per key (window, step): every pan waited for a new request, and nothing was
shared between panels of the same query or between pans. A PromQL range value at a grid time
depends only on that time and the step, so data fetched in grid-aligned pieces stitches into
exactly what one request returns. Holding data in the browser raises two questions: how much, and
what happens when the principal's access narrows while the page holds data the BFF released under
the earlier scope.

## Decision

1. **Buckets.** Board PromQL range data is held per *identity* (tenant, scope epoch, text,
   variables, rate chip, the range macros' window when the text uses one, step) as buckets of 256
   grid points: bucket `k` covers `k·256·step … (k·256 + 255)·step`. A run of at most 42 buckets is
   requested as exactly those points with `step_ms` (a PromQL ladder entry); the BFF validates the
   step against the ladder and plans as before. `@ start()` / `@ end()` queries, baseline runs and
   degraded runs are not stored.
2. **Store.** One store per page holds every identity's buckets (`STORE_BYTES` 128 MiB, pinned
   included, LRU over unpinned), shared by panels, Explore, pans, zooms and refreshes. A view's
   visible buckets are fetched `interactive`; a line view also fetches one window either side
   `prefetch`. A response is written per bucket only if it is not older (start generation, refresh
   epoch, clock anchor) than what is held; an aborted request's response is never stored.
3. **Admission and bypass.** A visible run over 2²¹ series × points, or one that cannot fit after
   evicting every unpinned segment, is not stored: the panel takes today's single request (its 500
   series cap and notices). Stitched spans of retained views are bounded by `ASSEMBLY_BYTES`
   64 MiB; flanks are trimmed first.
4. **Freshness.** A bucket is fresh for a view under the same refresh epoch and, unless it ended
   more than 5 min before its anchor (settled), the same anchor. Stale held spans are shown hatched
   (PRF-026's subtle hatching, T04-018) until revalidated.
5. **Fit.** A line frame may receive its held span (the window ± 1) with `fit` = the visible grid:
   its auto value domain and summary use only samples inside `fit`, so data held outside the window
   never moves the axis.
6. **Threat model and scope.** The store holds only data this session already received from the
   BFF under a scope check; showing it again after access narrows discloses nothing new (as a tab
   still showing yesterday's charts). The BFF stays the only boundary: no new data leaves it
   without the current check. Each range response and the bootstrap carry the *scope epoch* (a
   hash of principal, binding and data scope; the endpoint and the credential reference enter
   only as hashes) and `scope_seq`. The client accepts an epoch only with a sequence not lower than
   the current one and never restores a retired epoch; a newer epoch, a `scope_denied` and a
   tenant switch drop the tenant's data at once.
7. **Lease.** Every reuse of store-derived data (a peek, a load, a placeholder, a mounted panel's
   query data) is allowed only while the current epoch was confirmed less than 5 min ago (the
   receipt time of a response or of the bootstrap, never a render time). Past the lease nothing
   cached is painted before the visible run is fetched again; that response renews or changes
   the epoch.
8. **`scope_seq`.** `tenant_bindings.scope_seq` comes from one global sequence: every insert and
   every change of an access-determining column takes the next value, and an update that would
   lower it is refused, so a deleted and recreated binding never reuses a lower value. Any later
   access-determining change (roles, data scopes) MUST take the next value in the same transaction.
   A credential rotated under the same reference changes neither the epoch nor the sequence (owner
   decision 2026-11-27): the reference names the same access.
9. **Scheduler.** Every board range request of the page (store runs and single requests, LogQL
   frames included) runs through one scheduler: at most 6 in flight, 4 non-interactive; while
   non-interactive work waits with none running, interactive holds at most 5; preemption aborts the
   newest non-interactive job only when two or more run. A view change cancels every job with no
   wanted bucket in the same call (HTTP/2 RST, T04-013).

## Consequences

- A one-window pan of a refined line view paints in its first frame with no request for the
  revealed window (PRF-028); only the next flank is fetched.
- A by-reference chunk (ADR-0034) reaches the line frame only while one segment is the held span;
  stitched spans go by value.
- The bootstrap gains `scope_epoch` and `scope_seq`; the range route gains `step_ms`, `range_ms`
  and the `X-Pulsus-Scope-Epoch` / `-Seq` headers (additive).
- The store holds data in memory only; the IndexedDB tier of PRF-026 is unchanged and still open.

## Alternatives considered

| Alternative | Why not |
|---|---|
| One request of the window ± 1 | Triples the first paint's points |
| 1 024-step buckets | 2.7× over-fetch on a typical window |
| Per-bucket TanStack queries | No shared cap, no cross-panel sharing of one request |
| Stitching in the render worker | A time join in Rust; a follow-up if the stitch bench breaches |
| Drop the store on every narrowing before any further read | Needs a push channel the BFF does not have; the lease bounds the window instead |
