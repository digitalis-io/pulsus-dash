/**
 * The Esc ladder's rules (T25-007, plan #192 §4.2): which key events it skips and which panel is
 * active.
 */
import type { InspectRequest } from './types';

/** Where a kind's own Esc wins: dialogs, menus, list boxes and CodeMirror. */
const OWNED = '[role=dialog], [role=menu], [role=listbox], .cm-editor';

/**
 * True when the ladder must not act on `e`. An owner marked `data-escape-ladder` (a bar chart's
 * mirror listbox, ADR-0029) leaves Escape to the ladder.
 */
export function ladderSkips(e: KeyboardEvent, doc: Document): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return true;
  const target = e.target instanceof Element ? e.target : null;
  // Every owner around the target counts: a marked listbox inside a dialog is the dialog's.
  for (
    let o = target?.closest(OWNED) ?? null;
    o !== null;
    o = o.parentElement?.closest(OWNED) ?? null
  ) {
    if (!o.hasAttribute('data-escape-ladder')) return true;
  }
  if (
    target !== null &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') &&
    !target.hasAttribute('data-escape-ladder')
  ) {
    return true;
  }
  return doc.querySelector('[aria-modal="true"]') !== null;
}

/**
 * The active panel: the Inspector's origin when focus is inside the sheet, else the panel holding
 * focus, else the last panel pressed.
 */
export function activePanelId(
  doc: Document,
  aside: HTMLElement | null,
  req: InspectRequest | null,
  lastPressed: string | null,
): string | null {
  const active = doc.activeElement;
  if (aside !== null && active !== null && aside.contains(active))
    return req?.origin.panelId ?? null;
  const panel = active?.closest<HTMLElement>('[data-panel-id]') ?? null;
  if (panel !== null) return panel.dataset['panelId'] ?? null;
  return lastPressed;
}
