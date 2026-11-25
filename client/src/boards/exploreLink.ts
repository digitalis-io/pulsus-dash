/**
 * A panel's "Open in Explore" link (plan #64 §3.5). A PromQL panel links to the server's substituted
 * text of its current key's own response (`planned.expanded`, before the rate rewrite): its board
 * variables and its `$__interval` / `$__rate_interval` at the panel's step, with the board's window.
 * Without that response there is no link. A LogQL panel links the server's substituted text of its
 * current answer to Explore › Logs (plan #67 §2), and has no link without one.
 */
import type { PanelSpec } from '../api/types';
import type { VisKind } from '../engine/api';
import { contextSearchString, type ContextSearch } from '../state/contextSearch';

export function exploreHref(
  tenant: string,
  panel: PanelSpec,
  search: ContextSearch,
  expanded: string | null,
): string | null {
  if (expanded === null) return null;
  const k = panel.vis.kind;
  return exploreHrefFor(tenant, panel.query.lang, k === 'logs' ? 'auto' : k, search, expanded);
}

/**
 * Explore's address for a query in the Context (also the Inspector's Explore pivot, T25 §4.3):
 * Explore › Logs for LogQL, else Explore › Metrics with `vis` (none for `auto`).
 */
export function exploreHrefFor(
  tenant: string,
  lang: 'promql' | 'logql',
  vis: VisKind | 'auto',
  search: ContextSearch,
  text: string,
): string {
  const time = contextSearchString(search);
  if (lang === 'logql') return `/t/${tenant}/explore/logs${time}&q=${encodeURIComponent(text)}`;
  const v = vis === 'auto' ? '' : `&vis=${vis}`;
  return `/t/${tenant}/explore/metrics${time}&q=${encodeURIComponent(text)}${v}`;
}
