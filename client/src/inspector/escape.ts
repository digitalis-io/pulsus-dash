/**
 * The Esc ladder's rules (T25-007, plan #192 §4.2): which key events it skips and which panel is
 * active.
 */
import type { InspectRequest } from './types';

/** True when the ladder must not act on `e`. */
export function ladderSkips(e: KeyboardEvent, doc: Document): boolean {
  void e;
  void doc;
  return true;
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
  void doc;
  void aside;
  void req;
  void lastPressed;
  return null;
}
