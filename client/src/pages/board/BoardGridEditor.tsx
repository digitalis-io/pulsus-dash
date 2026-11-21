/**
 * The Edit-mode grid (plan #61 Part B §4.3), loaded lazily: `react-grid-layout` with the View
 * grid's numbers (12 columns, 40 px rows, 16 px gaps, no padding), so panels do not move when the
 * mode changes. No compaction and no pushing: a drop onto another panel is refused and gaps stay,
 * as with the keyboard. A drop is reported only when the moved panel fits the server's limits and
 * overlaps nothing; otherwise the grid is reset to the draft and `onBlocked` announces it.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  GridLayout,
  noCompactor,
  useContainerWidth,
  type Compactor,
  type EventCallback,
  type Layout,
} from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import type { PanelSpec } from '../../api/types';
import type { LayoutItem } from '../../boards/editorState';
import { COLS, GAP, GRID_LIMITS, placeable, ROW } from '../../boards/layout';
import { cx } from '../../kit/cx';
import styles from './Board.module.css';

export interface BoardGridEditorProps {
  panels: readonly PanelSpec[];
  /** A save is in flight: no drag and no resize. */
  readOnly: boolean;
  /** The panels the pointer moved or resized (only those). */
  onLayout: (items: LayoutItem[]) => void;
  /** A drop that does not fit or overlaps; `panel` is unchanged. */
  onBlocked: (panel: PanelSpec) => void;
  renderPanel: (panel: PanelSpec) => ReactNode;
}

const COMPACTOR: Compactor = { ...noCompactor, preventCollision: true };
const GRID_CONFIG = {
  cols: COLS,
  rowHeight: ROW,
  margin: [GAP, GAP] as const,
  containerPadding: [0, 0] as const,
  maxRows: GRID_LIMITS.maxBottom,
};
const RESIZE_HANDLES = ['se'] as const;

/**
 * react-draggable adds a `<style id="react-draggable-style-el">` filled through `innerHTML` when a
 * drag starts, which Trusted Types blocks (T18-004), so the drag would never start. It skips that
 * when an element with the id exists. An empty `<style>` would still be an inline style under the
 * CSP (`style-src 'self'`), so the marker is an inert `<meta>`; `Board.module.css` holds the same
 * selection rules.
 */
const DRAGGABLE_STYLE_ID = 'react-draggable-style-el';

function useDraggableStyleElement(): void {
  useEffect(() => {
    if (document.getElementById(DRAGGABLE_STYLE_ID) !== null) return;
    const el = document.createElement('meta');
    el.id = DRAGGABLE_STYLE_ID;
    document.head.append(el);
  }, []);
}

export function BoardGridEditor({
  panels,
  readOnly,
  onLayout,
  onBlocked,
  renderPanel,
}: BoardGridEditorProps) {
  useDraggableStyleElement();
  const { width, containerRef, mounted } = useContainerWidth();
  // Bumped when a drop is refused: a fresh grid shows the draft again.
  const [revision, setRevision] = useState(0);
  const layout: Layout = useMemo(
    () => panels.map((p) => ({ i: p.id, x: p.grid.x, y: p.grid.y, w: p.grid.w, h: p.grid.h })),
    [panels],
  );

  const stop: EventCallback = (next, oldItem) => {
    if (oldItem === null) return;
    const panel = panels.find((p) => p.id === oldItem.i);
    const item = next.find((l) => l.i === oldItem.i);
    if (panel === undefined || item === undefined) return;
    const g = { x: item.x, y: item.y, w: item.w, h: item.h };
    const p = panel.grid;
    if (g.x === p.x && g.y === p.y && g.w === p.w && g.h === p.h) return;
    if (!placeable(g, panels, panel.id)) {
      setRevision((r) => r + 1);
      onBlocked(panel);
      return;
    }
    onLayout([{ i: panel.id, ...g }]);
  };

  return (
    <div ref={containerRef} className={cx(styles['gridEditor'])} data-board-grid="">
      {mounted && (
        <GridLayout
          key={revision}
          width={width}
          gridConfig={GRID_CONFIG}
          dragConfig={{
            enabled: !readOnly,
            handle: '[data-drag-handle]',
            cancel: 'button, a, input, textarea, [role="menuitem"]',
            threshold: 3,
          }}
          resizeConfig={{ enabled: !readOnly, handles: RESIZE_HANDLES }}
          compactor={COMPACTOR}
          layout={layout}
          onDragStop={stop}
          onResizeStop={stop}
        >
          {panels.map((p) => (
            <div key={p.id} className={cx(styles['item'])}>
              {renderPanel(p)}
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}

export default BoardGridEditor;
