/**
 * "Page not found": `ShellNotFoundPage` is the page body for an unknown path under a known tenant;
 * `NotFoundPage` is the whole page for an unknown tenant or path.
 */
import { Link, useParams } from 'react-router';
import { t } from '../i18n/t';
import { usePageTitle } from '../shell/PageTitle';
import { contextSearchString } from '../state/contextSearch';
import { useTimeContext } from '../state/useTimeContext';
import styles from './pages.module.css';
import { cx } from '../kit/cx';

export function ShellNotFoundPage() {
  usePageTitle(t('notFound.title'));
  const { tenant = '' } = useParams();
  const { search } = useTimeContext();
  return (
    <div className={cx(styles['page'])}>
      <p className={cx(styles['muted'])}>{t('notFound.detail')}</p>
      <Link
        to={{ pathname: `/t/${tenant}/boards`, search: contextSearchString(search) }}
        className={cx(styles['link'])}
      >
        {t('notFound.back')}
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  usePageTitle(t('notFound.title'));
  return (
    <main id="main" tabIndex={-1} className={cx(styles['standalone'])}>
      <h1 className={cx(styles['standaloneTitle'])}>{t('notFound.title')}</h1>
      <p className={cx(styles['muted'])}>{t('notFound.detail')}</p>
      <Link to="/" className={cx(styles['link'])}>
        {t('notFound.back')}
      </Link>
    </main>
  );
}
