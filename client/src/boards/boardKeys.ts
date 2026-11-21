/**
 * Board keys (plan #61 Part B §4.4, T08-024): `Shift+E` toggles Edit mode (in Edit it acts as
 * Done) unless the target takes text or owns its keys; `⌘S` on macOS or `Ctrl+S` elsewhere saves
 * in Edit mode from any target. The window keys never take modifiers, `KeyE` or `KeyS`, so the two
 * sets never collide.
 */
import { isWindowKeyTargetExcluded } from '../state/useWindowKeys';

export type BoardKeyAction = 'toggleEdit' | 'save';

export function boardKeyAction(e: KeyboardEvent, mode: 'view' | 'edit'): BoardKeyAction | null {
  if (e.defaultPrevented) return null;
  if (
    e.code === 'KeyE' &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !isWindowKeyTargetExcluded(e.target)
  ) {
    return 'toggleEdit';
  }
  if (
    e.code === 'KeyS' &&
    mode === 'edit' &&
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey
  ) {
    return 'save';
  }
  return null;
}
