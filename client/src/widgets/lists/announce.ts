/**
 * A list widget's polite announcements (plan #216 Part 2a §4.5; T08-018, T24-025): at most one
 * write per 2 s, the latest pending text wins, a repeat of the last write is dropped, and unmount
 * clears the timer. `text` is the live region's content.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export const ANNOUNCE_GAP_MS = 2000;

export function useListAnnouncer(): { text: string; announce: (s: string) => void } {
  const [text, setText] = useState('');
  const last = useRef({ text: '', at: -Infinity });
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next === null || next === last.current.text) return;
    last.current = { text: next, at: Date.now() };
    setText(next);
  }, []);

  const announce = useCallback(
    (s: string) => {
      pending.current = s;
      if (timer.current !== null) return;
      const wait = last.current.at + ANNOUNCE_GAP_MS - Date.now();
      if (wait <= 0) flush();
      else timer.current = setTimeout(flush, wait);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  return { text, announce };
}
