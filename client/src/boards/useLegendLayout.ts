/**
 * A board panel legend's layout (plan #64 Part B §3.9, §4.5): `table` when the observed content
 * height of the panel's frame stack is at least `size.board-legend-table-min` (240 px) or not yet
 * measured, `compact` below. One `ResizeObserver` per attached stack (content box), as
 * `useElementWidth`; the stack fills the panel body, so the legend's own layout does not change it.
 *
 * The stack is also measured once when it attaches, in the commit, so the layout is final before
 * the panel's chart mounts: `measured` turns true then, and the chart that waits for it is sized
 * once and draws in its first frame (#90, ADR-0019).
 */
import { useCallback, useState, type RefCallback } from 'react';
import { size } from '../styles/tokens';

interface Measure {
  readonly attached: boolean;
  /** The content height; null when not laid out (0). */
  readonly height: number | null;
}

const DETACHED: Measure = { attached: false, height: null };

export function useLegendLayout(): [RefCallback<HTMLElement>, 'table' | 'compact', boolean] {
  const [m, setM] = useState<Measure>(DETACHED);
  const ref = useCallback((el: HTMLElement | null) => {
    if (el === null) return;
    const set = (h: number): void => {
      const height = h > 0 ? h : null;
      setM((prev) => (prev.attached && prev.height === height ? prev : { attached: true, height }));
    };
    // The stack has no padding or border: its box height is its content height.
    set(el.getBoundingClientRect().height);
    const ro = new ResizeObserver((entries) => {
      set(entries[0]?.contentRect.height ?? 0);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      setM(DETACHED);
    };
  }, []);
  const layout =
    m.height === null || m.height >= size['board-legend-table-min'] ? 'table' : 'compact';
  return [ref, layout, m.attached];
}
