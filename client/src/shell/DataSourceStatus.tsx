/** The sidebar footer's data-source line (IA-021). */
import type { Tenant } from '../api/types';

export function DataSourceStatus(_: { tenant: Tenant | undefined }) {
  return null;
}
