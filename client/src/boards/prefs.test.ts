import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Api } from '../api/Api';
import { ApiError } from '../api/types';
import { createBoardPrefs, type PrefsChannel, type PrefsMessage } from './prefs';

interface Pending {
  uid: string;
  at: number;
  signal: AbortSignal | undefined;
  settled: boolean;
  resolve: () => void;
  reject: (e: Error) => void;
}

/**
 * A server that ignores the client's abort: `recordView` rejects with `AbortError` when its signal
 * aborts, while the commit (`viewed[uid] = max(viewed[uid], at)`) runs only when the test calls
 * `commit`, whether or not the signal aborted.
 */
class FakeRecentServer {
  readonly viewed = new Map<string, number>();
  readonly sent: Pending[] = [];
  private readonly committed = new Set<number>();

  api(): Api {
    const recordView = (_tenant: string, uid: string, at: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const p: Pending = {
          uid,
          at,
          signal,
          settled: false,
          resolve: () => {
            if (!p.settled) resolve();
            p.settled = true;
          },
          reject: (e) => {
            if (!p.settled) reject(e);
            p.settled = true;
          },
        };
        this.sent.push(p);
        signal?.addEventListener('abort', () => {
          p.reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    return { recordView } as unknown as Api;
  }

  /** Commits the `i`-th request sent: the greater time wins, then the request resolves. */
  commitAt(i: number): void {
    const p = this.sent[i];
    if (p === undefined) throw new Error(`no request ${String(i)}`);
    this.committed.add(i);
    this.viewed.set(p.uid, Math.max(this.viewed.get(p.uid) ?? -Infinity, p.at));
    p.resolve();
  }

  /** Commits the first request of `uid` not committed yet. */
  commit(uid: string): void {
    this.commitAt(this.sent.findIndex((p, i) => p.uid === uid && !this.committed.has(i)));
  }

  fail(i: number, e: Error): void {
    this.sent[i]?.reject(e);
  }

  list(): string[] {
    return [...this.viewed.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  }
}

/** An in-memory `BroadcastChannel`: a post reaches every other open endpoint, never its own. */
function channelBus() {
  const open = new Set<{ listeners: ((m: PrefsMessage) => void)[]; received: PrefsMessage[] }>();
  const endpoints: { received: PrefsMessage[] }[] = [];
  const opener = (): (() => PrefsChannel) => () => {
    const me = { listeners: [] as ((m: PrefsMessage) => void)[], received: [] as PrefsMessage[] };
    open.add(me);
    endpoints.push(me);
    return {
      post: (m) => {
        for (const other of open) {
          if (other === me) continue;
          other.received.push(m);
          for (const f of other.listeners) f(m);
        }
      },
      onMessage: (f) => {
        me.listeners.push(f);
      },
      close: () => {
        open.delete(me);
      },
    };
  };
  return { opener, endpoints };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('view recorder', () => {
  it('view recorder keeps navigation order', async () => {
    vi.useFakeTimers();
    const server = new FakeRecentServer();
    const prefs = createBoardPrefs(
      server.api(),
      new QueryClient(),
      () => null,
      () => 1_000,
    );
    prefs.recordView('demo', 'b-1');
    prefs.recordView('demo', 'b-2');
    expect(server.sent.map((p) => [p.uid, p.at])).toEqual([
      ['b-1', 1_000],
      ['b-2', 1_001],
    ]);
    server.commit('b-2');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.sent[0]?.signal?.aborted).toBe(true);
    expect(server.sent[0]?.settled).toBe(true);
    // b-1 commits after its client timeout and after b-2.
    server.commit('b-1');
    expect(server.list()).toEqual(['b-2', 'b-1']);
    prefs.dispose();
  });

  it('view recorder: repeated views', async () => {
    const server = new FakeRecentServer();
    let t = 5_000;
    let calls = 0;
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const prefs = createBoardPrefs(
      server.api(),
      qc,
      () => null,
      () => {
        calls += 1;
        if (calls > 3) t = 4_000;
        return t;
      },
    );
    for (const uid of ['A', 'B', 'C', 'D', 'E', 'D']) prefs.recordView('demo', uid);
    expect(server.sent).toHaveLength(6);
    const ats = server.sent.map((p) => p.at);
    for (let i = 1; i < ats.length; i++) expect(ats[i]).toBeGreaterThan(ats[i - 1] ?? Infinity);
    for (let i = 5; i >= 0; i--) server.commitAt(i);
    await flush();
    expect(server.list().slice(0, 5)).toEqual(['D', 'E', 'C', 'B', 'A']);
    prefs.dispose();

    // One success invalidates ['recent'] once; notFound does not.
    const one = new FakeRecentServer();
    const qc1 = new QueryClient();
    const inv1 = vi.spyOn(qc1, 'invalidateQueries');
    const p1 = createBoardPrefs(one.api(), qc1, () => null);
    p1.recordView('demo', 'A');
    one.fail(0, new ApiError('notFound', 'gone'));
    await flush();
    expect(inv1).not.toHaveBeenCalled();
    p1.recordView('demo', 'B');
    one.commitAt(1);
    await flush();
    expect(inv1).toHaveBeenCalledTimes(1);
    expect(inv1).toHaveBeenCalledWith({ queryKey: ['recent'] });
    p1.dispose();
    expect(invalidate).toHaveBeenCalledTimes(6);
  });

  it('view recorder reconciles', async () => {
    vi.useFakeTimers({ now: 0 });
    const outcome = { next: (() => new Promise<void>(() => undefined)) as () => Promise<void> };
    const api = {
      recordView: (_t: string, _u: string, _a: number, signal?: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
          outcome.next().then(resolve, reject);
        }),
    } as unknown as Api;
    const recentCalls = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.filter(
        (c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ['recent'] }),
      ).length;

    // Two timeouts: one timer, re-armed to the later due time.
    {
      const qc = new QueryClient();
      const spy = vi.spyOn(qc, 'invalidateQueries');
      const bus = channelBus();
      const other = bus.opener()();
      const prefs = createBoardPrefs(api, qc, bus.opener());
      const close = prefs.connect();
      prefs.recordView('demo', 'A');
      await vi.advanceTimersByTimeAsync(3_000);
      prefs.recordView('demo', 'B');
      await vi.advanceTimersByTimeAsync(14_999 - 3_000);
      expect(recentCalls(spy)).toBe(0);
      await vi.advanceTimersByTimeAsync(17_999 - 14_999);
      expect(recentCalls(spy)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(recentCalls(spy)).toBe(1);
      expect(bus.endpoints[0]?.received).toEqual([{ kind: 'recent' }]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(recentCalls(spy)).toBe(1);
      close();
      other.close();
      prefs.dispose();
    }

    // network and unknown (503): one reconciliation 15 s after the send.
    for (const e of [new ApiError('network', 'x'), new ApiError('unknown', 'HTTP 503')]) {
      const start = Date.now();
      const qc = new QueryClient();
      const spy = vi.spyOn(qc, 'invalidateQueries');
      const prefs = createBoardPrefs(api, qc, () => null);
      outcome.next = () => Promise.reject(e);
      prefs.recordView('demo', 'A');
      await vi.advanceTimersByTimeAsync(14_999);
      expect(recentCalls(spy), e.kind).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(Date.now() - start).toBe(15_000);
      expect(recentCalls(spy), e.kind).toBe(1);
      prefs.dispose();
    }

    // notFound or success: no timer once settled.
    for (const next of [
      () => Promise.reject(new ApiError('notFound', 'gone')),
      () => Promise.resolve(),
    ]) {
      const prefs = createBoardPrefs(api, new QueryClient(), () => null);
      outcome.next = next;
      prefs.recordView('demo', 'A');
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      prefs.dispose();
    }

    // dispose() with a pending reconciliation: nothing fires.
    {
      const qc = new QueryClient();
      const spy = vi.spyOn(qc, 'invalidateQueries');
      const prefs = createBoardPrefs(api, qc, () => null);
      outcome.next = () => Promise.reject(new ApiError('network', 'x'));
      prefs.recordView('demo', 'A');
      await vi.advanceTimersByTimeAsync(1_000);
      prefs.dispose();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(recentCalls(spy)).toBe(0);
    }
  });

  it('recent skew across app instances', async () => {
    const server = new FakeRecentServer();
    const start = performance.now();
    const one = createBoardPrefs(
      server.api(),
      new QueryClient(),
      () => null,
      () => 241_000,
    );
    const two = createBoardPrefs(
      server.api(),
      new QueryClient(),
      () => null,
      () => 1_000 + (performance.now() - start),
    );
    one.recordView('demo', 'A');
    one.recordView('demo', 'A');
    two.recordView('demo', 'B');
    two.recordView('demo', 'B');
    for (let i = 0; i < server.sent.length; i++) server.commitAt(i);
    await flush();
    // The fast clock wins: across app instances the order is best effort (D-RECENT-window).
    expect(server.list()).toEqual(['A', 'B']);
    const [a1, a2, b1, b2] = server.sent.map((p) => p.at);
    expect(a1).toBe(241_000);
    expect(a2).toBe(241_001);
    expect(b2).toBeGreaterThan(b1 ?? Infinity);
    one.dispose();
    two.dispose();
  });

  it('prefs channel', async () => {
    const bus = channelBus();
    const ok = { recordView: () => Promise.resolve() } as unknown as Api;
    const qcA = new QueryClient();
    const qcB = new QueryClient();
    qcB.setQueryData(['recent', 'demo'], []);
    qcB.setQueryData(['starred', 'demo'], []);
    const a = createBoardPrefs(ok, qcA, bus.opener());
    const b = createBoardPrefs(ok, qcB, bus.opener());
    const closeA = a.connect();
    const closeB = b.connect();
    a.recordView('demo', 'b-1');
    await flush();
    expect(qcB.getQueryState(['recent', 'demo'])?.isInvalidated).toBe(true);
    expect(qcB.getQueryState(['starred', 'demo'])?.isInvalidated).toBe(false);
    expect(bus.endpoints[0]?.received).toEqual([]);
    await a.starredChanged();
    expect(qcB.getQueryState(['starred', 'demo'])?.isInvalidated).toBe(true);

    closeB();
    qcB.setQueryData(['recent', 'demo'], []);
    a.recordView('demo', 'b-2');
    await expect(a.starredChanged()).resolves.toBeUndefined();
    await flush();
    expect(qcB.getQueryState(['recent', 'demo'])?.isInvalidated).toBe(false);
    closeA();
    a.dispose();
    b.dispose();

    // No BroadcastChannel: both methods still work.
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const none = createBoardPrefs(ok, qc, () => null);
    const close = none.connect();
    none.recordView('demo', 'b-1');
    await none.starredChanged();
    await flush();
    expect(spy).toHaveBeenCalledWith({ queryKey: ['recent'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['starred'] });
    close();
    none.dispose();
  });
});
