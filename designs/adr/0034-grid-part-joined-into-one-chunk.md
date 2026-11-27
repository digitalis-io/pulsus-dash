# ADR-0034: A streamed grid part's batch chunks are joined into one chunk; the MT engine's DSF memory contract; amends T04-015

| | |
|---|---|
| **Status** | Accepted (2026-11-27, on merge of #68 Part D2, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [T04](../technical/T04-wire-format-and-data-plane.md) T04-015 (its copy count: one more exact-size copy, the join, on the pool). The decode copy, nothing pinned and the GPU copy are unchanged |
| **Source** | Issue #68 Part D2 (range data reaches the engine as DSF, decoded off the main thread) |
| **See** | [T04](../technical/T04-wire-format-and-data-plane.md) T04-006, T04-010, T04-015, §5.7; [T02](../technical/T02-vis-engine.md) T02-002; [T03](../technical/T03-browser-runtime.md) §5.2, §6, §9.2; [ADR-0005](0005-arrow-wire-format.md), [ADR-0030](0030-engine-camera-controller-on-main.md) |

## Context

The BFF streams a range result as one `labels/1` + `metric_matrix.grid/1` part pair whose grid
batches arrive one after another (T04 §4.4: the first batch holds one series, so the first line is
drawn early). The engine's decoder turns each batch into a chunk of its own: the series count of a
part is not known before the part has streamed (T04-006), so the decoder cannot size one buffer for
the whole part.

A frame draws one chunk (T02-002): one draw per viewport, and every hover, pick and selection rule
is written against one chunk's series. Drawing one chunk per batch would spread those rules across
chunks. The batches must become one chunk before a frame takes them.

T04-015 allows one decode copy of the values (network slab → chunk) and one into GPU memory.
Joining the batches is one more copy.

The engine decodes DSF in the MT build only. The ST build has no pool, and a decode on its render
thread would need to be resumable and time-sliced to keep frames on time (#281).

## Decision

1. **One chunk per grid part.** When a part ends, the pool joins its batch chunks, in arrival order,
   into one chunk with the same series order and grid (`dash-wire` `join_grid`). The values and the
   validity are copied once into exact-size buffers, sized with checked arithmetic before anything
   is allocated; a size that overflows, or exceeds 2³¹ samples, fails the decode as a limit. A part
   of exactly one batch is reused without a copy. The batch chunks are dropped after the join.
2. **The copy count.** T04-015 becomes: the values are copied once from the network buffer into
   the batch chunks, once more by the join (on the pool, only for a part of two or more batches),
   and once into GPU memory.
3. **The memory contract** of the MT engine's DSF path, and the only claim made about its memory:

   | Memory | Bound |
   |---|---|
   | In flight | per decode, the B3 wire limits the decoder enforces (`wire/schemas/limits.json`: a frame payload of at most 64 MiB, a grid of at most 2²² points, the body and value budgets), × at most 2 decodes in flight per worker. A body over a limit fails the decode and is retried once as JSON |
   | Completed | the worker's chunks that no frame holds, capped at 256 MiB with least-recently-used eviction, enforced whenever a chunk is added or a frame lets one go; plus the main thread's arrays of each result, held by the query cache. A result no array will hold (refused on main, or arriving for an aborted request) is released at once |

   The main thread pauses reading a body while 8 MiB or more of it is posted and not yet consumed;
   this is a pause threshold, not a cap. It never posts a read over B3's `max_chunk` (128 MiB): it
   cancels the reader and retries the request once as JSON.
4. **MT only.** DSF is asked for only while an MT engine runs (status 1 or 2). ST, Canvas 2D and the
   queries before the first boot use JSON. A resumable, bounded ST decode is #281.

## Consequences

- `unit:join-grid` proves the join bit-equal to the batches, the single batch reused, and an
  overflowing size refused before any allocation.
- The safeguards of the memory contract are each tested: the two-in-flight limit (a third decode is
  `busy` and goes as JSON), the B3 rejections, the release of a request's queue, decoder and chunks on
  an abort or a failure, and the LRU table (`decode_service`, `limit_fallback`, `chunk_ids`,
  `chunk_table`; `query range dsf` for the main thread's pause and its refusal of an oversized read).
- `bench:decode-r1` reports the decode and the join of the `many` route fixture in MT.
- Each result is held twice while it is shown: the engine's chunk and the main thread's typed
  arrays (the tooltips, the Inspector and the reducers read the latter). The chunk table's cap bounds
  only the first.
