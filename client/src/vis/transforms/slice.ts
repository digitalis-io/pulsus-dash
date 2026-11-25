/**
 * Time-sliced scans (T21-016): work checks the clock every so often and yields to the event loop
 * once a step reaches `STEP_MS`, so no task holds the main thread longer than one step.
 */

/** The clock, the abort signal and (tests) the yield of a sliced scan. */
export interface Slicer {
  now(): number;
  readonly signal: AbortSignal;
  /** Defaults to `yieldToMain`. */
  yieldNow?(): Promise<void>;
}

/** The longest step in ms before a scan yields. */
export const STEP_MS = 8;

/** One `MessageChannel` round trip: lets input, rendering and other tasks run. */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** An `AbortError` (`DOMException`), as `fetch` rejects with. */
export function abortError(): DOMException {
  return new DOMException('The histogram work was superseded', 'AbortError');
}

/**
 * Yields when `now() − start ≥ STEP_MS` and returns the new step start (or `start`). Throws an
 * `AbortError` when the signal is aborted, before and after the yield.
 */
export async function checkStep(s: Slicer, start: number): Promise<number> {
  if (s.signal.aborted) throw abortError();
  if (s.now() - start < STEP_MS) return start;
  await (s.yieldNow ? s.yieldNow() : yieldToMain());
  if (s.signal.aborted) throw abortError();
  return s.now();
}
