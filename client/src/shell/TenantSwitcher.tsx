/**
 * Org and tenant block at the top of the sidebar (IA-021). With two or more tenant bindings, the
 * tenant name is a menu button listing them; choosing one opens that tenant's Boards with the
 * current time Context. With one binding it is static text. Collapsed, it is a 32 px org-initial
 * button (or nothing). The org name and the "Tenant:" prefix stay outside the button, so the
 * button's visible text is part of its accessible name (WCAG 2.5.3).
 */
import { Button, MenuTrigger } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { useSession } from '../app/providers';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { Icon } from '../kit/Icon';
import { Menu, MenuItem } from '../kit/Menu';
import { Popover } from '../kit/Popover';
import { contextSearchString } from '../state/contextSearch';
import { useTimeContext } from '../state/useTimeContext';
import { useShellRoute } from './useShellRoute';
import styles from './TenantSwitcher.module.css';

export function TenantSwitcher({ collapsed }: { collapsed: boolean }) {
  const session = useSession();
  const { tenant } = useShellRoute();
  const { search } = useTimeContext();
  const navigate = useNavigate();
  const current = session.tenants.find((x) => x.slug === tenant) ?? session.tenants[0];
  const name = current?.name ?? tenant;
  const org = session.org.name;

  if (session.tenants.length < 2) {
    if (collapsed) return null;
    return (
      <div className={cx(styles['block'])}>
        <span className={cx(styles['org'])}>{org}</span>
        <span className={cx(styles['tenant'])}>{t('tenant.label', { name })}</span>
      </div>
    );
  }

  const choose = (slug: string): void => {
    if (slug === tenant) return;
    void navigate(`/t/${slug}/boards${contextSearchString(search)}`);
  };

  const menu = (
    <MenuTrigger>
      <Button
        aria-label={t('tenant.switch', { name })}
        className={cx(collapsed ? styles['badge'] : styles['trigger'])}
      >
        {collapsed ? (
          <span aria-hidden="true">{org.slice(0, 1).toUpperCase()}</span>
        ) : (
          <>
            <span className={cx(styles['current'])}>{name}</span>
            <Icon name="chevron-down" className={cx(styles['chevron'])} />
          </>
        )}
      </Button>
      <Popover placement={collapsed ? 'end top' : 'bottom start'}>
        <Menu aria-label={t('tenant.menu')} selectionMode="single" selectedKeys={[tenant]}>
          {session.tenants.map((x) => (
            <MenuItem
              key={x.slug}
              id={x.slug}
              onAction={() => {
                choose(x.slug);
              }}
            >
              {x.name}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );

  if (collapsed) return menu;
  return (
    <div className={cx(styles['block'])}>
      <span className={cx(styles['org'])}>{org}</span>
      <span className={cx(styles['line'])}>
        <span className={cx(styles['tenant'])}>{t('tenant.prefix')}</span>
        {menu}
      </span>
    </div>
  );
}
