// unit:log-pager (plan #66 Part B §5.2).
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/types';
import type { LogsRequest } from '../api/types';
import { createSynthLogApi, synthCursor, type SynthEntry } from '../dev/logSynth';
import { logFrame, pageRows, seriesResult, streamsResult } from '../test/logFrames';
import { mulberry32 } from '../test/random';
import { scriptedLogsApi } from '../test/scriptedLogsApi';
import fixtureRaw from '../../../wire/fixtures/json/logql-paging.json?raw';
import type { LogRow } from './logBuffer';
import { LogPager, logPagerKey, type LogPagerInput } from './logPager';

const input: LogPagerInput = {
  tenant: 'demo',
  query: '{app="x"} |= "$v"',
  vars: { v: '1' },
  fromMs: 1767225600000,
  toMs: 1767229200000,
  widthPx: 800,
  direction: 'backward',
};

const P1_REQ: LogsRequest = {
  query: '{app="x"} |= "$v"',
  fromMs: 1767225600000,
  toMs: 1767229200000,
  widthPx: 800,
  limit: 1000,
  direction: 'backward',
  vars: { v: '1' },
};

const rows = (k: number, n: number, cursor: string | null) =>
  streamsResult(logFrame(pageRows(k, n)), cursor);

/** P4: caps {entries: 2}, pages of 2 rows; pages 0 and 1 accepted (page 0 evicted). */
async function p4() {
  const api = scriptedLogsApi();
  const pager = new LogPager(api, input, { entries: 2 });
  void pager.start();
  await api.resolve(0, rows(0, 2, 'k1'));
  void pager.loadTail();
  await api.resolve(1, rows(1, 2, 'k2'));
  expect(pager.buffer.headPage).toBe(1);
  return { api, pager };
}

/** Every held row, by ordinal. */
function held(pager: LogPager): LogRow[] {
  const out: LogRow[] = [];
  for (let o = pager.buffer.firstOrd; o < pager.buffer.endOrd; o += 1) {
    const r = pager.buffer.rowAt(o);
    if (r === null) throw new Error(`no row ${String(o)}`);
    out.push(r);
  }
  return out;
}

interface FixtureCase {
  name: string;
  direction: 'backward' | 'forward';
  limit: number;
  entries: { off: number; stream: string; line: string }[];
}
interface Fixture {
  t0: string;
  streams: Record<string, Record<string, string>>;
  cases: FixtureCase[];
}
const FIXTURE = JSON.parse(fixtureRaw) as Fixture;

function fixtureEntries(name: string): {
  entries: SynthEntry[];
  entry: (off: number, line: string) => SynthEntry;
} {
  const c = FIXTURE.cases.find((x) => x.name === name);
  if (c === undefined) throw new Error(name);
  const t0 = BigInt(FIXTURE.t0);
  const entry = (off: number, line: string, stream = 'S1'): SynthEntry => ({
    tsNs: t0 + BigInt(off),
    labels: FIXTURE.streams[stream] ?? {},
    line,
  });
  return { entries: c.entries.map((e) => entry(e.off, e.line, e.stream)), entry };
}

