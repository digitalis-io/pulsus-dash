// unit:log-synth (plan #66 Part B, B.1 and B.1.1).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogsRequest } from '../api/types';
import type { LogsResult } from '../data/decode';
import fixtureRaw from '../../../wire/fixtures/json/logql-paging.json?raw';
import { createSynthLogApi, parseSynthCursor, synthCursor, type SynthEntry } from './logSynth';

interface FixtureCursor {
  off: number;
  skip: number;
}
interface FixturePage {
  ids: string[];
  next: FixtureCursor | null;
}
interface FixtureEntry {
  off: number;
  stream: string;
  line: string;
  with?: string;
}
interface FixtureCase {
  name: string;
  direction: 'backward' | 'forward';
  limit: number;
  entries: FixtureEntry[];
  pages: FixturePage[];
  mutate: {
    after_page: number;
    insert?: FixtureEntry;
    replace?: FixtureEntry;
    refetch_page: number;
    page: FixturePage;
  } | null;
}
interface Fixture {
  t0: string;
  window: { from: number; to: number };
  streams: Record<string, Record<string, string>>;
  cases: FixtureCase[];
}

const FIXTURE = JSON.parse(fixtureRaw) as Fixture;
const T0 = BigInt(FIXTURE.t0);

function streamsOf(r: LogsResult): Extract<LogsResult, { kind: 'streams' }> {
  if (r.kind !== 'streams') throw new Error('a metric result');
  return r;
}

/** `<stream>/<line>` of every row, the stream named by the fixture's labels. */
function ids(r: Extract<LogsResult, { kind: 'streams' }>): string[] {
  const f = r.frame;
  return f.lines.map((line, i) => {
    const labels = f.streams[f.streamIndex[i] ?? 0]?.labels ?? {};
    const name = Object.entries(FIXTURE.streams).find(
      ([, l]) => JSON.stringify(l) === JSON.stringify(labels),
    )?.[0];
    return `${name ?? '?'}/${line}`;
  });
}

const cursorOf = (c: FixtureCursor | null) =>
  c === null ? null : { tsNs: T0 + BigInt(c.off), skip: c.skip };
const entryOf = (e: FixtureEntry): SynthEntry => ({
  tsNs: T0 + BigInt(e.off),
  labels: FIXTURE.streams[e.stream] ?? {},
  line: e.line,
});

describe('unit:log-synth', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(FIXTURE.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const synth = createSynthLogApi({ entries: c.entries.map(entryOf) });
    const base: LogsRequest = {
      query: '{app="x"}',
      fromMs: FIXTURE.window.from,
      toMs: FIXTURE.window.to,
      widthPx: 800,
      limit: c.limit,
      direction: c.direction,
    };
    const req = (cursor: string | null): LogsRequest =>
      cursor === null ? base : { ...base, cursor };
    const requested: (string | null)[] = [null];
    for (const [i, p] of c.pages.entries()) {
      const r = streamsOf(await synth.queryLogs('demo', req(requested[i] ?? null)));
      expect(ids(r), `page ${String(i + 1)}`).toEqual(p.ids);
      expect(
        r.cursor === null ? null : parseSynthCursor(r.cursor),
        `next of ${String(i + 1)}`,
      ).toEqual(cursorOf(p.next));
      requested.push(r.cursor);
    }
    const m = c.mutate;
    if (m === null) return;
    expect(m.after_page).toBe(c.pages.length);
    if (m.insert !== undefined) synth.insert(entryOf(m.insert));
    if (m.replace !== undefined) {
      synth.replace(T0 + BigInt(m.replace.off), m.replace.line, m.replace.with ?? '');
    }
    const r = streamsOf(await synth.queryLogs('demo', req(requested[m.refetch_page - 1] ?? null)));
    expect(ids(r)).toEqual(m.page.ids);
    expect(r.cursor === null ? null : parseSynthCursor(r.cursor)).toEqual(cursorOf(m.page.next));
  });

  it('round-trips a cursor', () => {
    const c = { tsNs: 1767229100000000004n, skip: 2 };
    expect(synthCursor(c)).toBe('s:1767229100000000004:2');
    expect(parseSynthCursor(synthCursor(c))).toEqual(c);
  });

  it('S3 order and window', async () => {
    const sizes = [1, 2, 3];
    for (const direction of ['backward', 'forward'] as const) {
      const synth = createSynthLogApi({ total: 50, groupOf: (g) => sizes[g % 3] ?? 1 });
      const base: LogsRequest = {
        query: '{service_name="synth"}',
        fromMs: 1767225600000,
        toMs: 1767229200000,
        widthPx: 800,
        limit: 7,
        direction,
      };
      const lo = 1767225600000n * 1_000_000n;
      const hi = 1767229200000n * 1_000_000n;
      const ts: bigint[] = [];
      let cursor: string | null = null;
      do {
        const r = streamsOf(
          await synth.queryLogs('demo', cursor === null ? base : { ...base, cursor }),
        );
        ts.push(...r.frame.tsNs);
        cursor = r.cursor;
      } while (cursor !== null);
      expect(ts).toHaveLength(50);
      for (const t of ts) {
        expect(t > lo && t <= hi).toBe(true);
      }
      for (let i = 1; i < ts.length; i += 1) {
        const [a, b] = [ts[i - 1] ?? 0n, ts[i] ?? 0n];
        expect(direction === 'backward' ? a >= b : a <= b).toBe(true);
      }
      if (direction === 'forward') expect(ts[0]).toBe(ts.reduce((m, t) => (t < m ? t : m)));
    }
  });

  it('S4 determinism', async () => {
    const synth = createSynthLogApi({ total: 30, groupOf: (g) => 1 + (g % 4) });
    const req: LogsRequest = {
      query: '{service_name="synth"}',
      fromMs: 1767225600000,
      toMs: 1767229200000,
      widthPx: 800,
      limit: 10,
      direction: 'backward',
    };
    const a = streamsOf(await synth.queryLogs('demo', req));
    const b = streamsOf(await synth.queryLogs('demo', req));
    expect(b.frame).toEqual(a.frame);
    expect(b.cursor).toBe(a.cursor);
    expect(synth.calls).toEqual([req, req]);
  });

  it('S5 latency, abort', async () => {
    vi.useFakeTimers();
    const synth = createSynthLogApi({ total: 10, latencyMs: 50 });
    const req: LogsRequest = {
      query: '{service_name="synth"}',
      fromMs: 1767225600000,
      toMs: 1767229200000,
      widthPx: 800,
    };
    const done = vi.fn();
    void synth.queryLogs('demo', req).then(done);
    await vi.advanceTimersByTimeAsync(49);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledTimes(1);

    const ac = new AbortController();
    const p = synth.queryLogs('demo', req, ac.signal);
    const failed = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    const e = await failed;
    expect(e).toBeInstanceOf(DOMException);
    expect((e as DOMException).name).toBe('AbortError');
  });

  it('S6 line length', async () => {
    const synth = createSynthLogApi({ total: 20, lineLength: 400 });
    const r = streamsOf(
      await synth.queryLogs('demo', {
        query: '{service_name="synth"}',
        fromMs: 1767225600000,
        toMs: 1767229200000,
        widthPx: 800,
        limit: 20,
      }),
    );
    expect(r.frame.lines).toHaveLength(20);
    r.frame.lines.forEach((line, i) => {
      expect(line).toHaveLength(400);
      expect(line.startsWith(`synth line ${String(i)} `)).toBe(true);
    });
  });
});
