/**
 * The left sidebar (D9, IA-021, VL-017): product mark and tenant switcher, main navigation with the
 * Starred and Recent board groups, and a footer with Admin (administrators only), the data-source
 * status line (expanded only) and the collapse control. Collapsed, it is a 56 px icon rail with
 * tooltips.
 */
import { Focusable } from 'react-aria-components';
import { Link } from 'react-router';
import { preloadRoute, type RouteModuleId } from '../app/routeModules';
import { useSession } from '../app/providers';
import { t, type MessageId } from '../i18n/t';
import { Button } from '../kit/Button';
import { Icon, type IconName } from '../kit/Icon';
import { Tooltip } from '../kit/Tooltip';
import { contextSearchString } from '../state/contextSearch';
import { useTimeContext } from '../state/useTimeContext';
import type { SidebarState } from './sidebarState';
import { DataSourceStatus } from './DataSourceStatus';
import { SidebarBoards } from './SidebarBoards';
import { TenantSwitcher } from './TenantSwitcher';
import { useShellRoute } from './useShellRoute';
import styles from './Sidebar.module.css';
import { cx } from '../kit/cx';

interface NavItem {
  label: MessageId;
  icon: IconName;
  path: string;
  module: RouteModuleId;
  /** Route ids for which the item is the current page. */
  ids: readonly string[];
}

const BOARDS: NavItem = {
  label: 'nav.boards',
  icon: 'layout-dashboard',
  path: 'boards',
  module: 'boards',
  ids: ['boards', 'board'],
};
const METRICS: NavItem = {
  label: 'nav.metrics',
  icon: 'chart-line',
  path: 'explore/metrics',
  module: 'metrics',
  ids: ['metrics'],
};
const LOGS: NavItem = {
  label: 'nav.logs',
  icon: 'scroll-text',
  path: 'explore/logs',
  module: 'logs',
  ids: ['logs'],
};
const ADMIN: NavItem = {
  label: 'nav.admin',
  icon: 'settings',
  path: 'admin',
  module: 'admin',
  ids: ['admin'],
};

function NavLink({
  item,
  collapsed,
  nested = false,
}: {
  item: NavItem;
  collapsed: boolean;
  nested?: boolean;
}) {
  const { routeId, tenant } = useShellRoute();
  const { search } = useTimeContext();
  const current = routeId !== undefined && item.ids.includes(routeId);
  const label = t(item.label);
  const preload = (): void => {
    preloadRoute(item.module);
  };
  const link = (
    <Link
      to={{ pathname: `/t/${tenant}/${item.path}`, search: contextSearchString(search) }}
      className={cx(styles['link'], nested && !collapsed ? styles['nested'] : undefined)}
      aria-current={current ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      onPointerEnter={preload}
      onFocus={preload}
    >
      <Icon name={item.icon} />
      {!collapsed && <span className={cx(styles['label'])}>{label}</span>}
    </Link>
  );
  return (
    <li>
      <Tooltip label={label} isEnabled={collapsed}>
        <Focusable>{link}</Focusable>
      </Tooltip>
    </li>
  );
}

export interface SidebarProps {
  state: SidebarState;
  onToggle: () => void;
}

export function Sidebar({ state, onToggle }: SidebarProps) {
  const session = useSession();
  const { tenant } = useShellRoute();
  const { search } = useTimeContext();
  const collapsed = state === 'collapsed';
  const isAdmin = session.user.role === 'admin';

  return (
    <aside className={cx(styles['sidebar'])} data-state={state}>
      <div className={cx(styles['top'])}>
        <Link
          to={{ pathname: `/t/${tenant}/boards`, search: contextSearchString(search) }}
          className={cx(styles['mark'])}
          aria-label={t('nav.home')}
          onPointerEnter={() => {
            preloadRoute('boards');
          }}
        >
          <Icon name="activity" className={cx(styles['markIcon'])} />
        </Link>
        {!collapsed && <TenantSwitcher collapsed={false} />}
      </div>
      {collapsed && (
        <div className={cx(styles['rail'])}>
          <TenantSwitcher collapsed />
        </div>
      )}
      <nav aria-label={t('nav.main')} className={cx(styles['nav'])}>
        <div className={cx(styles['groups'])}>
          <ul className={cx(styles['list'])}>
            <NavLink item={BOARDS} collapsed={collapsed} />
          </ul>
          {!collapsed && <h2 className={cx(styles['heading'])}>{t('nav.explore')}</h2>}
          <ul className={cx(styles['list'])}>
            <NavLink item={METRICS} collapsed={collapsed} nested />
            <NavLink item={LOGS} collapsed={collapsed} nested />
          </ul>
          {!collapsed && <SidebarBoards />}
        </div>
        {isAdmin && (
          <ul className={cx(styles['list'], styles['footerLinks'])}>
            <NavLink item={ADMIN} collapsed={collapsed} />
          </ul>
        )}
      </nav>
      <div className={cx(styles['footer'])}>
        {!collapsed && <DataSourceStatus tenant={session.tenants.find((x) => x.slug === tenant)} />}
        <Button
          variant="ghost"
          className={cx(styles['toggle'])}
          aria-label={t(collapsed ? 'nav.expand' : 'nav.collapse')}
          aria-expanded={!collapsed}
          onPress={onToggle}
        >
          <Icon name={collapsed ? 'panel-left-open' : 'panel-left-close'} />
          {!collapsed && <span className={cx(styles['label'])}>{t('nav.collapse')}</span>}
        </Button>
      </div>
    </aside>
  );
}
