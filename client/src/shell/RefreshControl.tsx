/**
 * The refresh split control (IA-020): "Refresh now" and the auto-refresh interval menu. Choosing an
 * interval replaces the history entry (it does not change the view).
 */
import { Button, MenuTrigger } from 'react-aria-components';
import { refreshLabel } from '../i18n/format';
import { t } from '../i18n/t';
import { Icon } from '../kit/Icon';
import { IconButton } from '../kit/IconButton';
import { Menu, MenuItem } from '../kit/Menu';
import { Popover } from '../kit/Popover';
import { REFRESH_INTERVALS } from '../state/contextSearch';
import { useTimeContext } from '../state/useTimeContext';
import styles from './RefreshControl.module.css';
import { cx } from '../kit/cx';

export function RefreshControl() {
  const { search, dispatch, refreshNow } = useTimeContext();
  const off = search.refresh === 'off';
  const label = refreshLabel(search.refresh);
  return (
    <div role="group" aria-label={t('refresh.group')} className={cx(styles['group'])}>
      <IconButton
        icon="refresh-cw"
        aria-label={t('refresh.now')}
        onPress={refreshNow}
        className={cx(styles['now'])}
      />
      <span className={cx(styles['divider'])} aria-hidden="true" />
      <MenuTrigger>
        <Button aria-label={t('refresh.interval', { label })} className={cx(styles['interval'])}>
          {!off && <span className={cx(styles['live'])} aria-hidden="true" />}
          <span>{label}</span>
          <Icon name="chevron-down" className={cx(styles['chevron'])} />
        </Button>
        <Popover placement="bottom end">
          <Menu
            aria-label={t('refresh.menu')}
            selectionMode="single"
            selectedKeys={[search.refresh]}
          >
            {REFRESH_INTERVALS.map((r) => (
              <MenuItem
                key={r}
                id={r}
                onAction={() => {
                  dispatch({ type: 'setRefresh', refresh: r }, { replace: true });
                }}
              >
                {refreshLabel(r)}
              </MenuItem>
            ))}
          </Menu>
        </Popover>
      </MenuTrigger>
    </div>
  );
}
