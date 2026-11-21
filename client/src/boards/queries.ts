/** Board list query helpers (plan #61 Part C §3.4). */
import type { QueryClient } from '@tanstack/react-query';

/** The number of boards the sidebar's Recent group shows. */
export const RECENT_LIMIT = 5;

/**
 * After a create, rename, save or delete: the board list and the sidebar groups show titles.
 * Starred and Recent are the same under every tenant, so the prefixes are invalidated.
 */
export async function invalidateBoardLists(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['boards'] }),
    qc.invalidateQueries({ queryKey: ['starred'] }),
    qc.invalidateQueries({ queryKey: ['recent'] }),
  ]);
}
