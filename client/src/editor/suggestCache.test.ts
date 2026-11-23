import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { flush } from '../test/viewIn';
import {
  SuggestCache,
  suggestKey,
  windowBucket,
  type SuggestKeyParts,
  type SuggestKind,
} from './suggestCache';

// B.4.3 of plan #63 Part B.
let t = 0;
let unhandled: Mock;
beforeEach(() => {
  t = 0;
  unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
});
afterEach(async () => {
  await flush();
  process.off('unhandledRejection', unhandled);
  expect(unhandled).not.toHaveBeenCalled();
});

const P = (i: number, kind: SuggestKind = 'names'): SuggestKeyParts => ({
  tenant: 'demo',
  lang: 'promql',
  kind,
  label: null,
  selector: `k${String(i)}`,
  bucket: 0,
});
const Pa = (i: number, kind?: SuggestKind) => ({ ...P(i, kind), tenant: 'a' });
const Pb = (i: number, kind?: SuggestKind) => ({ ...P(i, kind), tenant: 'b' });

const abortError = () => new DOMException('Aborted', 'AbortError');

interface Pending<T> {
  readonly signal: AbortSignal;
  readonly resolve: (v: T) => void;
  readonly reject: (x: unknown) => void;
}

/** A load that settles only when the test settles it; `deaf` ignores its signal. */
function controlled<T>(deaf = false) {
  const calls: Pending<T>[] = [];
  const load = vi.fn(
    (signal: AbortSignal) =>
      new Promise<T>((resolve, reject) => {
        calls.push({ signal, resolve, reject });
        if (!deaf)
          signal.addEventListener('abort', () => {
            reject(abortError());
          });
      }),
  );
  const at = (i: number): Pending<T> => {
    const c = calls[i];
    if (c === undefined) throw new Error(`no call ${String(i)}`);
    return c;
  };
  return { load, calls, at };
}

/** Loads that resolve at once; `count` is the number of calls made. */
function resolving() {
  const count = vi.fn();
  const of =
    <T>(v: T) =>
    (signal: AbortSignal) => {
      count(signal);
      return Promise.resolve(v);
    };
  return { count, of };
}

function nameOf(p: Promise<unknown>): { readonly got: string | undefined } {
  const box: { got: string | undefined } = { got: undefined };
  p.catch((e: unknown) => {
    box.got = (e as { name?: string }).name;
  });
  return box;
}

const make = (maxKeys?: number) =>
  new SuggestCache(maxKeys === undefined ? { now: () => t } : { now: () => t, maxKeys });

