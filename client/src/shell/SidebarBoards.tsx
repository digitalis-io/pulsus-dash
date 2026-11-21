/** The Starred and Recent board groups of the sidebar (IA-021), from the BFF (plan #61 Part C). */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { preloadRoute } from '../app/routeModules';
import { useApi } from '../app/providers';
import type { BoardRef } from '../api/types';
import { t } from '../i18n/t';
import { contextSearchString } from '../state/contextSearch';
import { useTimeContext } from '../state/useTimeContext';
import { useShellRoute } from './useShellRoute';
import styles from './Sidebar.module.css';
import { cx } from '../kit/cx';

/**
 * The history state of a board link (plan #61 Part B §4.2): the board page applies the board's
 * saved time range once, then clears the state. Deep links and reloads have none (IA-022).
 */
export interface BoardLinkState {
  applySavedTime: true;
  /** New board: open in Edit mode. */
  edit?: true;
}

export const BOARD_LINK_STATE: BoardLinkState = { applySavedTime: true };

export function useBoards(tenant: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['boards', tenant],
    queryFn: ({ signal }) => api.listBoards(tenant, signal),
  });
}

/**
 * Starred, from the BFF (plan #61 Part C §4.5). Refetched on every return to the tab, whatever its
 * age (the app default is no focus refetch), so another browser's change shows; another tab of
 * this profile invalidates it through `BoardPrefs`.
 */
export function useStarred(tenant: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['starred', tenant],
    queryFn: ({ signal }) => api.listStarred(tenant, signal),
    refetchOnWindowFocus: 'always',
  });
}

/** Recent, from the BFF, newest first; refetched as Starred is. */
export function useRecent(tenant: string) {
  const api = useApi();
  return useQuery({
    queryKey: ['recent', tenant],
    queryFn: ({ signal }) => api.listRecent(tenant, signal),
    refetchOnWindowFocus: 'always',
  });
}

/** Links carry the time Context only: the board's own parameters stay on its URL. */
function BoardLinks({
  boards,
  tenant,
  empty,
  star = false,
}: {
  boards: readonly BoardRef[];
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
            state={BOARD_LINK_STATE}
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

/** One group: the heading, then nothing while pending, a muted note on failure, or the links. */
function Group({
  heading,
  query,
  tenant,
  empty,
  failed,
  star = false,
}: {
  heading: string;
  query: ReturnType<typeof useStarred>;
  tenant: string;
  empty: string;
  failed: string;
  star?: boolean;
}) {
  return (
    <>
      <h2 className={cx(styles['heading'])}>{heading}</h2>
      {query.isError && query.data === undefined && <p className={cx(styles['empty'])}>{failed}</p>}
      {query.data !== undefined && (
        <BoardLinks boards={query.data} tenant={tenant} empty={empty} star={star} />
      )}
    </>
  );
}

export function SidebarBoards() {
  const { tenant } = useShellRoute();
  const starred = useStarred(tenant);
  const recent = useRecent(tenant);
  return (
    <>
      <Group
        heading={t('nav.starred')}
        query={starred}
        tenant={tenant}
        empty={t('nav.starredEmpty')}
        failed={t('nav.starredFailed')}
        star
      />
      <Group
        heading={t('nav.recent')}
        query={recent}
        tenant={tenant}
        empty={t('nav.recentEmpty')}
        failed={t('nav.recentFailed')}
      />
    </>
  );
}
