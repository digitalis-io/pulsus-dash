/**
 * A fake histogram worker environment (T21-016 tests): each fake worker runs `onHistogramMessage`
 * on what it is posted and replies on a microtask, so the main-thread protocol of
 * `histogramClient.ts` is tested without a real `Worker`. Replies are delivered even after
 * `terminate()`, so the client's dropping of stale replies is observable.
 */
import {
  onHistogramMessage,
  type HistogramReply,
  type HistogramRequest,
  type WorkerState,
} from '../vis/transforms/histogram.worker';
import type { HistogramEnv, HistogramWorkerLike } from '../vis/transforms/histogramClient';

export type FakeReplyMode = 'reply' | 'errorReply' | 'errorEvent' | 'silent';

export class FakeHistogramWorker implements HistogramWorkerLike {
  readonly st: WorkerState = { runId: null, series: [] };
  terminated = false;
  onmessage: ((e: MessageEvent<HistogramReply>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  constructor(private readonly kit: FakeHistogramKit) {}

  postMessage(m: HistogramRequest, transfer: Transferable[]): void {
    this.kit.posts.push({ worker: this.kit.workers.indexOf(this), m, transfer });
    this.kit.log.push(m.last ? 'post:last' : 'post');
    const r = onHistogramMessage(this.st, m);
    if (r === null) return;
    const mode = this.kit.mode;
    queueMicrotask(() => {
      if (mode === 'reply') this.deliver(r);
      else if (mode === 'errorReply') this.deliver({ runId: r.runId, error: 'worker failed' });
      else if (mode === 'errorEvent') this.onerror?.(new Event('error'));
    });
  }

  /** Hands `r` to the client as a worker message. */
  deliver(r: HistogramReply): void {
    this.onmessage?.(new MessageEvent('message', { data: r }));
  }

  terminate(): void {
    this.terminated = true;
  }
}

export interface FakeHistogramKit {
  readonly workers: FakeHistogramWorker[];
  readonly posts: { worker: number; m: HistogramRequest; transfer: Transferable[] }[];
  /** `post`, `post:last` and `yield`, in order. */
  readonly log: string[];
  mode: FakeReplyMode;
  /** Values copied so far (`copied`). */
  copiedTotal: number;
  env: Partial<HistogramEnv>;
}

/** A kit whose clock is `clock(kit)` and whose yields run `onYield` first. */
export function fakeHistogramKit(
  o: {
    clock?: (kit: FakeHistogramKit) => number;
    onYield?: (kit: FakeHistogramKit) => void;
  } = {},
): FakeHistogramKit {
  const kit: FakeHistogramKit = {
    workers: [],
    posts: [],
    log: [],
    mode: 'reply',
    copiedTotal: 0,
    env: {},
  };
  kit.env = {
    now: () => (o.clock ? o.clock(kit) : 0),
    yieldNow: () => {
      kit.log.push('yield');
      o.onYield?.(kit);
      return Promise.resolve();
    },
    createWorker: () => {
      const w = new FakeHistogramWorker(kit);
      kit.workers.push(w);
      return w;
    },
    copied: (n) => {
      kit.copiedTotal += n;
    },
  };
  return kit;
}

/** Settles `p` without an unhandled rejection. */
export function settle<T>(
  p: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
