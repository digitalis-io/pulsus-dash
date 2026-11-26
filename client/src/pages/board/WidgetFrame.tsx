/**
 * A widget panel's frame on a board (plan #198 Part 1 §4.2; T24-002): the panel chrome with the
 * title, the Panel menu (Duplicate, Remove) and, in Edit mode, Move or resize, around the widget's
 * body. A widget has no query, so no run, viewport tracking, `ChartFrame`, Inspector, Explore, Copy
 * query or Full screen; Part 3 adds Edit to its menu.
 */
import { forwardRef, useId } from 'react';
import { MenuTrigger, type ButtonProps } from 'react-aria-components';
import type { WidgetPanelSpec } from '../../api/types';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { IconButton } from '../../kit/IconButton';
import { Menu, MenuItem } from '../../kit/Menu';
import { Popover } from '../../kit/Popover';
import { WidgetBody } from '../../widgets/WidgetBody';
import styles from './Board.module.css';
import {
  keyOp,
  PanelHeader,
  PanelLayoutTool,
  panelTitle,
  type PanelFrameProps,
} from './PanelFrame';

export type WidgetFrameProps = Omit<PanelFrameProps, 'panel'> & { panel: WidgetPanelSpec };

export const WidgetFrame = forwardRef<HTMLElement, WidgetFrameProps>(function WidgetFrame(
  { panel, readOnly, selected, onKeyOp, onDuplicate, onRemove, className },
  ref,
) {
  const headingId = useId();
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
        <WidgetBody panel={panel} />
      </div>
    </section>
  );
});
