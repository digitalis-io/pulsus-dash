/**
 * The render worker's frame loop (plan #68 C1 §4.2): at most one animation frame pending; a tick
 * runs the engine and asks for another while the engine wants one. `wake` schedules a tick from
 * outside the loop (a message, or the engine's own `engine_on_wake` after a device loss or a
 * restore while idle, review r1 #2).
 */
export interface LoopDeps {
  /** One engine tick at `now`; returns whether another frame is wanted. */
  readonly tick: () => boolean;
  readonly requestFrame: (cb: () => void) => number;
}

export interface FrameLoop {
  wake(): void;
}

export function frameLoop(d: LoopDeps): FrameLoop {
  let pending = false;
  const run = (): void => {
    pending = false;
    if (d.tick()) wake();
  };
  const wake = (): void => {
    if (pending) return;
    pending = true;
    d.requestFrame(run);
  };
  return { wake };
}
