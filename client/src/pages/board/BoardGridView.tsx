/**
 * The View-mode grid (plan #61 Part B §4.3): each panel absolutely positioned from its grid cell
 * through `--gx --gy --gw --gh`, set in CSSOM in a layout effect (T08-023); the container height
 * comes from `--gbottom`. DOM order is `(y, x)`. Any layout the server accepts (rows up to
 * 10 099) renders. Also the Suspense fallback of the Edit grid, so both place panels alike.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { PanelSpec } from '../../api/types';
import { cx } from '../../kit/cx';
import styles from './Board.module.css';

/** `(y, x)` order. */
export function readingOrder(panels: readonly PanelSpec[]): PanelSpec[] {
  return [...panels].sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x);
}

function bottom(panels: readonly PanelSpec[]): number {
  return Math.max(0, ...panels.map((p) => p.grid.y + p.grid.h));
}

/** Places a panel from its grid cell (CSSOM, T08-023). */
function place(el: HTMLElement, p: PanelSpec): void {
  el.style.setProperty('--gx', String(p.grid.x));
  el.style.setProperty('--gy', String(p.grid.y));
  el.style.setProperty('--gw', String(p.grid.w));
  el.style.setProperty('--gh', String(p.grid.h));
}

export function BoardGridView({
  panels,
  renderPanel,
}: {
  panels: readonly PanelSpec[];
  /** Renders a panel's root with `className` and the ref callback that places it. */
  renderPanel: (
    panel: PanelSpec,
    place: (el: HTMLElement | null) => void,
    className: string,
  ) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const height = bottom(panels);
  useLayoutEffect(() => {
    ref.current?.style.setProperty('--gbottom', String(height));
  }, [height]);

  return (
    <div ref={ref} className={cx(styles['grid'])} data-board-grid="">
      {readingOrder(panels).map((p) =>
        renderPanel(
          p,
          (el) => {
            if (el !== null) place(el, p);
          },
          cx(styles['placed']),
        ),
      )}
    </div>
  );
}
