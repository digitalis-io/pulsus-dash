/** Explore › Metrics: an empty state until the PromQL editor arrives (roadmap step 2). */
import { t } from '../../i18n/t';
import { EmptyState } from '../../kit/EmptyState';
import { ContextSummary } from '../../shell/ContextSummary';
import { usePageTitle } from '../../shell/PageTitle';
import styles from '../pages.module.css';
import { cx } from '../../kit/cx';

export function MetricsPage() {
  usePageTitle(t('explore.metrics.title'));
  return (
    <div className={cx(styles['page'])}>
      <ContextSummary />
      <EmptyState title={t('explore.metrics.empty')}>
        <p className={cx(styles['muted'])}>{t('explore.metrics.emptyDetail')}</p>
      </EmptyState>
    </div>
  );
}
