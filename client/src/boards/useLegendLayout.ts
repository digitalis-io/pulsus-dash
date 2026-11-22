/**
 * A board panel legend's layout (plan #64 Part B §3.9, §4.5): `table` when the observed content
 * height of the panel's frame stack is at least `size.board-legend-table-min` (240 px) or not yet
 * measured, `compact` below. One `ResizeObserver` per attached stack (content box), as
 * `useElementWidth`; the stack fills the panel body, so the legend's own layout does not change it.
 */
import { useCallback, useState, type RefCallback } from 'react';
import { size } from '../styles/tokens';

export function useLegendLayout(): [RefCallback<HTMLElement>, 'table' | 'compact'] {
  const [height, setHeight] = useState<number | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      // 0: not laid out (yet); measured as not measured.
      setHeight(h > 0 ? h : null);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      setHeight(null);
    };
  }, []);
  return [ref, height === null || height >= size['board-legend-table-min'] ? 'table' : 'compact'];
}