describe('unit:log-pager', () => {
  it('P1 first request', () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.tenant).toBe('demo');
    expect(api.calls[0]?.req).toStrictEqual(P1_REQ);
  });

  it('P2 next page', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    const page0 = rows(0, 3, 'c'.repeat(48));
    await api.resolve(0, page0);
    void pager.loadTail();
    expect(api.calls[1]?.req).toStrictEqual({ ...P1_REQ, cursor: 'c'.repeat(48) });
    expect(pager.getState().phase).toBe('streams');
    expect(pager.getState().planned).toEqual(page0.planned);
  });

  it('P3 one per end', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    await api.resolve(0, rows(0, 3, 'c1'));
    const settled = vi.fn();
    const a = pager.loadTail().then(settled);
    const b = pager.loadTail().then(settled);
    expect(api.calls).toHaveLength(2);
    expect(settled).not.toHaveBeenCalled();
    await api.resolve(1, rows(1, 3, 'c2'));
    await Promise.all([a, b]);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(api.calls).toHaveLength(2);
  });

  it('P4 both ends', async () => {
    const { api, pager } = await p4();
    void pager.loadHead();
    void pager.loadTail();
    expect(api.calls).toHaveLength(4);
    expect(api.calls[2]?.req).not.toHaveProperty('cursor');
    expect(api.calls[3]?.req.cursor).toBe('k2');
    expect(pager.getState().head.status).toBe('loading');
    expect(pager.getState().tail.status).toBe('loading');
  });

  it('P5 dispose', async () => {
    const { api, pager } = await p4();
    void pager.loadHead();
    void pager.loadTail();
    const listener = vi.fn();
    pager.subscribe(listener);
    pager.dispose();
    expect(api.calls[2]?.signal?.aborted).toBe(true);
    expect(api.calls[3]?.signal?.aborted).toBe(true);
    const version = pager.getState().version;
    await api.resolve(2, rows(0, 2, 'k1'));
    await api.resolve(3, rows(2, 2, null));
    expect(listener).not.toHaveBeenCalled();
    expect(pager.getState().version).toBe(version);
  });

  it('P6 metric', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    const s = seriesResult();
    await api.resolve(0, s);
    expect(pager.getState().phase).toBe('series');
    expect(pager.getState().series).toBe(s);
    await pager.loadTail();
    expect(api.calls).toHaveLength(1);
  });

  it('P7 error and retry', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    await api.resolve(0, rows(0, 3, 'c1'));
    void pager.loadTail();
    const err = new ApiError('timeout', 'timed out');
    await api.reject(1, err);
    expect(pager.getState().tail).toEqual({ status: 'error', error: err });
    void pager.retry('tail');
    expect(api.calls).toHaveLength(3);
    expect(api.calls[2]?.req.cursor).toBe('c1');
  });

  it('P8 first page fails', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    await api.reject(0, new ApiError('queryInvalid', 'bad'));
    expect(pager.getState().phase).toBe('failed');
    void pager.retry('tail');
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.req).not.toHaveProperty('cursor');
    expect(pager.getState().phase).toBe('pending');
  });

  it('P9 end', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    await api.resolve(0, rows(0, 3, null));
    expect(pager.getState().atEnd).toBe(true);
    expect(pager.getState().total).toBe(3);
    await pager.loadTail();
    expect(api.calls).toHaveLength(1);
  });

  it('P10 drift', async () => {
    const { api, pager } = await p4();
    const before = held(pager);
    void pager.loadHead();
    await api.resolve(2, rows(0, 1, 'k1'));
    expect(pager.getState().head.status).toBe('drift');
    await pager.loadHead();
    expect(api.calls).toHaveLength(3);
    expect(held(pager)).toEqual(before);
  });

  it('P11 completeness', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    await api.resolve(
      0,
      streamsResult(logFrame(pageRows(0, 1)), 'c1', { warnings: ['w1'], queryId: 'q0' }),
    );
    void pager.loadTail();
    await api.resolve(
      1,
      streamsResult(logFrame(pageRows(1, 1)), null, {
        truncated: true,
        warnings: ['w1', 'w2'],
        infos: ['i'],
        queryId: 'q1',
      }),
    );
    expect(pager.getState().completeness).toMatchObject({
      truncated: true,
      warnings: ['w1', 'w2'],
      infos: ['i'],
      queryId: 'q0',
    });
  });

  it('P12 later metric', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    await api.resolve(0, rows(0, 3, 'c1'));
    void pager.loadTail();
    await api.resolve(1, seriesResult());
    const tail = pager.getState().tail;
    expect(tail.status).toBe('error');
    expect(tail.error).toBeInstanceOf(ApiError);
    expect((tail.error as ApiError).kind).toBe('badResponse');
  });

  it('P13 stale head', async () => {
    const { api, pager } = await p4();
    void pager.loadHead();
    void pager.loadTail();
    await api.resolve(3, rows(2, 2, 'k3'));
    expect(pager.buffer.headPage).toBe(2);
    expect(pager.buffer.tailPage).toBe(3);
    await api.resolve(2, rows(0, 2, 'k1'));
    expect(pager.getState().head.status).toBe('idle');
    expect(pager.buffer.headPage).toBe(2);
    expect(pager.buffer.tailPage).toBe(3);
  });

  it('P14 abort without dispose', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    await api.resolve(0, rows(0, 3, 'c1'));
    void pager.loadTail();
    await api.reject(1, new DOMException('x', 'AbortError'));
    expect(pager.getState().tail).toEqual({ status: 'idle', error: null });
  });

  it('P15 and P16 exactly once and re-fetch equals (property, 300 cases)', async () => {
    const rnd = mulberry32(66_002);
    for (let c = 0; c < 300; c += 1) {
      const total = Math.floor(rnd() * 401);
      const sizes = Array.from({ length: total + 1 }, () => 1 + Math.floor(rnd() * 12));
      const limit = 1 + Math.floor(rnd() * 10);
      const direction = rnd() < 0.5 ? 'backward' : 'forward';
      const what = `case ${String(c)}: total ${String(total)}, limit ${String(limit)}, ${direction}`;
      const synth = createSynthLogApi({ total, groupOf: (g) => sizes[g % sizes.length] ?? 1 });
      const run: LogPagerInput = { ...input, direction, limit };
      // The whole window in one answer: the synth's entries in page order.
      const all = await synth.queryLogs('demo', {
        query: run.query,
        fromMs: run.fromMs,
        toMs: run.toMs,
        widthPx: run.widthPx,
        limit: 5000,
        direction,
      });
      if (all.kind !== 'streams') throw new Error('series');
      const want = all.frame.lines;
      expect(new Set(want).size, what).toBe(total);

      // P15: no cap.
      const pager = new LogPager(synth, run);
      await pager.start();
      while (!pager.getState().atEnd) {
        const before = synth.calls.length;
        await pager.loadTail();
        if (synth.calls.length === before) throw new Error(`${what}: no progress`);
      }
      expect(
        held(pager).map((r) => r.line),
        what,
      ).toEqual(want);
      expect(pager.buffer.total, what).toBe(total);

      // P16: caps {entries: 25}, then back to the start.
      const capped = new LogPager(synth, run, { entries: 25 });
      await capped.start();
      const seen = new Map<number, LogRow>();
      const record = () => {
        for (const r of held(capped)) if (!seen.has(r.ord)) seen.set(r.ord, r);
      };
      record();
      while (!capped.getState().atEnd) {
        await capped.loadTail();
        record();
      }
      while (!capped.getState().atStart) {
        await capped.loadHead();
        expect(capped.getState().head.status, what).not.toBe('drift');
        for (const r of held(capped)) expect(r, what).toEqual(seen.get(r.ord));
      }
      expect(capped.getState().tail.status, what).not.toBe('drift');
    }
    // Every call of a run carries the same members (checked on the last synth's calls).
    const calls = createSynthLogApi({ total: 30 });
    const pager = new LogPager(calls, { ...input, limit: 7 });
    await pager.start();
    while (!pager.getState().atEnd) await pager.loadTail();
    expect(calls.calls.length).toBeGreaterThan(1);
    for (const r of calls.calls) {
      const { cursor: _cursor, ...rest } = r;
      expect(rest).toStrictEqual({ ...P1_REQ, limit: 7 });
    }
  }, 60_000);

  it('P15 no page over limit', async () => {
    const synth = createSynthLogApi({ total: 100, groupOf: (g) => 1 + (g % 5) });
    const pager = new LogPager(synth, { ...input, limit: 3 });
    await pager.start();
    let last = pager.buffer.endOrd;
    expect(last).toBeLessThanOrEqual(3);
    while (!pager.getState().atEnd) {
      await pager.loadTail();
      expect(pager.buffer.endOrd - last).toBeLessThanOrEqual(3);
      last = pager.buffer.endOrd;
    }
    expect(last).toBe(100);
  });

  it('P17 inserted entry', async () => {
    const { entries, entry } = fixtureEntries('F5');
    const synth = createSynthLogApi({ entries });
    const pager = new LogPager(synth, { ...input, limit: 4 }, { entries: 4 });
    await pager.start();
    await pager.loadTail();
    expect(pager.buffer.headPage).toBe(1);
    synth.insert(entry(8, 'b2'));
    await pager.loadHead();
    const t0 = BigInt(FIXTURE.t0);
    const last = synth.calls.length - 1;
    expect(synth.calls[last]?.cursor).toBeUndefined();
    // The re-fetch answered 4 rows and (7, 0), where page 0 had returned (6, 0).
    const again = await synth.queryLogs('demo', { ...P1_REQ, limit: 4 });
    if (again.kind !== 'streams') throw new Error('series');
    expect(again.frame.lines).toHaveLength(4);
    expect(again.cursor).toBe(synthCursor({ tsNs: t0 + 7n, skip: 0 }));
    expect(pager.getState().head.status).toBe('drift');
  });

  it('P19 replaced line', async () => {
    const { entries } = fixtureEntries('F6');
    const synth = createSynthLogApi({ entries });
    const pager = new LogPager(synth, { ...input, limit: 4 }, { entries: 4 });
    await pager.start();
    await pager.loadTail();
    expect(pager.buffer.headPage).toBe(1);
    synth.replace(BigInt(FIXTURE.t0) + 8n, 'c', 'c2');
    await pager.loadHead();
    expect(pager.buffer.cursorOf(1)).toBe(synthCursor({ tsNs: BigInt(FIXTURE.t0) + 6n, skip: 0 }));
    expect(pager.getState().head.status).toBe('drift');
  });

  it('P18 key', () => {
    const a = logPagerKey({ ...input, vars: { b: '2', a: '1' } });
    const b = logPagerKey({ ...input, vars: { a: '1', b: '2' } });
    expect(a).toBe(b);
    expect(logPagerKey({ ...input, toMs: input.toMs + 1 })).not.toBe(logPagerKey(input));
  });
});
