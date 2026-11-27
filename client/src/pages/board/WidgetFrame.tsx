/**
 * A widget panel's frame on a board (plan #198 Part 1 §4.2; T24-002): the panel chrome with the
 * title, the Panel menu and, in Edit mode, Move or resize, around the widget's body. A widget has no
 * query, so no run, viewport tracking, `ChartFrame`, Inspector, Explore, Copy query or Full screen.
 * The menu has Edit panel when the registry has a def for the kind (Part 3a §4.4), "Show as table" /
 * "Show list" for a kind with a table view (`TABLE_WIDGETS`, plan #216 Part 2a), then Duplicate
 * and Remove.
 */
import { forwardRef, useContext, useId, useState } from 'react';
import { MenuTrigger, type ButtonProps } from 'react-aria-components';
import type { WidgetPanelSpec } from '../../api/types';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { IconButton } from '../../kit/IconButton';
import { Menu, MenuItem } from '../../kit/Menu';
import { Popover } from '../../kit/Popover';
import { useWidgetDef } from '../../widgets/registry';
import { TABLE_WIDGETS } from '../../widgets/spec';
import { WidgetBody } from '../../widgets/WidgetBody';
import styles from './Board.module.css';
import { BoardModeContext } from './boardMode';
import {
  keyOp,
  PanelHeader,
  PanelLayoutTool,
  panelTitle,
  type PanelFrameProps,
} from './PanelFrame';

export type WidgetFrameProps = Omit<PanelFrameProps, 'panel'> & { panel: WidgetPanelSpec };

export const WidgetFrame = forwardRef<HTMLElement, WidgetFrameProps>(function WidgetFrame(
  { panel, readOnly, selected, onEdit, onKeyOp, onDuplicate, onRemove, className },
  ref,
) {
  const headingId = useId();
  const def = useWidgetDef(panel.vis.kind);
  const editing = useContext(BoardModeContext) === 'edit';
  const [table, setTable] = useState(false);
  const tabled = TABLE_WIDGETS.has(panel.vis.kind);
  const title = panelTitle(panel);
  const g = panel.grid;
  const onLayoutKey = (e: Parameters<NonNullable<ButtonProps['onKeyDown']>>[0]): void => {
    const op = keyOp(e);
    if (op === null) {
      // Other keys (Tab, the board keys) carry on to their handlers.
      e.continuePropagation();
      return;
    }
    e.preventDefault();
    onKeyOp(panel.id, op);
  };
  return (
    <section
      ref={ref}
      className={cx(styles['panel'], className)}
      aria-labelledby={headingId}
      tabIndex={-1}
      data-panel={panel.id}
      data-panel-id={panel.id}
      data-grid={[g.x, g.y, g.w, g.h].join(',')}
      data-vis={panel.vis.kind}
      data-panel-state="widget"
      data-widget=""
      data-selected={selected ? '' : undefined}
    >
      <PanelHeader>
        <div className={cx(styles['titles'])}>
          <h3
            id={headingId}
            className={cx(styles['title'], panel.title === '' ? styles['untitled'] : undefined)}
            title={title}
          >
            {title}
          </h3>
        </div>
        <div className={cx(styles['tools'])}>
          <MenuTrigger>
            <IconButton
              icon="ellipsis"
              aria-label={t('panel.menu', { title })}
              data-panel-menu=""
            />
            <Popover placement="bottom end">
              <Menu aria-label={t('panel.menu', { title })}>
                {def !== undefined && (
                  <MenuItem
                    id="edit"
                    onAction={() => {
                      onEdit(panel.id);
                    }}
                  >
                    {t('panel.editPanel')}
                  </MenuItem>
                )}
                {tabled && (
                  <MenuItem
                    id="table"
                    onAction={() => {
                      setTable((on) => !on);
                    }}
                  >
                    {t(table ? 'panel.menu.list' : 'panel.menu.table')}
                  </MenuItem>
                )}
                <MenuItem
                  id="duplicate"
                  isDisabled={readOnly}
                  onAction={() => {
                    onDuplicate(panel.id);
                  }}
                >
                  {t('panel.duplicate')}
                </MenuItem>
                <MenuItem
                  id="remove"
                  isDisabled={readOnly}
                  onAction={() => {
                    onRemove(panel.id);
                  }}
                >
                  {t('panel.remove')}
                </MenuItem>
              </Menu>
            </Popover>
          </MenuTrigger>
          <PanelLayoutTool title={title} readOnly={readOnly} onKeyDown={onLayoutKey} />
        </div>
      </PanelHeader>
      <div className={cx(styles['body'])}>
        <WidgetBody
          panel={panel}
          headingId={headingId}
          editing={editing}
          table={table}
          onTable={setTable}
        />
      </div>
    </section>
  );
});
