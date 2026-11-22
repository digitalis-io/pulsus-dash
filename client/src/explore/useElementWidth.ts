/**
 * The content width of an element in whole CSS px, through one `ResizeObserver` per attached
 * element (plan #63 Part C §3.1); `null` before the first measure and for a width of 0. The
 * observer is disconnected when the element detaches or the component unmounts.
 */
import { useCallback, useState, type RefCallback } from 'react';

export function useElementWidth<T extends HTMLElement>(): readonly [RefCallback<T>, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const ref = useCallback((el: T | null) => {
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth(w === 0 ? null : w);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      setWidth(null);
    };
  }, []);
  return [ref, width] as const;
}
