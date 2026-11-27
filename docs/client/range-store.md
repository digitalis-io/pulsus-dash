# The range store: overscan, pan, zoom and refine (#304)

Board PromQL range panels and Explore's range run read their data from one **range store** per
page instead of one request per window. The store holds data as **buckets** of 256 grid points,
shares them across panels, pans, zooms and refreshes, prefetches one window either side of a line
panel, and fills a zoom from the same query held at other steps, so a pan or a zoom paints in its
first frame. It implements [ADR-0038](../../designs/adr/0038-page-range-store-and-scope-lease.md)
and [ADR-0039](../../designs/adr/0039-data-crossfade-on-the-seam.md); the user's view is in
[Boards](../user/boards.md#zoom-and-pan).

| Module | Role |
|---|---|
| `src/data/buckets.ts` | bucket math: `bucketOf`, `bucketStartMs`, `bucketLastMs`, `runsOf` |
| `src/data/rangeStore.ts` | the store: identities, segments, writes, freshness, assembly, scope and lease, jobs, the ladder and coarse first |
| `src/data/rangeStitch.ts` | stitching segment parts, slicing the visible grid, the completeness merge |
| `src/data/rangeFill.ts` | the rank 0 fill from other steps (Part B) |
| `src/data/rangeScheduler.ts` | the page's one scheduler of board range requests |
| `src/boards/rangeView.ts` | `planRangeView`, `chunkable`, `usesRangeMacro`, `ladderOf`, `coarseStep` |
| `src/boards/panelStore.ts` | the panel run's store helpers: `useStoreRun`, `outcomeOf`, the lease gate |
| `src/app/providers.tsx` | `useRangeStore`; the session's scope epochs into the store, a dropped tenant's queries removed, the lease tick |

## Buckets and identities

Bucket `k` at step `s` covers the grid points `k·256·s … (k·256 + 255)·s`. A PromQL range value at
a grid time depends only on that time and the step, so buckets fetched apart stitch into exactly
what one request returns. A **run** of at most 42 buckets (10 752 points) is one request: `from` is
its first point, `to` its last, and `step_ms` the step, a PromQL ladder entry (`PROM_LADDER_MS`);
the BFF checks it is on the ladder (else 400 `/step_ms`) and plans as before (`promGridAt` mirrors
the server's `PromGridStep`, checked against `wire/fixtures/json/promql-step-at.json`).

An **identity** is `{tenant, scope, text, vars, rate, rangeMs, stepMs}`: the scope epoch (below),
the raw text, the variables the text references, the rate chip, the window the range macros see
(`$__range`, `$__range_s`, `$__range_ms`; null when the text uses none, else the window and sent as
`range_ms`) and the step. Its JSON is the `idKey`. Every step of one query (the identity without
`stepMs`) is a **family**.

`planRangeView` turns a panel's window and width into a **view**: the visible grid (`promGrid` of
the window at the width, today's grid), its visible run, and for a line panel the **flanks**: one
window either side, the left one clamped at bucket 0 and the right one cut after the clock anchor's
bucket (no future buckets).

| Eligible (store-backed) | Not (today's single request, through the scheduler) |
|---|---|
| a PromQL range run of a board panel or Explore | an instant run; a LogQL run |
| `chunkable(text)`: no `@ start()` / `@ end()` | `@ start()` / `@ end()` (the value depends on the request window) |
| no bar chart baseline run | a bar chart with a baseline offset or its ghost |
| not degraded (#147) | a degraded run |
| not bypassed (below) | a bypassed identity |

Flanks and the ladder are for `line` panels (and Explore's chart) only.

## The panel run

The panel's TanStack key is unchanged (`panelRunKey`); the store sits behind it:

| Moment | What happens |
|---|---|
| render | the view; `initialData` = the store's assembly when every visible bucket is held and fresh, so a pan inside held data paints with no request |
| query function | `store.load(owner, view, signal)`: resolves when every visible bucket is held and fresh; a `StoreBypass` falls back to the single request |
| effect | `retain(owner, view)`; cleanup `release(owner)` (deferred a microtask, so a StrictMode replay cancels nothing) |
| store event | the latest assembly goes into the key's data (flanks arriving widen the held span) |
| placeholder | Part B's rank 0 fill when there is one, else the previous window's outcome, but only under the same scope epoch and a valid lease |

The outcome carries `result` (the **visible** slice: the legend, the table, auto-vis and every
non-line consumer), `held` (the held span the line frame draws), `fit` (the visible grid) and
`scope`. A line frame gets the held span with `fit`, so its auto value axis and its summary's min,
max and last describe only the visible window (T02 §4.3 v1 note): data held off screen never moves
the axis. The panel host carries `data-store` (`held`, `bypass` or `off`) and `data-rank`.

## Assembly and presence

The **held span** is the visible run plus the contiguous held flank buckets. When one segment (one
response) is exactly the held span, its series are the frame's by identity (by reference on the MT
engine, ADR-0034); otherwise the parts are stitched by value into one shared `timestamps` array,
each key's `values` NaN-filled and its `absent` mask 1-filled, and each part copied at its offset.

A series a part does not return is **absent** there. Absent points and present `NaN`s both draw as
gaps, never interpolated, but stay distinct: `RangeResult.absent` marks, per series, the points the
BFF sent as `null` (JSON) or as null slots (DSF validity bitmap). The visible slice keeps a series
iff it has a present point in the slice, whatever its values: an all-`NaN` present series stays,
an absent one goes, a series only in a flank is in `held` only. Series keep the order of first
sight (segments ascending in time, each in server order).

`completeness` of the visible slice: `truncated` if any part is; warnings and infos in order,
deduplicated; the query id, data age, read cache and `planned` from the part holding the visible
grid's last point.

## Writes, ordering and freshness

Each job takes a generation number when it starts. A response is stored per bucket only if its
generation, refresh epoch and anchor are all at least the held bucket's; an aborted job's response
is never stored, nor is a response under another scope.

| Bucket `k` of segment `s` | Fresh for view `v` when |
|---|---|
| settled: it ends before `s.anchorMs − 5 min` | `s.epoch === v.epoch` |
| volatile | `s.epoch === v.epoch` and `s.anchorMs === v.anchorMs` |

So pans and zooms reuse everything; a relative-window refresh (the anchor moves) refetches only the
volatile and the new buckets (**live extension**); Refresh now (a new refresh epoch) refetches all.
Held buckets that are not fresh are **stale**: they are still drawn, under a subtle 45° hatch in
the unknown state colour at 12 % (`data-stale-span`, PRF-026, T04-018), until their refetch lands.

## Scope epoch and lease (ADR-0038)

The store holds only data this session already received from the BFF under a scope check; the BFF
is the only boundary. The **scope epoch** is the BFF's hash of the principal, the binding (the
endpoint and the credential reference only as hashes) and the data scope; `scope_seq` orders epochs.
Both come with the bootstrap's tenants and with every range response
(`X-Pulsus-Scope-Epoch`, `X-Pulsus-Scope-Seq`, on errors after tenant resolution too).

| Rule | Behaviour |
|---|---|
| order | an epoch is accepted only with a sequence not below the current one, and never once retired: a stale bootstrap render or a late response is ignored and its data discarded |
| change | a newer epoch drops the tenant: jobs aborted, segments deleted, its `['data', …]` queries removed |
| `scope_denied` | a 403 drops the tenant |
| tenant switch | the board's provider drops the previous tenant |
| lease | every reuse of store data (initial data, a placeholder, a load, a mounted panel's data) needs the current epoch confirmed less than 5 min ago, at the receipt time of a response or of the bootstrap (never a render's time); past it nothing cached is painted: a mounted panel revalidates, and the next load fetches its visible run before any cached paint |

A response without scope headers (the stub, an older BFF) confirms the current epoch.

## The scheduler

Every board range request of the page runs through one scheduler (`useRangeStore().scheduler`):
store jobs, the single requests of bypassed and ineligible panels (`exec`), and LogQL frames and
their volume.

| Rule | Value |
|---|---|
| classes | `interactive` (visible runs, `exec`) > `refine` (Part B's fine pass) > `prefetch` (flanks) > `background` (the ladder); FIFO within a class |
| in flight | at most 6; at most 4 non-interactive |
| reserved slot | while non-interactive work waits and none runs, interactive holds at most 5 |
| preemption | an interactive job finding 6 running with ≥ 2 non-interactive aborts the newest of them and requeues it |
| fetch priority | interactive `high`, refine `auto`, the rest `low` |
| cancellation | `retain` cancels every job with no wanted bucket in the same call (HTTP/2 RST); a newer job for the same run cancels the older; no linger |

## Zoom (Part B)

| Producer | When |
|---|---|
| the **zoom-out ladder** | after a line view's flanks are fresh: 3× and 9× the window about its centre, each at its own `promGrid` step (about one point per pixel), `background`; a level at the view's step or the previous level's is skipped |
| **coarse first** (PRF-027) | a cold line view (nothing held at its step, no fill covering it): a run at `coarseStep` (width / 4) `interactive`, then the fine run `refine` once the view has been unchanged for 120 ms (T07-011); skipped when the coarse step equals the fine one |
| the **fill** | `peekFilled`: missing visible buckets drawn from the family's other steps at their own sample times (never resampled), the step nearest the view's by ratio (a tie to the finer); a span nothing covers is a gap |

A fill is **rank 0** and is the panel's placeholder; the view's own step is **rank 1**. Ranks never
regress: rank 1 is assembled from view-step buckets only. When the rank 1 answer replaces a rank 0
fill of the same key, the line frame's data carries `transition: 'crossfade'`: both engines fade
the series over 150 ms (ADR-0039); under `prefers-reduced-motion: reduce` `ChartFrame` cuts.
Worked numbers at 1 200 px:

| Window | View step | Coarse step | 3× level | 9× level |
|---|---|---|---|---|
| 1 h | 15 s | none (12 s → 15 s) | skipped (15 s) | 30 s |
| 6 h | 15 s | 60 s | 60 s | 120 s |
| 24 h | 60 s | 300 s | 300 s | 600 s |

Zooming out 3× about the centre lands on the 3× level's step and buckets: full resolution, no
request.

## Memory and bypass

| Holder | Bound |
|---|---|
| segments, pinned included | `STORE_BYTES` 128 MiB; LRU over the unpinned (a segment is pinned while a retained view wants one of its buckets) |
| stitched spans of retained views | `ASSEMBLY_BYTES` 64 MiB; flank buckets trimmed outermost first |
| one held span | `HELD_CELLS` 2²¹ series × points |
| responses in flight | at most 6; once an identity's series count is known, flank and ladder runs past `HELD_CELLS` are not requested |

A segment counts `8 × points × (series + 1) + points × series / 8` bytes. A **visible** run over
`HELD_CELLS`, one that still does not fit after evicting every unpinned segment, or a response not
on the grid that was asked for, marks the identity **bypassed**: the panel takes today's single
request (its 500-series cap and notices, `data-store="bypass"`). A flank or ladder run over a bound
is dropped and that identity's flanks stop until its view changes. `createRangeStore({ enabled:
false })` turns the store off (every run takes the single request); the unit suites of the
single-request path use it.

## Gates

`unit:range-store` (`src/data/*.test.ts`, `src/boards/rangeView.test.ts`,
`src/boards/usePanelRun.test.tsx`, the Explore case), `e2e:board-overscan` (O1–O6), the Go halves
(`TestPromGridStep`, `TestRangeStepMs`, `TestRangeScopeHeaders`, `TestScopeEpoch`,
`itest:scope-seq`) and the report-only `bench:range-stitch`
(`BENCH=1 npx vitest run src/data/rangeStore.bench.test.ts`).

## Design references

- [ADR-0038](../../designs/adr/0038-page-range-store-and-scope-lease.md),
  [ADR-0039](../../designs/adr/0039-data-crossfade-on-the-seam.md)
- [T04](../../designs/technical/T04-wire-format-and-data-plane.md) §6.1 (the memory tier), §4.4,
  §5.2, §5.4 v1 notes; T04-017, T04-018
- [T07](../../designs/technical/T07-scene-query-planner.md) T07-012 v1, §4.6 v1 note
- [T02](../../designs/technical/T02-vis-engine.md) §4.3 v1 note, T02-007
- [09](../../designs/product/09-performance-contract.md) PRF-026, PRF-027, PRF-028, PRF-030
