/**
 * A list's search field and its committed text (plan #216 Part 2a §3.2; T24-021), shared by the
 * list widgets: `text` is what the field shows; `q`, its trimmed text, is committed 250 ms after
 * the last change. Text with a Cc character (`cc`) commits nothing. `clear()` empties the field and
 * commits `''` at once; a new `initial` (the `query` option) resets both. The timer is cleared on
 * unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const SEARCH_COMMIT_MS = 250;
export const SEARCH_MAX = 100;
/** C0, DEL and C1 controls. */
// eslint-disable-next-line no-control-regex -- the Cc characters are what it matches
export const HAS_CC = /[\u0000-\u001F\u007F-\u009F]/u;

export interface SearchCommit {
  readonly text: string;
  readonly q: string;
  readonly cc: boolean;
  readonly setText: (v: string) => void;
  readonly clear: () => void;
}

export function useSearchCommit(initial: string): SearchCommit {
  const [state, setState] = useState(() => ({ initial, text: initial, q: initial.trim() }));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  // A new option resets the field (adjusted while rendering, as `useDelayedFlag`).
  let current = state;
  if (state.initial !== initial) {
    current = { initial, text: initial, q: initial.trim() };
    setState(current);
  }
  useEffect(() => stop, [stop, initial]);

  const setText = useCallback(
    (v: string) => {
      stop();
      setState((s) => ({ ...s, text: v }));
      if (HAS_CC.test(v)) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        setState((s) => (s.text === v ? { ...s, q: v.trim() } : s));
      }, SEARCH_COMMIT_MS);
    },
    [stop],
  );
  const clear = useCallback(() => {
    stop();
    setState((s) => ({ ...s, text: '', q: '' }));
  }, [stop]);
  return { text: current.text, q: current.q, cc: HAS_CC.test(current.text), setText, clear };
}
