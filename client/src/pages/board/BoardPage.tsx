/** A board (IA-022): title, the time Context summary and its panels (none until step 5). */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../app/providers';
import { isApiError } from '../../api/types';
import { t } from '../../i18n/t';
import { EmptyState } from '../../kit/EmptyState';
import { ContextSummary } from '../../shell/ContextSummary';
import { usePageTitle } from '../../shell/PageTitle';
import { pushRecent } from '../../shell/recentBoards';
import { useShellRoute } from '../../shell/useShellRoute';
import { contextSearchString } from '../../state/contextSearch';
import { useTimeContext } from '../../state/useTimeContext';
import { safeStorage } from '../../theme/theme';
import styles from '../pages.module.css';
import { cx } from '../../kit/cx';

export function BoardPage() {
  const api = useApi();
  const { tenant, uid = '' } = useShellRoute();
  const { search } = useTimeContext();
  const panelsId = useId();
  const board = useQuery({
    queryKey: ['board', tenant, uid],
    queryFn: ({ signal }) => api.getBoard(tenant, uid, signal),
    retry: (count, e) => !isApiError(e, 'notFound') && count < 1,
  });
  const notFound = board.isError && isApiError(board.error, 'notFound');
  usePageTitle(
    board.isSuccess
      ? board.data.title
      : notFound
        ? t('board.notFound')
        : board.isError
          ? t('error.generic')
          : t('board.loading'),
  );

  const loadedUid = board.isSuccess ? board.data.uid : null;
  useEffect(() => {
    if (loadedUid !== null) pushRecent(safeStorage(), tenant, loadedUid);
  }, [tenant, loadedUid]);

  if (board.isPending)
    return (
      <p className={cx(styles['muted'])} aria-busy="true">
        {t('board.loading')}
      </p>
    );
  if (board.isError) {
    return (
      <div className={cx(styles['page'])}>
        <p className={cx(styles['muted'])}>
          {notFound ? t('board.notFoundDetail') : t('error.genericDetail')}
        </p>
        <Link
          to={{ pathname: `/t/${tenant}/boards`, search: contextSearchString(search) }}
          className={cx(styles['link'])}
        >
          {t('board.back')}
        </Link>
      </div>
    );
  }
  return (
    <div className={cx(styles['page'])}>
      <ContextSummary />
      <section className={cx(styles['panels'])} aria-labelledby={panelsId}>
        <h2 id={panelsId} className={cx(styles['panelsTitle'])}>
          {t('board.panels')}
        </h2>
        <EmptyState title={t('board.noPanels')} />
      </section>
    </div>
  );
}
