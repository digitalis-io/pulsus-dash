// unit:clock-epoch (plan #66 Part C §3.3, §5.1; IA-020).
import { describe, expect, it, vi } from 'vitest';
import { createClock } from './clock';

describe('unit:clock-epoch', () => {
  it('counts refreshed() calls and notifies; tick() leaves the epoch, refreshed() the anchor', () => {
    let now = 5;
    const clock = createClock(() => now);
    expect(clock.epoch()).toBe(0);
    const cb = vi.fn();
    clock.subscribe(cb);
    clock.refreshed();
    expect(clock.epoch()).toBe(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(clock.anchor()).toBe(5);

    now = 9;
    clock.tick();
    expect(clock.epoch()).toBe(1);
    expect(clock.anchor()).toBe(9);

    now = 12;
    clock.refreshed();
    expect(clock.epoch()).toBe(2);
    expect(clock.anchor()).toBe(9);
    expect(cb).toHaveBeenCalledTimes(3);
  });
});
