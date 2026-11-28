/**
 * The page's one scheduler of board range requests (#304 §4.6, §A.10; T04-013, T07-009, T07-010):
 * a FIFO queue per class, at most 6 in flight in total and 4 non-interactive. While non-interactive
 * work waits and none runs, interactive holds at most 5, so prefetch always gets a slot; an
 * interactive job that finds all 6 taken with ≥ 2 non-interactive running preempts the newest of
 * them (aborted, requeued at the head of its class). Cancelling a running job aborts its fetch
 * (HTTP/2 RST). A job starts in its `submit` call when a slot is free; a finished job's slot is
 * refilled in a microtask.
 */
export type RangeClass = 'interactive' | 'refine' | 'prefetch' | 'background';
/** The fetch's `priority`: interactive `high`, refine `auto`, the rest `low`. */
export type FetchPriority = 'high' | 'auto' | 'low';

export const MAX_IN_FLIGHT = 6;
export const MAX_LOW_IN_FLIGHT = 4;
/** Interactive's share while non-interactive work waits with none running: one slot reserved. */
const INTERACTIVE_RESERVED = MAX_IN_FLIGHT - 1;

const ORDER: readonly RangeClass[] = ['interactive', 'refine', 'prefetch', 'background'];
const RANK: Readonly<Record<RangeClass, number>> = {
  interactive: 0,
  refine: 1,
  prefetch: 2,
  background: 3,
};

export const priorityOf = (c: RangeClass): FetchPriority =>
  c === 'interactive' ? 'high' : c === 'refine' ? 'auto' : 'low';

export interface Job {
  /** Store jobs: `${idKey}|${k0}|${k1}|${epoch}|${anchorMs}`; `exec`: unique. */
  readonly key: string;
  cls: RangeClass;
  readonly run: (signal: AbortSignal, priority: FetchPriority) => Promise<void>;
}

export interface Scheduler {
  /** A job of a key already queued or running only upgrades that one. */
  submit(job: Job): void;
  /** Raises a queued or running job's class (never lowers it). */
  upgrade(key: string, cls: RangeClass): void;
  /** Queued: dropped; running: aborted. */
  cancel(key: string): void;
  has(key: string): boolean;
  /**
   * A single request (bypass, ineligible, a LogQL frame and its volume): an `interactive` job;
   * the caller's signal cancels it.
   */
  exec<T>(
    signal: AbortSignal | undefined,
    f: (s: AbortSignal, p: 'high') => Promise<T>,
  ): Promise<T>;
  stats(): { readonly inFlight: number; readonly lowInFlight: number; readonly queued: number };
}

interface Running {
  readonly job: Job;
  readonly ctrl: AbortController;
  readonly seq: number;
}

const abortError = (): DOMException => new DOMException('cancelled', 'AbortError');

