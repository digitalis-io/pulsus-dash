/**
 * The application shell (D9, ADR-0014 §10): skip link, collapsible sidebar, page header and the
 * scrolling page body; under the header, the ST engine's banner (plan #68 C2d2). Owns the window
 * keys and auto-refresh, which act on the URL time Context.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Outlet } from 'react-router';
import { useShellFocusRequest } from '../app/providers';
import { engineMode, onEngineMode } from '../engine/mode';
import { useAutoRefresh } from '../state/useAutoRefresh';
import { useTimeContext } from '../state/useTimeContext';
import { useWindowKeys } from '../state/useWindowKeys';
import { safeStorage } from '../theme/theme';
import { EngineModeBanner } from './EngineModeBanner';
import { Header } from './Header';
import { PageTitleProvider } from './PageTitle';
import { Sidebar } from './Sidebar';
import { readSidebarState, writeSidebarState, type SidebarState } from './sidebarState';
import { SkipLink } from './SkipLink';
import styles from './AppShell.module.css';
import { cx } from '../kit/cx';

export function AppShell() {
  const time = useTimeContext();
  const focusRequest = useShellFocusRequest();
  const mainRef = useRef<HTMLElement>(null);
  const [sidebar, setSidebar] = useState<SidebarState>(() => readSidebarState(safeStorage()));
  // Plan #68 C2d2 §4.4: the ST engine's banner, once per page.
  const mode = useSyncExternalStore(onEngineMode, engineMode);
  useWindowKeys(time.dispatch);
  useAutoRefresh(time.search.refresh, time.refreshNow);

  useEffect(() => {
    performance.mark('shell-ready');
    document.documentElement.dataset['shellReady'] = 'true';
    if (focusRequest.consume()) mainRef.current?.focus();
  }, [focusRequest]);

  const toggle = (): void => {
    const next: SidebarState = sidebar === 'collapsed' ? 'expanded' : 'collapsed';
    writeSidebarState(safeStorage(), next);
    setSidebar(next);
  };

  return (
    <PageTitleProvider>
      <SkipLink />
      <div className={cx(styles['shell'])} data-sidebar={sidebar}>
        <Sidebar state={sidebar} onToggle={toggle} />
        <div className={cx(styles['column'])}>
          <Header />
          <EngineModeBanner mode={mode} />
          <main id="main" ref={mainRef} tabIndex={-1} className={cx(styles['main'])}>
            <Outlet />
          </main>
        </div>
      </div>
    </PageTitleProvider>
  );
}
