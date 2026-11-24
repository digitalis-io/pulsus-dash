// unit:logs-page-kit (issue #144): the settling contract of the scripted calls in `logsPageKit`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VolumeRequest } from '../api/types';
import { scriptedLogsPageApi, volumeAnswer } from './logsPageKit';

const REQ: VolumeRequest = { query: '{app="a"}', fromMs: 0, toMs: 1, widthPx: 1 };

interface Late {
  /** The pending timers when the clock ticked: the kit's first timer, and nothing else. */
  timersAtTick: number | null;
  fired: boolean;
}

/**
 * A consumer that, like the query layer's notify manager, reacts in a 0 ms timer queued at the
 * end of `hops` microtasks after the call settles. Before it queues the timer, the clock ticks
 * 1 ms: under load, that chain crosses a millisecond of the loop's clock, so the timer is due
 * after the kit's first timer.
 */
function lateTimer(p: Promise<unknown>, hops: number): Late {
  const late: Late = { timersAtTick: null, fired: false };
  let q: Promise<unknown> = p.then(
    () => undefined,
    () => undefined,
  );
  for (let i = 0; i < hops; i += 1) q = q.then(() => undefined);
  void q.then(() => {
    late.timersAtTick = vi.getTimerCount();
    vi.advanceTimersByTime(1);
    setTimeout(() => {
      late.fired = true;
    }, 0);
  });
  return late;
}

/** One turn of the real event loop's check phase (`setImmediate` is not faked; `act` uses it). */
const immediate = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Settles the call with `settle`, then records whether the late timer had fired when the
 * settling promise resolved. The real loop turns first, so a kit that is done without the late
 * timer resolves before any fake time passes; then fake time advances 1 ms at a time.
 */
async function firedAtSettle(settle: () => Promise<void>, late: Late): Promise<boolean> {
  const at: { seen: boolean | null } = { seen: null };
  void settle().then(() => {
    at.seen = late.fired;
  });
  for (let i = 0; i < 10 && at.seen === null; i += 1) await immediate();
  for (let i = 0; i < 10 && at.seen === null; i += 1) await vi.advanceTimersByTimeAsync(1);
  if (at.seen === null) throw new Error('the call never settled');
  return at.seen;
}

describe('unit:logs-page-kit', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('K1 reject() waits past a 0 ms timer queued after the rejection', async () => {
    const s = scriptedLogsPageApi();
    const late = lateTimer(s.api.queryVolume('demo', REQ), 20);
    const call = s.volume[0];
    if (call === undefined) throw new Error('no volume call');
    const fired = await firedAtSettle(() => call.reject(new Error('down')), late);
    expect(late.timersAtTick).toBe(1);
    expect(fired).toBe(true);
  });

  it('K2 resolve() waits past a 0 ms timer queued after the answer', async () => {
    const s = scriptedLogsPageApi();
    const late = lateTimer(s.api.queryVolume('demo', REQ), 20);
    const call = s.volume[0];
    if (call === undefined) throw new Error('no volume call');
    const fired = await firedAtSettle(() => call.resolve(volumeAnswer()), late);
    expect(late.timersAtTick).toBe(1);
    expect(fired).toBe(true);
  });
});
