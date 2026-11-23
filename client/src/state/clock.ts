/**
 * The anchor relative expressions resolve against (T03-017). The anchor moves only on `tick()`: when
 * `from` or `to` changes, on Refresh now and on each auto-refresh tick. Between ticks every view of
 * the Context (header, page summary, copy link) resolves `now` to the same instant.
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
  const listeners = new Set<() => void>();
  return {
    now: () => nowFn(),
    anchor: () => anchor,
    tick() {
      anchor = nowFn();
      for (const cb of [...listeners]) cb();
    },
    // Stub (plan #66 Part C §3.3): implemented after the failing tests.
    epoch: () => 0,
    refreshed() {
      return undefined;
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
