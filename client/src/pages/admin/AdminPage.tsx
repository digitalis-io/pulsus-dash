/** Admin: placeholders for data sources and identity, which the BFF configures (#59). */
import { t } from '../../i18n/t';
import { Card } from '../../kit/Card';
import { usePageTitle } from '../../shell/PageTitle';
import styles from '../pages.module.css';
import { cx } from '../../kit/cx';

export function AdminPage() {
  usePageTitle(t('admin.title'));
  return (
    <div className={cx(styles['cards'])}>
      <Card title={t('admin.dataSources')}>
        <p className={cx(styles['muted'])}>{t('admin.noDataSources')}</p>
      </Card>
      <Card title={t('admin.identity')}>
        <p className={cx(styles['muted'])}>{t('admin.noIdentity')}</p>
      </Card>
    </div>
  );
}
