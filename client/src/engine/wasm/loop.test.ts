import { describe, expect, it } from 'vitest';
import { frameLoop } from './loop';

/** A manual animation-frame queue. */
function frames() {
  const queue: (() => void)[] = [];
  return {
    queue,
    requestFrame: (cb: () => void): number => queue.push(cb),
    run(): void {
      for (const cb of queue.splice(0)) cb();
    },
  };
}

describe('render worker frame loop (review r1 #2)', () => {
  it('a wake while idle schedules one tick; a busy loop keeps one frame pending', () => {
    const f = frames();
    let wants = [true, false];
    let ticks = 0;
    const l = frameLoop({
      tick: () => {
        ticks += 1;
        return wants.shift() ?? false;
      },
      requestFrame: f.requestFrame,
    });
    l.wake();
    l.wake();
    expect(f.queue).toHaveLength(1);
    f.run();
    f.run();
    expect(ticks).toBe(2);
    // Idle now: nothing pending until something wakes the loop.
    expect(f.queue).toHaveLength(0);
    // A device loss reported while idle (`engine_on_wake`) gets a tick.
    wants = [false];
    l.wake();
    expect(f.queue).toHaveLength(1);
    f.run();
    expect(ticks).toBe(3);
  });
});
