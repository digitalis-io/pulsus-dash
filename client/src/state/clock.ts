/**
 * The anchor relative expressions resolve against (T03-017). The anchor moves only on `tick()`: when
 * `from` or `to` changes, on Refresh now and on each auto-refresh tick. Between ticks every view of
 * the Context (header, page summary, copy link) resolves `now` to the same instant.
 */
export interface Clock {
  now: () => number;
  anchor: () => number;
  tick: () => void;
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
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