export function createScheduler(): Scheduler {
  const queues: Record<RangeClass, Job[]> = {
    interactive: [],
    refine: [],
    prefetch: [],
    background: [],
  };
  const queued = new Map<string, Job>();
  const running = new Map<string, Running>();
  let seq = 0;
  let execSeq = 0;
  let pumpQueued = false;
  let pumping = false;

  const lowRunning = (): number => {
    let n = 0;
    for (const r of running.values()) if (r.job.cls !== 'interactive') n++;
    return n;
  };
  const lowQueued = (): number =>
    queues.refine.length + queues.prefetch.length + queues.background.length;

  const start = (job: Job): void => {
    const ctrl = new AbortController();
    const r: Running = { job, ctrl, seq: ++seq };
    running.set(job.key, r);
    const done = (): void => {
      if (running.get(job.key) === r) running.delete(job.key);
      schedule();
    };
    let p: Promise<void>;
    try {
      p = job.run(ctrl.signal, priorityOf(job.cls));
    } catch {
      done();
      return;
    }
    p.then(done, done);
  };

  const take = (cls: RangeClass): Job | undefined => {
    const job = queues[cls].shift();
    if (job !== undefined) queued.delete(job.key);
    return job;
  };

  const enqueue = (job: Job, front = false): void => {
    queued.set(job.key, job);
    if (front) queues[job.cls].unshift(job);
    else queues[job.cls].push(job);
  };

  const pump = (): void => {
    pumpQueued = false;
    if (pumping) return;
    pumping = true;
    try {
      pumpOnce();
    } finally {
      pumping = false;
    }
  };

  const pumpOnce = (): void => {
    for (;;) {
      const inFlight = running.size;
      const low = lowRunning();
      const interactiveRunning = inFlight - low;
      if (queues.interactive.length > 0) {
        const limit = lowQueued() > 0 && low === 0 ? INTERACTIVE_RESERVED : MAX_IN_FLIGHT;
        if (inFlight < MAX_IN_FLIGHT && interactiveRunning < limit) {
          const job = take('interactive');
          if (job !== undefined) start(job);
          continue;
        }
        if (inFlight >= MAX_IN_FLIGHT && low >= 2) {
          // Preempt the newest non-interactive job.
          let newest: Running | null = null;
          for (const r of running.values()) {
            if (r.job.cls !== 'interactive' && (newest === null || r.seq > newest.seq)) newest = r;
          }
          if (newest !== null) {
            running.delete(newest.job.key);
            newest.ctrl.abort(abortError());
            enqueue(newest.job, true);
            const job = take('interactive');
            if (job !== undefined) start(job);
            continue;
          }
        }
      }
      if (
        inFlight < MAX_IN_FLIGHT &&
        low < MAX_LOW_IN_FLIGHT &&
        (queues.interactive.length === 0 || low === 0)
      ) {
        const cls = ORDER.find((c) => c !== 'interactive' && queues[c].length > 0);
        if (cls !== undefined) {
          const job = take(cls);
          if (job !== undefined) start(job);
          continue;
        }
      }
      return;
    }
  };

  const schedule = (): void => {
    if (pumpQueued) return;
    pumpQueued = true;
    queueMicrotask(pump);
  };

  const upgrade = (key: string, cls: RangeClass): void => {
    const q = queued.get(key);
    if (q !== undefined) {
      if (RANK[cls] >= RANK[q.cls]) return;
      const list = queues[q.cls];
      list.splice(list.indexOf(q), 1);
      q.cls = cls;
      queues[cls].push(q);
      schedule();
      return;
    }
    const r = running.get(key);
    if (r !== undefined && RANK[cls] < RANK[r.job.cls]) r.job.cls = cls;
  };

  const s: Scheduler = {
    submit(job) {
      if (queued.has(job.key) || running.has(job.key)) {
        upgrade(job.key, job.cls);
        return;
      }
      enqueue(job);
      pump();
    },
    upgrade,
    cancel(key) {
      const q = queued.get(key);
      if (q !== undefined) {
        queued.delete(key);
        const list = queues[q.cls];
        list.splice(list.indexOf(q), 1);
        return;
      }
      const r = running.get(key);
      if (r !== undefined) {
        running.delete(key);
        r.ctrl.abort(abortError());
        schedule();
      }
    },
    has: (key) => queued.has(key) || running.has(key),
    exec(signal, f) {
      return new Promise((resolve, reject: (e: Error) => void) => {
        if (signal?.aborted === true) {
          reject(abortError());
          return;
        }
        const key = `exec|${String(++execSeq)}`;
        let settled = false;
        const settle = (ok: boolean, v: unknown): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          if (ok) resolve(v as never);
          else reject(v instanceof Error ? v : new Error(String(v)));
        };
        const onAbort = (): void => {
          s.cancel(key);
          settle(false, abortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        s.submit({
          key,
          cls: 'interactive',
          run: (sig) =>
            f(sig, 'high').then(
              (v) => {
                settle(true, v);
              },
              (e: unknown) => {
                settle(false, e);
              },
            ),
        });
      });
    },
    stats: () => ({ inFlight: running.size, lowInFlight: lowRunning(), queued: queued.size }),
  };
  return s;
}