describe('unit:suggest-cache', () => {
  it('C1: holds at most 2 000 keys', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const r = resolving();
    for (let i = 0; i <= 2000; i++) await c.get(g, P(i), r.of(i));
    expect(c.size).toBe(2000);
    expect(c.has(P(0))).toBe(false);
    await c.get(g, P(0), r.of(0));
    expect(r.count).toHaveBeenCalledTimes(2002);
    await c.get(g, P(2000), r.of(2000));
    expect(r.count).toHaveBeenCalledTimes(2002);
  });

  it('C2: a hit makes the key the most recent', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const r = resolving();
    for (let i = 0; i < 2000; i++) await c.get(g, P(i), r.of(i));
    await c.get(g, P(0), r.of(0));
    await c.get(g, P(2000), r.of(2000));
    expect(c.has(P(1))).toBe(false);
    expect(c.has(P(0))).toBe(true);
    expect(r.count).toHaveBeenCalledTimes(2001);
  });

  it('C3: 60 s TTL from settle', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const r = resolving();
    await c.get(g, P(0), r.of(0));
    t = 59_999;
    await c.get(g, P(0), r.of(0));
    expect(r.count).toHaveBeenCalledTimes(1);
    t = 60_000;
    await c.get(g, P(0), r.of(0));
    expect(r.count).toHaveBeenCalledTimes(2);
  });

  it('C4: shares the in-flight promise', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    const p1 = c.get(g, P(0), h.load);
    const p2 = c.get(g, P(0), h.load);
    expect(p1).toBe(p2);
    expect(h.load).toHaveBeenCalledTimes(1);
    h.at(0).resolve(5);
    expect(await p1).toBe(5);
    expect(await p2).toBe(5);
  });

  it('a hit on an in-flight lookup makes it the most recent', async () => {
    const c = make(2);
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    void c.get(g, P(0, 'values'), h.load);
    await c.get(g, P(1), resolving().of(1));
    void c.get(g, P(0, 'values'), h.load);
    await c.get(g, P(2), resolving().of(2));
    expect(c.has(P(0, 'values'))).toBe(true);
    expect(c.has(P(1))).toBe(false);
    h.at(0).resolve(0);
  });

  it('C5: a superseded lookup of the same kind is aborted, another kind is not', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    const p1 = c.get(g, P(1, 'values'), h.load);
    const first = nameOf(p1);
    void c.get(g, P(2, 'values'), h.load).catch(() => undefined);
    expect(h.at(0).signal.aborted).toBe(true);
    expect(c.has(P(1, 'values'))).toBe(false);
    await flush();
    expect(first.got).toBe('AbortError');

    const c2 = make();
    const g2 = c2.retainTenant('demo');
    const h2 = controlled<number>();
    const other = controlled<number>();
    void c2.get(g2, P(1, 'values'), h2.load);
    void c2.get(g2, P(1, 'values'), h2.load);
    void c2.get(g2, P(2, 'labels'), other.load);
    expect(h2.load).toHaveBeenCalledTimes(1);
    expect(h2.at(0).signal.aborted).toBe(false);
  });

  it('C6: a rejected load is not kept', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const load = vi.fn(() => Promise.reject(new Error('x')));
    await expect(c.get(g, P(0), load)).rejects.toThrow('x');
    expect(c.has(P(0))).toBe(false);
    await expect(c.get(g, P(0), load)).rejects.toThrow('x');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('C7: eviction never aborts or withholds a result', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const h = controlled<string>();
    const p0 = c.get(g, P(0, 'values'), h.load);
    const r = resolving();
    for (let i = 1; i <= 2000; i++) await c.get(g, P(i, 'labels'), r.of(i));
    expect(c.has(P(0, 'values'))).toBe(false);
    h.at(0).resolve('late');
    expect(await p0).toBe('late');
    expect(h.at(0).signal.aborted).toBe(false);
  });

  it('C8: a tenant switch ends the generation; the same tenant joins it', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const r = resolving();
    const ga = c.retainTenant('a');
    await c.get(ga, Pa(1), r.of(1));
    const gb = c.retainTenant('b');
    expect(c.size).toBe(0);
    const h = controlled<number>();
    void c.get(gb, Pb(2), h.load).catch(() => undefined);
    const ga2 = c.retainTenant('a');
    expect(h.at(0).signal.aborted).toBe(true);
    expect(c.size).toBe(0);
    expect(new Set([g, ga, gb, ga2]).size).toBe(4);
    expect(c.retainTenant('a')).toBe(ga2);
  });

  it('C9: key, window bucket and clear', () => {
    expect(
      suggestKey({
        tenant: 'demo',
        lang: 'promql',
        kind: 'values',
        label: 'job',
        selector: 'up',
        bucket: 8,
      }),
    ).toBe('["demo","promql","values","job","up",8]');
    expect(windowBucket(899_999)).toBe(0);
    expect(windowBucket(900_000)).toBe(1);
    const c = make();
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    void c.get(g, P(0), h.load).catch(() => undefined);
    c.clear();
    expect(h.at(0).signal.aborted).toBe(true);
    expect(c.size).toBe(0);
  });

  async function evictedDeaf(end: (c: SuggestCache) => void) {
    const c = make(1);
    const g = c.retainTenant('demo');
    const d = controlled<string>(true);
    const p0 = c.get(g, P(0, 'values'), d.load);
    const box = nameOf(p0);
    await c.get(g, P(1, 'labels'), resolving().of(1));
    expect(c.has(P(0, 'values'))).toBe(false);
    expect(d.at(0).signal.aborted).toBe(false);
    end(c);
    return { c, d, p0, box };
  }

  it('C10: an evicted in-flight lookup is dropped by a tenant switch', async () => {
    const { c, d, box } = await evictedDeaf((x) => x.retainTenant('other'));
    expect(d.at(0).signal.aborted).toBe(true);
    await flush();
    expect(box.got).toBe('AbortError');
    d.at(0).resolve('late');
    await flush();
    expect(box.got).toBe('AbortError');
    expect(c.size).toBe(0);
  });

  it('C11 (a): and by clear()', async () => {
    const { c, d, box } = await evictedDeaf((x) => {
      x.clear();
    });
    expect(d.at(0).signal.aborted).toBe(true);
    await flush();
    expect(box.got).toBe('AbortError');
    d.at(0).resolve('late');
    await flush();
    expect(box.got).toBe('AbortError');
    expect(c.size).toBe(0);
  });

  it('C11 (b): the same tenant again withholds nothing', async () => {
    const { d, p0, box } = await evictedDeaf((x) => x.retainTenant('demo'));
    expect(d.at(0).signal.aborted).toBe(false);
    await flush();
    expect(box.got).toBeUndefined();
    d.at(0).resolve('late');
    expect(await p0).toBe('late');
  });

  async function stuck(end: (c: SuggestCache) => void) {
    const c = make();
    const g = c.retainTenant('demo');
    const d = controlled<string>(true);
    const p0 = c.get(g, P(0, 'values'), d.load);
    const box = nameOf(p0);
    end(c);
    await flush();
    expect(d.at(0).signal.aborted).toBe(true);
    expect(box.got).toBe('AbortError');
    expect(c.size).toBe(0);
    expect(c.has(P(0, 'values'))).toBe(false);
    return { c, d, box };
  }

  it('C12: a stuck lookup is rejected at once by a tenant switch', async () => {
    await stuck((c) => c.retainTenant('other'));
  });

  it('C13: and by clear()', async () => {
    await stuck((c) => {
      c.clear();
    });
  });

  it('C14: a foreign tenant, an unissued or an ended token sends nothing', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const ga = c.retainTenant('a');
    const load = vi.fn(() => Promise.resolve(1));
    await expect(c.get(ga, Pb(1), load)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(c.get(ga + 1, Pa(1), load)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(c.track(g, load)).rejects.toMatchObject({ name: 'AbortError' });
    expect(load).not.toHaveBeenCalled();
    await c.get(ga, Pa(1), load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(c.size).toBe(1);
  });

  it('C15 (a): a tracked call is rejected at once by a tenant switch', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const d = controlled<string>(true);
    const box = nameOf(c.track(g, d.load));
    c.retainTenant('other');
    await flush();
    expect(box.got).toBe('AbortError');
    expect(d.at(0).signal.aborted).toBe(true);
    d.at(0).resolve('late');
    await flush();
    expect(box.got).toBe('AbortError');
    expect(c.size).toBe(0);
  });

  it('C15 (b): by clear(), the load rejecting later', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const d = controlled<string>(true);
    const box = nameOf(c.track(g, d.load));
    c.clear();
    await flush();
    expect(box.got).toBe('AbortError');
    expect(d.at(0).signal.aborted).toBe(true);
    d.at(0).reject(new Error('late'));
    await flush();
    expect(box.got).toBe('AbortError');
    expect(c.size).toBe(0);
  });

  it('C15 (c): a dropped lookup rejecting later reports nothing', async () => {
    const { d, box } = await stuck((c) => c.retainTenant('other'));
    d.at(0).reject(new Error('late'));
    await flush();
    expect(box.got).toBe('AbortError');
  });

  it('C15 (d): a tracked call delivers its result and holds no key', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    let signal: AbortSignal | undefined;
    const v = await c.track(g, (s) => {
      signal = s;
      return Promise.resolve(5);
    });
    expect(v).toBe(5);
    expect(c.size).toBe(0);
    expect(signal?.aborted).toBe(false);
  });

  it('C16 (a): after clear() the old token sends nothing; a new token does', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const r = resolving();
    await c.get(g, P(0), r.of(0));
    c.clear();
    const p1 = c.get(g, P(1), r.of(1));
    const p2 = c.track(g, r.of(2));
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.count).toHaveBeenCalledTimes(1);
    const g2 = c.retainTenant('demo');
    expect(g2).not.toBe(g);
    await c.get(g2, P(1), r.of(1));
    expect(r.count).toHaveBeenCalledTimes(2);
  });

  it('C16 (b): a → b → a: the first token of a is ended', async () => {
    const c = make();
    c.retainTenant('demo');
    const ga = c.retainTenant('a');
    const gb = c.retainTenant('b');
    const ga2 = c.retainTenant('a');
    const r = resolving();
    await expect(c.get(ga, Pa(0), r.of(0))).rejects.toMatchObject({ name: 'AbortError' });
    await expect(c.get(gb, Pb(0), r.of(0))).rejects.toMatchObject({ name: 'AbortError' });
    expect(r.count).not.toHaveBeenCalled();
    await c.get(ga2, Pa(0), r.of(0));
    expect(r.count).toHaveBeenCalledTimes(1);
  });

  it('C17: an evicted in-flight lookup is still superseded', async () => {
    const c = make(1);
    const g = c.retainTenant('demo');
    const h0 = controlled<number>();
    const p0 = c.get(g, P(0, 'values'), h0.load);
    const box = nameOf(p0);
    await c.get(g, P(1, 'labels'), resolving().of(1));
    expect(c.has(P(0, 'values'))).toBe(false);
    expect(h0.at(0).signal.aborted).toBe(false);
    const h2 = controlled<number>();
    void c.get(g, P(2, 'values'), h2.load);
    expect(h0.at(0).signal.aborted).toBe(true);
    await flush();
    expect(box.got).toBe('AbortError');
    expect(h2.load).toHaveBeenCalledTimes(1);
    expect(h2.at(0).signal.aborted).toBe(false);
    expect(c.has(P(2, 'values'))).toBe(true);
  });

  it('C18: an evicted in-flight lookup is re-joined by its own key', async () => {
    const c = make(1);
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    const p0 = c.get(g, P(0, 'values'), h.load);
    await c.get(g, P(1, 'labels'), resolving().of(1));
    const p1 = c.get(g, P(0, 'values'), h.load);
    expect(p1).toBe(p0);
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(c.has(P(0, 'values'))).toBe(true);
    expect(c.has(P(1, 'labels'))).toBe(false);
    h.at(0).resolve(7);
    expect(await p0).toBe(7);
    expect(h.at(0).signal.aborted).toBe(false);
  });
});

