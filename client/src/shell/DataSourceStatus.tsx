/**
 * The sidebar footer's data-source line (IA-021): the tenant's binding and its check state, from
 * `GET /api/dash/v1/datasource/check` (T06-025, plan #62 §4.6). "Not checked" while the check is
 * pending or when it fails; the result is reused for a minute.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../app/providers';
import type { DataSourceState, Tenant } from '../api/types';
import { t, type MessageId } from '../i18n/t';
import { StateEncoding, type State } from '../theme/stateEncoding';
import styles from './Sidebar.module.css';
import { cx } from '../kit/cx';

const STATE_TEXT: Record<DataSourceState, MessageId> = {
  notChecked: 'sidebar.dataSourceNotChecked',
  ok: 'sidebar.dataSourceOk',
  unreachable: 'sidebar.dataSourceUnreachable',
  unauthorised: 'sidebar.dataSourceUnauthorised',
  error: 'sidebar.dataSourceError',
};

/** The dot's state: its text names it, so the colour is never the only cue (T02 §4). */
const STATE_DOT: Record<DataSourceState, State> = {
  notChecked: 'unknown',
  ok: 'ok',
  unreachable: 'failing',
  unauthorised: 'degraded',
  error: 'failing',
};

export function DataSourceStatus({ tenant }: { tenant: Tenant | undefined }) {
  const api = useApi();
  const slug = tenant?.slug ?? '';
  const check = useQuery({
    queryKey: ['datasource', slug],
    queryFn: ({ signal }) => api.checkDataSource(slug, signal),
    staleTime: 60_000,
    retry: false,
    enabled: tenant?.dataSource !== undefined,
  });
  if (tenant?.dataSource === undefined) return null;
  const state = check.data?.state ?? 'notChecked';
  const text = `${t('sidebar.dataSource', { slug })} · ${t(STATE_TEXT[state])}`;
  return (
    <p className={cx(styles['dataSource'])} title={text}>
      <span className={cx(styles['dotBox'])} aria-hidden="true">
        <span className={cx(styles['dot'], StateEncoding[STATE_DOT[state]].className)} />
      </span>
      <span className={cx(styles['dataSourceText'])}>{text}</span>
    </p>
  );
}
