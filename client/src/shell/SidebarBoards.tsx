/** The Starred and Recent board groups of the sidebar (IA-021). */
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { Link } from 'react-router';
import { preloadRoute } from '../app/routeModules';
import { useApi } from '../app/providers';
import type { BoardSummary } from '../api/types';
import { t } from '../i18n/t';
import { safeStorage } from '../theme/theme';
import { contextSearchString } from '../state/contextSearch';
import { useTimeContext } from '../state/useTimeContext';
import { readRecent, subscribeRecent } from './recentBoards';
import { useShellRoute } from './useShellRoute';
import styles from './Sidebar.module.css';
import { cx } from '../kit/cx';

export function useBoards(tenant: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['boards', tenant],
    queryFn: ({ signal }) => api.listBoards(tenant, signal),
  });
}

export function useStarred(tenant: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['starred', tenant],
    queryFn: ({ signal }) => api.listStarred(tenant, signal),
  });
}

function useRecent(tenant: string): string {
  // The serialised list, so the snapshot is stable between pushes.
  return useSyncExternalStore(subscribeRecent, () =>
    JSON.stringify(readRecent(safeStorage(), tenant)),
  );
}

function BoardLinks({
  boards,
  tenant,
  empty,
  star = false,
}: {
  boards: readonly BoardSummary[];
  tenant: string;
  empty: string;
  star?: boolean;
}) {
  const { search } = useTimeContext();
  if (boards.length === 0) return <p className={cx(styles['empty'])}>{empty}</p>;
  return (
    <ul className={cx(styles['list'])}>
      {boards.map((b) => (
        <li key={b.uid}>
          <Link
            to={{ pathname: `/t/${tenant}/board/${b.uid}`, search: contextSearchString(search) }}
            className={cx(styles['link'], styles['nested'])}
            onPointerEnter={() => {
              preloadRoute('board');
            }}
            onFocus={() => {
              preloadRoute('board');
            }}
          >
            {star && (
              <span className={cx(styles['star'])} aria-hidden="true">
                ★
              </span>
            )}
            <span className={cx(styles['label'])}>{b.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SidebarBoards() {
  const { tenant } = useShellRoute();
  const boards = useBoards(tenant);
  const starred = useStarred(tenant);
  const recentJson = useRecent(tenant);
  const all = boards.data?.items ?? [];
  const starredSet = new Set(starred.data ?? []);
  const starredBoards = all.filter((b) => starredSet.has(b.uid));
  const byUid = new Map(all.map((b) => [b.uid, b]));
  const recentBoards = (JSON.parse(recentJson) as string[])
    .map((u) => byUid.get(u))
    .filter((b): b is BoardSummary => b !== undefined);
  const ready = boards.isSuccess;

  return (
    <>
      <h2 className={cx(styles['heading'])}>{t('nav.starred')}</h2>
      {ready && starred.isSuccess && (
        <BoardLinks boards={starredBoards} tenant={tenant} empty={t('nav.starredEmpty')} star />
      )}
      <h2 className={cx(styles['heading'])}>{t('nav.recent')}</h2>
      {ready && <BoardLinks boards={recentBoards} tenant={tenant} empty={t('nav.recentEmpty')} />}
    </>
  );
}