// Plan #66 Part A §3.9, Appendix A.4 (Cache caller signals): the key holds the language; a LogQL
// entry is released by its callers' signals, never superseded.
const L = (label: string): SuggestKeyParts => ({
  tenant: 'demo',
  lang: 'logql',
  kind: 'values',
  label,
  selector: null,
  bucket: 0,
});
const L1 = L('app');
const L2 = L('pod');

describe('unit:suggest-cache by language', () => {
  it('the key holds the language', () => {
    expect(
      suggestKey({
        tenant: 'demo',
        lang: 'logql',
        kind: 'labels',
        label: null,
        selector: null,
        bucket: 0,
      }),
    ).toBe('["demo","logql","labels",null,null,0]');
  });

  it('a LogQL get of another key does not abort an in-flight PromQL entry of its kind', () => {
    const c = make();
    const g = c.retainTenant('demo');
    const prom = controlled<number>();
    const logs = controlled<number>();
    void c.get(g, { ...P(1, 'labels') }, prom.load);
    void c.get(g, { ...L1, kind: 'labels', label: null }, logs.load);
    expect(prom.at(0).signal.aborted).toBe(false);
    expect(logs.at(0).signal.aborted).toBe(false);
  });

  it('G1: the last signalled caller aborts the load', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    const s1 = new AbortController();
    const p = c.get(g, P(0), h.load, s1.signal);
    const box = nameOf(p);
    s1.abort();
    expect(h.at(0).signal.aborted).toBe(true);
    await flush();
    expect(box.got).toBe('AbortError');
    expect(c.has(P(0))).toBe(false);
  });

  it('G2: a shared load is aborted only when both callers abort', () => {
    const c = make();
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    const s1 = new AbortController();
    const s2 = new AbortController();
    void c.get(g, P(0), h.load, s1.signal).catch(() => undefined);
    void c.get(g, P(0), h.load, s2.signal).catch(() => undefined);
    expect(h.load).toHaveBeenCalledTimes(1);
    s1.abort();
    expect(h.at(0).signal.aborted).toBe(false);
    s2.abort();
    expect(h.at(0).signal.aborted).toBe(true);
  });

  it('G3: an unsignalled caller pins the load', () => {
    const c = make();
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    const s1 = new AbortController();
    void c.get(g, P(0), h.load);
    void c.get(g, P(0), h.load, s1.signal);
    s1.abort();
    expect(h.at(0).signal.aborted).toBe(false);
  });

  it('G4: an aborted signal rejects at once and loads nothing', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const h = controlled<number>();
    const s = new AbortController();
    s.abort();
    const box = nameOf(c.get(g, P(0), h.load, s.signal));
    await flush();
    expect(box.got).toBe('AbortError');
    expect(h.load).not.toHaveBeenCalled();
    expect(c.has(P(0))).toBe(false);
  });

  it('G5: a settled entry ignores signals', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const s1 = new AbortController();
    expect(await c.get(g, P(0), () => Promise.resolve(['x']), s1.signal)).toEqual(['x']);
    s1.abort();
    expect(c.has(P(0))).toBe(true);
    const load2 = vi.fn(() => Promise.resolve(['y']));
    expect(await c.get(g, P(0), load2)).toEqual(['x']);
    expect(load2).not.toHaveBeenCalled();
  });

  it('G6: two LogQL keys of one kind do not supersede each other', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const l1 = controlled<number>();
    const l2 = controlled<number>();
    const p1 = c.get(g, L1, l1.load, new AbortController().signal);
    const p2 = c.get(g, L2, l2.load, new AbortController().signal);
    expect(l1.at(0).signal.aborted).toBe(false);
    expect(l2.at(0).signal.aborted).toBe(false);
    l1.at(0).resolve(1);
    l2.at(0).resolve(2);
    expect(await p1).toBe(1);
    expect(await p2).toBe(2);
  });

  it('G7: a pinned LogQL entry survives a released caller and another key', async () => {
    const c = make();
    const g = c.retainTenant('demo');
    const l1 = controlled<number>();
    const l1b = controlled<number>();
    const l2 = controlled<number>();
    const first = c.get(g, L1, l1.load);
    const s1 = new AbortController();
    void c.get(g, L1, l1b.load, s1.signal).catch(() => undefined);
    s1.abort();
    void c.get(g, L2, l2.load, new AbortController().signal);
    l1.at(0).resolve(7);
    expect(l1b.load).not.toHaveBeenCalled();
    expect(l1.at(0).signal.aborted).toBe(false);
    expect(await first).toBe(7);
    expect(c.has(L1)).toBe(true);
  });
});
