/** The panel's "Open in Explore" link (plan #64 §3.5). */
import type { PanelSpec } from '../api/types';
import type { ContextSearch } from '../state/contextSearch';

export function exploreHref(
  _tenant: string,
  _panel: PanelSpec,
  _search: ContextSearch,
  _expanded: string | null,
): string | null {
  throw new Error('not implemented');
}
