/**
 * The anchor relative expressions resolve against (T03-017). The anchor moves only on `tick()`: when
 * `from` or `to` changes, on Refresh now and on each auto-refresh tick. Between ticks every view of
 * the Context (header, page summary, copy link) resolves `now` to the same instant.
 *
 * The refresh epoch (plan #66 Part C §3.3) counts the refreshes that moved no window, so a run
 * held outside TanStack Query (the log pager) can rerun under a fixed window.
 */
export interface Clock {
  now: () => number;
  anchor: () => number;
  tick: () => void;
  /** The count of `refreshed()` calls since creation; starts at 0. */
  epoch: () => number;
  /** epoch + 1, then every listener is called. Never changes the anchor. */
  refreshed: () => void;
  subscribe: (cb: () => void) => () => void;
}

export function createClock(nowFn: () => number = Date.now): Clock {
  let anchor = nowFn();
  let epoch = 0;
  const listeners = new Set<() => void>();
  return {
    now: () => nowFn(),
    anchor: () => anchor,
    tick() {
      anchor = nowFn();
      for (const cb of [...listeners]) cb();
    },
    epoch: () => epoch,
    refreshed() {
      epoch += 1;
      for (const cb of [...listeners]) cb();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
