/**
 * The left sidebar (D9, IA-021, VL-017): product mark and tenant switcher, main navigation with the
 * Starred and Recent board groups, and a footer with Admin (administrators only), the data-source
 * status line (expanded only) and the collapse control. Collapsed, it is a 56 px icon rail with
 * tooltips.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { motion } from '../styles/tokens';
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
  showLabel,
}: {
  item: NavItem;
  collapsed: boolean;
  /** The visible label: kept while the labels fade out on collapse. */
  showLabel: boolean;
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
      className={cx(styles['link'])}
      aria-current={current ? 'page' : undefined}
      aria-label={collapsed ? label : undefined}
      onPointerEnter={preload}
      onFocus={preload}
    >
      <Icon name={item.icon} />
      {showLabel && <span className={cx(styles['label'])}>{label}</span>}
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

/**
 * The visible state: expanding shows the labels at once (they fade in as the column widens);
 * collapsing keeps them for the width transition so they fade out, then drops them.
 */
function useShownState(state: SidebarState): SidebarState {
  const [shown, setShown] = useState(state);
  const [prev, setPrev] = useState(state);
  if (state !== prev) {
    setPrev(state);
    if (state === 'expanded') setShown('expanded');
  }
  useEffect(() => {
    if (state !== 'collapsed' || shown === 'collapsed') return undefined;
    const id = window.setTimeout(() => {
      setShown('collapsed');
    }, motion.sidebar);
    return () => {
      window.clearTimeout(id);
    };
  }, [state, shown]);
  return state === 'expanded' ? 'expanded' : shown;
}

/**
 * The one current-row indicator: it slides (transform only, through `--indicator-y` in px) to the
 * `aria-current` row of the nav. Until it is placed (and in tests, where nothing has a layout), the
 * row draws its own fill.
 */
function useSelectionIndicator(key: string) {
  const nav = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const root = nav.current;
    const mark = indicator.current;
    if (root === null || mark === null) return undefined;
    const scroller = root.querySelector<HTMLElement>('[data-sidebar-groups]');
    let frame = 0;
    const place = (): void => {
      const row = root.querySelector<HTMLElement>('a[aria-current="page"]');
      if (row === null || row.offsetHeight === 0) {
        delete root.dataset['indicator'];
        return;
      }
      const top = row.getBoundingClientRect().top - root.getBoundingClientRect().top;
      mark.style.setProperty('--indicator-y', String(top));
      if (root.dataset['indicator'] === undefined) {
        // The first placement does not slide in from the top.
        root.dataset['indicator'] = 'placed';
        frame = requestAnimationFrame(() => {
          root.dataset['indicator'] = 'live';
        });
      }
    };
    place();
    scroller?.addEventListener('scroll', place, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(root);
    if (scroller !== null) observer?.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      scroller?.removeEventListener('scroll', place);
      observer?.disconnect();
    };
  }, [key]);
  return { nav, indicator };
}

export interface SidebarProps {
  state: SidebarState;
  onToggle: () => void;
}

export function Sidebar({ state, onToggle }: SidebarProps) {
  const session = useSession();
  const { routeId, tenant } = useShellRoute();
  const { search } = useTimeContext();
  const collapsed = state === 'collapsed';
  const shown = useShownState(state);
  const showLabel = shown === 'expanded';
  const isAdmin = session.user.role === 'admin';
  const { nav: navRef, indicator: indicatorRef } = useSelectionIndicator(
    `${routeId ?? ''}|${tenant}|${shown}`,
  );

  return (
    <aside
      className={cx(styles['sidebar'])}
      data-state={state}
      data-leaving={collapsed && showLabel ? '' : undefined}
    >
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
        {showLabel && <TenantSwitcher collapsed={false} />}
      </div>
      {!showLabel && (
        <div className={cx(styles['rail'])}>
          <TenantSwitcher collapsed />
        </div>
      )}
      <nav ref={navRef} aria-label={t('nav.main')} className={cx(styles['nav'])}>
        <span ref={indicatorRef} className={cx(styles['indicator'])} aria-hidden="true" />
        <div className={cx(styles['groups'])} data-sidebar-groups="">
          <ul className={cx(styles['list'])}>
            <NavLink item={BOARDS} collapsed={collapsed} showLabel={showLabel} />
          </ul>
          {showLabel && <h2 className={cx(styles['heading'])}>{t('nav.explore')}</h2>}
          <ul className={cx(styles['list'])}>
            <NavLink item={METRICS} collapsed={collapsed} showLabel={showLabel} />
            <NavLink item={LOGS} collapsed={collapsed} showLabel={showLabel} />
          </ul>
          {showLabel && <SidebarBoards />}
        </div>
        {isAdmin && (
          <ul className={cx(styles['list'], styles['footerLinks'])}>
            <NavLink item={ADMIN} collapsed={collapsed} showLabel={showLabel} />
          </ul>
        )}
      </nav>
      <div className={cx(styles['footer'])}>
        {showLabel && <DataSourceStatus tenant={session.tenants.find((x) => x.slug === tenant)} />}
        <Button
          variant="ghost"
          className={cx(styles['toggle'])}
          aria-label={t(collapsed ? 'nav.expand' : 'nav.collapse')}
          aria-expanded={!collapsed}
          onPress={onToggle}
        >
          <Icon name={collapsed ? 'panel-left-open' : 'panel-left-close'} />
          {showLabel && <span className={cx(styles['label'])}>{t('nav.collapse')}</span>}
        </Button>
      </div>
    </aside>
  );
}
