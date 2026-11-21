/** Board list query helpers (plan #61 Part C §3.4). */
import type { QueryClient } from '@tanstack/react-query';

export const RECENT_LIMIT = 5;

/** After a create, rename, save or delete: the list and the sidebar groups show titles. */
export function invalidateBoardLists(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: ['boards'] });
}
