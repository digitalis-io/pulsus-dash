/** Widget panels: stub (plan #198 Part 1 §3.3), implemented after the failing tests. */
import type { PanelSpec, PanelVisKind, VisOptions } from '../api/types';

export const WIDGET_KINDS: ReadonlySet<PanelVisKind> = new Set<PanelVisKind>();
export const PENDING_WIDGETS: ReadonlySet<PanelVisKind> = new Set<PanelVisKind>();

export function isWidgetPanel(_p: PanelSpec): boolean {
  return false;
}

export function isDataPanel(_p: PanelSpec): boolean {
  return true;
}

export function textOptions(_o?: VisOptions): unknown {
  return {};
}

export function clockOptions(_o?: VisOptions): unknown {
  return {};
}
