/**
 * A panel's "Open in Explore" link (plan #64 §3.5). A PromQL panel links to the server's substituted
 * text of its current key's own response (`planned.expanded`, before the rate rewrite): its board
 * variables and its `$__interval` / `$__rate_interval` at the panel's step, with the board's window.
 * Without that response there is no link. A LogQL panel links its saved text (no LogQL planning yet).
 */
import type { PanelSpec } from '../api/types';
import { contextSearchString, type ContextSearch } from '../state/contextSearch';

export function exploreHref(
  tenant: string,
  panel: PanelSpec,
  search: ContextSearch,
  expanded: string | null,
): string | null {
  const time = contextSearchString(search);
  if (panel.query.lang === 'logql') {
    return `/t/${tenant}/explore/logs${time}&q=${encodeURIComponent(panel.query.text)}`;
  }
  if (expanded === null) return null;
  const k = panel.vis.kind;
  const vis = k === 'auto' || k === 'logs' ? '' : `&vis=${k}`;
  return `/t/${tenant}/explore/metrics${time}&q=${encodeURIComponent(expanded)}${vis}`;
}
