# Log stream: buffer, pager and `LogStream`

The client side of a LogQL log query's lines (issue #66 Part B): `src/logs/` holds the in-memory
log buffer, the cursor pager over `Api.queryLogs`, the virtualised list `LogStream` with its
severity gutter, wrap and order controls, and the hooks a page mounts it with. The Logs page that
mounts it (query, volume and stream cards, URL keys) is #66 Part C; in Part B the stream is
reachable on the dev-only harness `/t/:tenant/dev/log-stream` only.

The BFF side (the pager, the `(ts, skip)` cursor and its binding) is in
[PulsusDB client: Cursor](../server/pulsusdb.md); the decoder `decodeLogs` and `LogFrame` are in
[Client application: Decoding frames](README.md#decoding-frames-datadecodets).

## Using it from a page

```tsx
import { LogStream, useLogPager, type LogPagerInput } from '../logs';

const input: LogPagerInput | null = ran ? {
  tenant, query: rawText, vars, fromMs, toMs, widthPx, direction: 'backward',
} : null;
const pager = useLogPager(input);           // a started pager per input key; null → null
return pager === null ? null : (
  <LogStream
    pager={pager}
    label={t('…')}                            // the list's accessible name
    wrap={wrap} onWrapChange={setWrap}
    onDirectionChange={setDirection}           // a new direction is a new run (a new input)
    onRerun={rerun}                            // "Run again" after drift: make a new input
  />
);
```

- `useLogPager(input, api?)` keeps one live pager per `logPagerKey(input)` (every member; `vars`
  sorted by name). An equal input object keeps the pager; another key, or unmount, disposes it (its
  requests abort) and starts a new one. It is created in an effect, so StrictMode's second mount
  leaves one live pager. `api` defaults to `useApi()`.
- `useLogPagerState(pager)` is `useSyncExternalStore(pager.subscribe, pager.getState)`.
- `LogStream` renders nothing for a metric result (`phase: 'series'`); the caller draws
  `state.series`. The caller sizes the root (`height: 100%` inside a sized box).
- The handle (`ref`) has `scrollToOrd(ord)`: clamped to the held range, re-slices around `ord` and
  aligns it to the top.

## `LogBuffer` (`logs/logBuffer.ts`)

A run's lines are held as **whole pages**, as the decoder hands them over: per page the frame's
`tsNs` (`BigInt64Array`), `levels` (`Uint8Array`), `streamIndex` (`Uint32Array`), `lines` and
`streams`, by reference, plus per row the wrap measures. `metadata` and `parsed` are not kept.

| Topic | Rule |
|---|---|
| Ordinals | every entry has an ordinal, its position in the run's page order; it never changes. `firstOrd`/`endOrd` are the held range; `rowAt(ord)` is O(log pages) |
| Caps | `MAX_ENTRIES` 10⁶ entries **and** `MAX_TEXT_UNITS` 2²⁷ UTF-16 code units of line text (about 256 MiB); both can be narrowed with `caps` |
| Eviction | while over a cap and more than one page is held, the page at the **far end** (the head after an append, the tail after a prepend) is dropped, unless its ordinals intersect the range the view protects (`protect`): then eviction stops and the buffer stays over the cap until the view moves. The page just added is never dropped |
| Cursor chain | for every page ever accepted: its first ordinal, count, content fingerprint and the cursor it returned (the request cursor of the next page). Kept after eviction (about 100 bytes per page: 10⁸ lines paged cost about 10 MB) |
| Re-fetch | an evicted page is requested again with its chain cursor; the answer must have the recorded count, the recorded returned cursor **and** the recorded fingerprint, else it is **drift**: nothing changes |
| Fingerprint | `pageFingerprint(frame)`: 16 hex digits, two 32-bit lanes over the UTF-16 units of `${tsNs}\0${stream key}\0${level}\0${line}\1` of every row in order. A change in `metadata` or `parsed` alone is not shown, so it is not drift |
| Wrap measures | per row `wrapUnits` (tab 8, code point ≥ U+1100 2, LF 0, else 1) and `breaks` (LF count), in the fingerprint's pass. `wrapLines(row, perLine)` = min(100, ⌈2 × units / perLine⌉ + 1 + breaks), an upper bound of a wrapped row's lines |

`accept(k, page, protect)` returns `first` (page 0 into an empty buffer), `appended` (the next new
page, or a matching re-fetch at the tail), `prepended` (a matching re-fetch before the head),
`drift`, or `stale` (any other page index: an answer the buffer has moved past).

## `LogPager` (`logs/logPager.ts`)

| Topic | Rule |
|---|---|
| Request | `queryLogs(tenant, {query, fromMs, toMs, widthPx, limit, direction, cursor?, timeoutMs?, vars?})`: the raw text and `vars` (ADR-0021 §2: nothing is planned in the browser), the same members on every page of the run; `limit` is `PAGE_LIMIT` 1 000 unless the input sets 1…5 000; `cursor` is absent on page 0 |
| Fixed per run | window `(fromMs, toMs]`, width, direction and limit. The BFF binds the cursor to the planned query, direction, `from` and `to`; a `$__interval` in the text makes another width another query, so the width is fixed too. Another value is another pager |
| Ends | at most one request in flight per end: the tail loads page `tailPage` with `cursorOf(tailPage)`, the head loads page `headPage − 1`. Both ends may load at once; a repeated call joins the pending promise |
| Phases | `pending` → page 0 answers `streams` → `streams`, or a metric result → `series` (no further requests), or an error → `failed` (`retry('tail')` requests page 0 again) |
| End states | `idle`, `loading`, `error` (the rejection is kept; `retry(end)`), `drift` (no further loads at that end; the caller offers Run again). An `AbortError` is never an error. A later page that answers a metric result is `ApiError('badResponse')` at that end |
| Completeness | page 0's, then for each new page `truncated` is OR-ed and `warnings`/`infos` are unioned in first-seen order; `queryId`, `dataAgeMs` and the read-cache fields stay page 0's. Re-fetched pages do not merge. `planned` is page 0's |
| Cancellation | `dispose()` aborts both ends; later answers change nothing and notify no one |
| Errors | no automatic retry; every rejection other than an abort is kept on its end and shown with Retry (`cursor.mismatch` and `cursor.invalid` too, which cannot happen while the input is fixed) |

**Ties are the server's.** The BFF delivers whole timestamp groups and a `(ts, skip)` cursor inside a
group, so the client concatenates pages in arrival order and never sorts, merges or deduplicates
across them. Every entry is delivered exactly once while fewer than 5 000 entries share one
nanosecond and the data does not change (the documented limit of #65).

## `LogStream` (`logs/LogStream.tsx`)

A DOM list (ADR-0007: no charting library; ADR-0014 §2: main thread) virtualised by
`@tanstack/react-virtual` over a **slice** of the buffer.

### Slice and anchoring (`logs/slice.ts`)

| Topic | Rule |
|---|---|
| Bounds | `DEFAULT_VIEW`: at most `cap` 200 000 rows (plus `margin` 20 000 while scrolling) and `maxPx` 8 × 10⁶ px at rest, `hardPx` 12 × 10⁶ px always, so the virtualiser holds at most ~220 000 offsets and the list stays below Firefox's element height limit (about 17.9 × 10⁶ px) |
| Growth | after each change, the slice end grows towards the buffer end (`growSlice`): to `start + cap + margin` while scrolling, to `start + cap` at rest |
| At rest | no wheel or touch scrolling (the virtualiser's `isScrolling`, 150 ms after the last scroll) and no touch down. Only then the slice moves, when the viewport comes within `marginOf` (at most a quarter of the slice) of a slice edge, the slice holds ordinals no longer held, is over `cap`, or its measured extent is over `maxPx` |
| Re-slice | the anchor (the first row at the top and `scrollTop` minus its start: `anchorOf`), the slice around it (`sliceAround`: rows added below and above alternately within `cap` and `maxPx`), and after the commit `scrollTop` = the anchor row's start + its offset (`restoreOffset`). A re-slice that would change nothing writes nothing, so a still viewport never re-slices twice. With wrap, the anchor is re-applied while rows measure, for at most 10 frames, stopping at once on a wheel, touch, key or pointer press |
| While scrolling | nothing writes `scrollTop`, so no write lands in a wheel or touch fling; rows evicted meanwhile show as empty placeholders of their last known height (measured, or the estimate made while the row was held) until the next re-slice, so nothing below them moves. The one exception is a measured extent over `hardPx` (rows measured taller than estimated), re-sliced at once |
| After a write | a `scrollTop` write is seen by the virtualiser only with its scroll event; until then no re-slice, load or protection is decided from its rows, and the anchor's rows (one viewport from the anchor ± `OVERSCAN`) are what the buffer protects |
| New pager, wrap change, `scrollToOrd` | a new pager starts at its first row (`scrollTop` 0); a wrap change and `scrollToOrd` re-slice with the anchor of what is shown, or of the ordinal asked for |

### Loading near the ends

After each change the view protects the shown rows (± `OVERSCAN` 10) from eviction, and requests
the next page when the tail sentinel is in the slice and the last visible row is within
`PREFETCH_ROWS` 2 000 of the buffer end, or the page before the head when the head sentinel is in
the slice and the first visible row is within 2 000 of the buffer start. The reader's last scroll
direction gates the two ends. It comes from the change of `scrollTop` in each scroll event that no
programmatic write made (LogStream's restore writes and the virtualiser's measurement corrections
are recorded and skipped), so a scrollbar drag counts; and from wheel, key (arrow, Page, Home, End,
Space) and touch input, which also count at an edge, where nothing scrolls. `scrollToOrd` counts as
a move towards the ordinal. The direction is state, so a change runs the load decision even
without a scroll event. The tail loads unless the reader last moved up; the head (an evicted page)
loads only after the reader moved up. Without this, a buffer narrower than both prefetch zones (a
small cap, or very long lines filling the text cap) would load a page at one end, evict the other end's page, and load it back, without end.

### Rows

| Topic | Rule |
|---|---|
| Height | without wrap every row is `size.log-row` (20 px) and never measured, so the extent is exact; with wrap rows are measured (border box, at least one line), estimated by `wrapLines` at `perLine` = ⌊line width / (`font.size.sm` × `font.advance.mono`)⌋ columns (line width: the first mounted line, before any the scroller − 240 px). A wrapped line shows at most 100 lines (2 000 px) and scrolls inside its row beyond that |
| Gutter | a bar in the level's colour (`--level-<level>`), a three-letter glyph (`CRT ERR WRN INF DBG TRC UNK`, `aria-hidden`) and the level name for screen readers (VIZ-067: never colour alone). In forced colours the bar is `CanvasText`; the glyph still names the level (T08-019) |
| Timestamp | `formatLogTime(ms, tz)`: `2026-01-01 00:58:20.000` in the browser's zone (`useTimeZone()`), milliseconds truncated from the nanosecond timestamp |
| Line | a text node in JetBrains Mono (`--font-mono`); never parsed as HTML |
| Placement | each row's `translateY` and the list's height are set through CSSOM in layout effects (T08-023) |
| Screen readers | the scroller is a named `region` and a tab stop; the list is a named `list`; each row is a `listitem` with `aria-posinset` (ordinal + 1) and `aria-setsize` (the total once known, else −1). The arrow, Page, Home and End keys scroll natively |

### Sentinels

| Where | State | Shows |
|---|---|---|
| tail | page 0 pending | Loading log lines… |
| tail | page 0 failed, or the tail failed | Could not load log lines. + Retry |
| tail | loading | Loading more lines… |
| tail | drift | These lines changed since they were loaded. + Run again (`onRerun`) |
| tail | at the end | No log lines in this time range (0 entries), else End of results |
| tail | otherwise | Load more lines |
| head (an evicted head) | loading / failed / drift / idle | Loading earlier lines… / Could not load log lines. + Retry / the drift notice + Run again / Load earlier lines |

### Tokens

`design/tokens.toml` holds `level-critical`, `level-error`, `level-warn`, `level-info`,
`level-debug`, `level-trace` and `level-unknown` in both themes: each is the hue of VL-002 Table
8-1a in that theme (`critical` shares `error`'s and is told apart by its glyph and name), never a
state colour (VL-003); and `size.log-row` (20), `size.log-sentinel` (40), `size.log-level-bar` (3).

## The harness and its gates

`/t/:tenant/dev/log-stream` (development and stub builds only) mounts `LogStream` over
`createSynthLogApi` (`src/dev/logSynth.ts`), which answers exactly as the BFF's pager does for the
same data, `limit` and direction (whole groups, a split group continued by `(ts, skip)`, one
nanosecond past a group), without JSON; the shared fixture `wire/fixtures/json/logql-paging.json`
is passed by both (`unit:log-synth`, `TestPagingFixture`). A test sets
`window.__logStreamBenchConfig` (`total`, `prefillTo`, `capEntries`, `latencyMs`, `view`, `wrap`,
`lineLength`, `wrapEstimate`) before the page loads; the default holds 10⁶ of 2 × 10⁶ entries with
50 ms page latency after the prefill. The stream is rendered once the prefill is done, when the
page sets `data-prefilled="true"` and exposes `window.__logStreamBench` (`scrollToOrd`, `loadTail`, `state()`, `topRow()`,
`reslicesLog()`, `showControl(on)`).

- `e2e:log-stream` (`e2e/log-stream.spec.ts`, Chromium, Firefox and WebKit; E6 Chromium only): the
  top row keeps its ordinal and offset across far-end eviction and re-slicing with fixed and
  wrapped rows (wheel) and touch (no `scrollTop` write during the gesture); the last of 10⁶ held
  rows is reachable; a wrapped slice stays within 8 × 10⁶ px with rows of at most 2 000 px and does
  not re-slice at rest; rows taller than estimated (40 000-character lines at a pinned 1 440 × 900
  viewport) are re-sliced back within the bound, at rest and while scrolling; wrapping keeps the
  top row.
- `bench:log-scroll` (`e2e/perf-log-scroll.spec.ts`, Chromium): see
  [Build, test and CI](../development/build-and-ci.md#end-to-end-tests).

## Limits

- The scrollbar covers the slice, not the whole buffer: its thumb jumps at a re-slice, and a fling
  stops at the slice's end (at most once per 200 000 rows); what is shown does not move (Q-B1).
- A re-fetched page that changed is never spliced in: the stream shows the drift notice and Run
  again (Q-B2).
- Over 5 000 entries at one nanosecond the BFF can repeat or skip entries at a page boundary (#65).
- A wrapped line longer than 100 lines scrolls inside its row; keyboard users read such a line with
  wrap off.
- No line expand (metadata and parsed fields), live tail, minimap, JSON prettify, dedupe or context
  lines (M-UI2); no GPU text (#69).

## Design references

[05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md) (VIZ-034 subset,
VIZ-067), [09 Performance contract](../../designs/product/09-performance-contract.md) (PRF-001,
PRF-003, PRF-004, PRF-005, PRF-020), [08 Visual language](../../designs/product/08-visual-language.md)
(VL-002 Table 8-1a, VL-003), [T08](../../designs/technical/T08-dom-component-kit.md) (T08-007,
T08-019, T08-022, T08-023, T08-027), [T05](../../designs/technical/T05-testing-and-performance.md)
§7.1 (the gates), [ADR-0007](../../designs/adr/0007-in-house-vis-engine.md),
[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §2 and §7,
[ADR-0015](../../designs/adr/0015-go-bff.md),
[ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md) §2.
