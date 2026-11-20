/** Boards (IA-015): the tenant's boards, newest first as the API returns them. */
import { Link } from 'react-router';
import { preloadRoute } from '../../app/routeModules';
import { formatDate, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { EmptyState } from '../../kit/EmptyState';
import { usePageTitle } from '../../shell/PageTitle';
import { useBoards } from '../../shell/SidebarBoards';
import { useShellRoute } from '../../shell/useShellRoute';
import { contextSearchString } from '../../state/contextSearch';
import { useTimeContext } from '../../state/useTimeContext';
import styles from '../pages.module.css';
import { cx } from '../../kit/cx';

export function BoardsPage() {
  usePageTitle(t('boards.title'));
  const { tenant } = useShellRoute();
  const { search, timeZone } = useTimeContext();
  const boards = useBoards(tenant);

  let body;
  if (boards.isPending)
    body = (
      <p className={cx(styles['muted'])} aria-busy="true">
        {t('boards.loading')}
      </p>
    );
  else if (boards.isError) body = <p className={cx(styles['muted'])}>{t('boards.error')}</p>;
  else if (boards.data.length === 0) {
    body = (
      <EmptyState title={t('boards.empty')}>
        <p className={cx(styles['muted'])}>{t('boards.emptyDetail')}</p>
      </EmptyState>
    );
  } else {
    body = (
      <ul className={cx(styles['list'])} aria-label={t('boards.list')}>
        {boards.data.map((b) => {
          const ms = Date.parse(b.updatedAt);
          return (
            <li key={b.uid} className={cx(styles['row'])}>
              <Link
                to={{
                  pathname: `/t/${tenant}/board/${b.uid}`,
                  search: contextSearchString(search),
                }}
                className={cx(styles['rowLink'])}
                title={b.title}
                onPointerEnter={() => {
                  preloadRoute('board');
                }}
                onFocus={() => {
                  preloadRoute('board');
                }}
              >
                {b.title}
              </Link>
              <span className={cx(styles['meta'])}>
                {t('boards.updated', {
                  date: formatDate(ms, timeZone),
                  time: formatTime(ms, timeZone),
                })}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }
  return <div className={cx(styles['page'])}>{body}</div>;
}
