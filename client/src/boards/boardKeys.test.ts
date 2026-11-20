import { describe, expect, it } from 'vitest';
import { boardKeyAction } from './boardKeys';

function key(
  code: string,
  o: KeyboardEventInit = {},
  target: Element = document.body,
): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...o });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('board keys', () => {
  it('board keys', () => {
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    document.body.append(input, area);
    expect(boardKeyAction(key('KeyE', { shiftKey: true }), 'view')).toBe('toggleEdit');
    expect(boardKeyAction(key('KeyE', { shiftKey: true }), 'edit')).toBe('toggleEdit');
    expect(boardKeyAction(key('KeyE', { shiftKey: true }, input), 'view')).toBeNull();
    expect(boardKeyAction(key('KeyS', { ctrlKey: true }), 'edit')).toBe('save');
    expect(boardKeyAction(key('KeyS', { ctrlKey: true }, area), 'edit')).toBe('save');
    expect(boardKeyAction(key('KeyS', { metaKey: true }), 'edit')).toBe('save');
    expect(boardKeyAction(key('KeyS', { ctrlKey: true }), 'view')).toBeNull();
    expect(boardKeyAction(key('KeyS', { ctrlKey: true, shiftKey: true }), 'edit')).toBeNull();
    expect(boardKeyAction(key('KeyE'), 'view')).toBeNull();
    input.remove();
    area.remove();
  });
});
