/**
 * A polite announcer (T08-018; plan #234 Part 3 §2): the text of one `aria-live="polite"` region
 * that the caller renders. At most one write per 500 ms; the latest text wins; an equal text is
 * cleared and written again on the next write, so it is read once more. Timers are cleared on
 * unmount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** At most one live-region write per this many ms (T08-018). */
export const ANNOUNCE_MS = 500;

export interface PoliteAnnouncer {
  /** The live region's text. */
  readonly text: string;
  readonly announce: (text: string) => void;
}

export function usePoliteAnnouncer(): PoliteAnnouncer {
  const [text, setText] = useState('');
  const last = useRef(-Infinity);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef('');
  const shown = useRef('');

  const write = useCallback((next: string) => {
    last.current = Date.now();
    if (next === shown.current) {
      // The same text again: clear, then write it after a tick so it is read once more.
      shown.current = '';
      setText('');
      setTimeout(() => {
        shown.current = next;
        setText(next);
      }, 0);
      return;
    }
    shown.current = next;
    setText(next);
  }, []);

  const announce = useCallback(
    (next: string) => {
      pending.current = next;
      if (timer.current !== null) return;
      const wait = last.current + ANNOUNCE_MS - Date.now();
      if (wait <= 0) {
        write(next);
        return;
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        write(pending.current);
      }, wait);
    },
    [write],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  return useMemo(() => ({ text, announce }), [text, announce]);
}
