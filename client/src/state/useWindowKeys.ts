/**
 * Window keys of INT-032: `[` and `]` step the window back and forward by its width, `-` zooms out
 * (×2 around the centre) and `=` zooms in (×½). Keys are matched by `KeyboardEvent.code`, without
 * modifiers. They are ignored when another handler already used the event, while typing, and inside
 * dialogs, menus, list boxes and grids, which own their arrow and typeahead keys. A handled key is
 * `preventDefault()`ed synchronously (T03-013).
 */
import { useEffect, useRef } from 'react';
import type { ContextAction } from './contextReducer';

const KEY_ACTIONS: Readonly<Record<string, ContextAction>> = Object.freeze({
  BracketLeft: { type: 'step', dir: -1 },
  BracketRight: { type: 'step', dir: 1 },
  Minus: { type: 'zoom', dir: 'out' },
  Equal: { type: 'zoom', dir: 'in' },
});

const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="searchbox"], [role="spinbutton"]';
const COMPOSITE = '[role="dialog"], [role="menu"], [role="listbox"], [role="grid"]';

export function isWindowKeyTargetExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(EDITABLE) !== null || target.closest(COMPOSITE) !== null;
}

export function windowKeyAction(e: KeyboardEvent): ContextAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  const action = KEY_ACTIONS[e.code];
  if (action === undefined) return null;
  if (isWindowKeyTargetExcluded(e.target)) return null;
  return action;
}

export function useWindowKeys(dispatch: (a: ContextAction) => void): void {
  const latest = useRef(dispatch);
  useEffect(() => {
    latest.current = dispatch;
  }, [dispatch]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const action = windowKeyAction(e);
      if (action === null) return;
      e.preventDefault();
      latest.current(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
