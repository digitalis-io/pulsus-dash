/** Explore › Logs: an empty state until the LogQL editor arrives (roadmap step 3). */
import { t } from '../../i18n/t';
import { EmptyState } from '../../kit/EmptyState';
import { ContextSummary } from '../../shell/ContextSummary';
import { usePageTitle } from '../../shell/PageTitle';
import styles from '../pages.module.css';
import { cx } from '../../kit/cx';

export function LogsPage() {
  usePageTitle(t('explore.logs.title'));
  return (
    <div className={cx(styles['page'])}>
      <ContextSummary />
      <EmptyState title={t('explore.logs.empty')}>
        <p className={cx(styles['muted'])}>{t('explore.logs.emptyDetail')}</p>
      </EmptyState>
    </div>
  );
}
