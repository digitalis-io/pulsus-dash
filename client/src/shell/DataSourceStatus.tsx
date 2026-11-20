/**
 * The sidebar footer's data-source line (IA-021): the tenant's binding and its check state. Until
 * the data-source check exists (#62) the state is always "Not checked" (Q2).
 */
import type { Tenant } from '../api/types';
import { t } from '../i18n/t';
import styles from './Sidebar.module.css';
import { cx } from '../kit/cx';

export function DataSourceStatus({ tenant }: { tenant: Tenant | undefined }) {
  if (tenant?.dataSource === undefined) return null;
  return (
    <p className={cx(styles['dataSource'])}>
      {`${t('sidebar.dataSource', { slug: tenant.slug })} · ${t('sidebar.dataSourceNotChecked')}`}
    </p>
  );
}
