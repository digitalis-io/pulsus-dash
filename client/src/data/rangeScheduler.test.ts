import { describe, expect, it } from 'vitest';
import {
  MAX_IN_FLIGHT,
  MAX_LOW_IN_FLIGHT,
  createScheduler,
  type FetchPriority,
  type RangeClass,
} from './rangeScheduler';

interface Probe {
  readonly key: string;
  readonly cls: RangeClass;
  started: number;
  aborted: number;
  priority: FetchPriority | null;
  finish: () => void;
}

/** Jobs that run until the test finishes them; counts what runs. */
function harness() {
  const s = createScheduler();
  const probes = new Map<string, Probe>();
  const running = new Set<string>();
  let maxRunning = 0;
  let maxLow = 0;
  const lowRunning = () => [...running].filter((k) => probes.get(k)?.cls !== 'interactive').length;
  const add = (key: string, cls: RangeClass): Probe => {
    const p: Probe = { key, cls, started: 0, aborted: 0, priority: null, finish: () => undefined };
    probes.set(key, p);
    s.submit({
      key,
      cls,
      run: (signal, priority) =>
        new Promise<void>((resolve, reject) => {
          p.started++;
          p.priority = priority;
          running.add(key);
          maxRunning = Math.max(maxRunning, running.size);
          maxLow = Math.max(maxLow, lowRunning());
          p.finish = () => {
            running.delete(key);
            resolve();
          };
          signal.addEventListener('abort', () => {
            p.aborted++;
            running.delete(key);
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    });
    return p;
  };
  return {
    s,
    add,
    probes,
    running,
    lowRunning,
    max: () => ({ running: maxRunning, low: maxLow }),
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('rangeScheduler (#304 §4.6, §A.10)', () => {
  it('scheduler caps', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) h.add(`i${String(i)}`, 'interactive');
    for (let i = 0; i < 10; i++) h.add(`p${String(i)}`, 'prefetch');
    await flush();
    expect(h.running.size).toBe(MAX_IN_FLIGHT);
    expect(h.lowRunning()).toBe(0);
    // A freed slot goes to the waiting prefetch work: one is reserved for it.
    h.probes.get('i0')?.finish();
    await flush();
    expect(h.running.size).toBe(MAX_IN_FLIGHT);
    expect(h.lowRunning()).toBe(1);
    // Drain: finish everything as it starts.
    for (let round = 0; round < 40 && h.running.size > 0; round++) {
      for (const k of [...h.running]) h.probes.get(k)?.finish();
      await flush();
    }
    expect(h.max().running).toBeLessThanOrEqual(MAX_IN_FLIGHT);
    expect(h.max().low).toBeLessThanOrEqual(MAX_LOW_IN_FLIGHT);
    expect([...h.probes.values()].every((p) => p.started === 1)).toBe(true);
    expect(h.probes.get('i0')?.priority).toBe('high');
    expect(h.probes.get('p0')?.priority).toBe('low');
  });

  it('scheduler preempts', async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) h.add(`low${String(i)}`, 'prefetch');
    await flush();
    h.add('a', 'interactive');
    h.add('b', 'interactive');
    await flush();
    expect(h.running.size).toBe(6);
    expect(h.lowRunning()).toBe(4);
    h.add('c', 'interactive');
    await flush();
    expect(h.probes.get('low3')?.aborted).toBe(1);
    expect(h.probes.get('low0')?.aborted).toBe(0);
    expect(h.running.has('c')).toBe(true);
    expect(h.lowRunning()).toBe(3);
    // The preempted job is requeued and runs again once there is room.
    h.probes.get('a')?.finish();
    h.probes.get('b')?.finish();
    h.probes.get('c')?.finish();
    await flush();
    expect(h.probes.get('low3')?.started).toBe(2);
  });

  it('sustained interactive', async () => {
    // Virtual time: each job ends 50 ms after it starts; the test steps 10 ms at a time.
    const s = createScheduler();
    let now = 0;
    const due: { at: number; done: () => void }[] = [];
    const sleep50 = (signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        due.push({ at: now + 50, done: resolve });
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    let interactiveRunning = 0;
    let lowRunning = 0;
    let lowQueued = 3;
    let lowAlways = true;
    let interactiveOverReserve = false;
    let prefetchDone = 0;
    let submitted = 0;
    const interactive = (): void => {
      s.submit({
        key: `i${String(submitted++)}`,
        cls: 'interactive',
        run: async (signal) => {
          interactiveRunning++;
          if (lowQueued > 0 && interactiveRunning > 5) interactiveOverReserve = true;
          try {
            await sleep50(signal);
          } finally {
            interactiveRunning--;
          }
        },
      });
    };
    for (let i = 0; i < 3; i++) {
      s.submit({
        key: `p${String(i)}`,
        cls: 'prefetch',
        run: async (signal) => {
          lowQueued--;
          lowRunning++;
          try {
            await sleep50(signal);
            prefetchDone++;
          } finally {
            lowRunning--;
          }
        },
      });
    }
    for (let i = 0; i < 12; i++) interactive();
    for (now = 0; now < 2000; now += 10) {
      for (let n = 0; n < 6 && s.stats().queued - lowQueued < 6; n++) interactive();
      for (const d of due.filter((x) => x.at <= now)) {
        due.splice(due.indexOf(d), 1);
        d.done();
      }
      await flush();
      if (lowQueued > 0 && lowRunning === 0) lowAlways = false;
    }
    expect(prefetchDone).toBe(3);
    expect(lowAlways).toBe(true);
    expect(interactiveOverReserve).toBe(false);
  });

  it('exec runs interactive and its signal cancels', async () => {
    const s = createScheduler();
    const c = new AbortController();
    let aborted = false;
    const p = s.exec(c.signal, (signal, priority) => {
      expect(priority).toBe('high');
      return new Promise<number>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    await flush();
    expect(s.stats().inFlight).toBe(1);
    c.abort();
    await expect(p).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(s.stats().inFlight).toBe(0);
  });
});
