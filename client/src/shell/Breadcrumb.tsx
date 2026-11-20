/** Ancestors of the page title (IA-016): `Boards` on a board page, `Explore` on Explore pages. */
import { Link } from 'react-router';
import { t } from '../i18n/t';
import { contextSearchString } from '../state/contextSearch';
import { useTimeContext } from '../state/useTimeContext';
import styles from './Header.module.css';
import { cx } from '../kit/cx';

export function Breadcrumb({ routeId, tenant }: { routeId: string | undefined; tenant: string }) {
  const { search } = useTimeContext();
  let crumb;
  if (routeId === 'board') {
    crumb = (
      <Link
        to={{ pathname: `/t/${tenant}/boards`, search: contextSearchString(search) }}
        className={cx(styles['crumbLink'])}
      >
        {t('nav.boards')}
      </Link>
    );
  } else if (routeId === 'metrics' || routeId === 'logs') {
    crumb = <span className={cx(styles['crumbText'])}>{t('nav.explore')}</span>;
  } else {
    return null;
  }
  return (
    <nav aria-label={t('breadcrumb.label')} className={cx(styles['breadcrumb'])}>
      <ol className={cx(styles['crumbs'])}>
        <li className={cx(styles['crumb'])}>
          {crumb}
          <span className={cx(styles['separator'])} aria-hidden="true">
            /
          </span>
        </li>
      </ol>
    </nav>
  );
}
