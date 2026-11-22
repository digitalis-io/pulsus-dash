import { fireEvent, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../test/renderApp';
import { useWindowKeys, windowKeyAction } from './useWindowKeys';

const URL_10_11 =
  '/t/demo/explore/metrics?from=2026-11-19T10%3A00%3A00.000Z&to=2026-11-19T11%3A00%3A00.000Z&refresh=off';

function key(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  fireEvent(target, e);
  return e;
}

describe('window keys', () => {
  it('] on the page steps forward and is prevented; ignored in a field and with modifiers', async () => {
    const { router, user } = renderApp(URL_10_11);
    await screen.findByRole('heading', { level: 1, name: 'Metrics' });
    const e = key(document.body, { key: ']', code: 'BracketRight' });
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).get('from')).toBe(
        '2026-11-19T11:00:00.000Z',
      );
    });

    const before = router.state.location.search;
    await user.click(await screen.findByRole('button', { name: /11:00:00 – 12:00:00/ }));
    const from = await screen.findByRole('textbox', { name: 'From' });
    const inField = key(from, { key: ']', code: 'BracketRight' });
    expect(inField.defaultPrevented).toBe(false);
    await user.keyboard('{Escape}');
    const ctrl = key(document.body, { key: ']', code: 'BracketRight', ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(false);
    expect(router.state.location.search).toBe(before);
  });
});

describe('IA-002 time subset', () => {
  it('the header and the page show the same window after ]', async () => {
    const { router } = renderApp(URL_10_11);
    await screen.findByRole('heading', { level: 1, name: 'Metrics' });
    key(document.body, { key: ']', code: 'BracketRight' });
    await waitFor(() => {
      expect(router.state.location.search).toContain('from=2026-11-19T11');
    });
    const range = '19 Nov 2026, 11:00:00 – 12:00:00';
    expect(await screen.findByRole('button', { name: new RegExp(range) })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^Showing ${range}`))).toBeInTheDocument();
  });
});

describe('unit:window-keys composed path (INT-032)', () => {
  const made: Element[] = [];
  afterEach(() => {
    for (const e of made.splice(0)) e.remove();
  });
  const bracket = () =>
    new KeyboardEvent('keydown', {
      code: 'BracketLeft',
      key: '[',
      bubbles: true,
      composed: true,
      cancelable: true,
    });
  function shadowHost(parent: Element): ShadowRoot {
    const host = document.createElement('div');
    parent.append(host);
    if (parent === document.body) made.push(host);
    return host.attachShadow({ mode: 'open' });
  }

  it('ignores a key typed in an editable element inside a shadow root', () => {
    const dispatch = vi.fn();
    renderHook(() => {
      useWindowKeys(dispatch);
    });
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    shadowHost(document.body).append(editable);
    const inShadow = bracket();
    editable.dispatchEvent(inShadow);
    expect(dispatch).not.toHaveBeenCalled();
    expect(inShadow.defaultPrevented).toBe(false);
    const onBody = bracket();
    document.body.dispatchEvent(onBody);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'step', dir: -1 });
    expect(onBody.defaultPrevented).toBe(true);
  });

  it('ignores a key from a shadow root whose host is inside a dialog', () => {
    const dispatch = vi.fn();
    renderHook(() => {
      useWindowKeys(dispatch);
    });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    made.push(dialog);
    const span = document.createElement('span');
    shadowHost(dialog).append(span);
    const e = bracket();
    span.dispatchEvent(e);
    expect(dispatch).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('without a composed path, the target decides', () => {
    const input = document.createElement('input');
    document.body.append(input);
    made.push(input);
    const ev = (target: EventTarget) =>
      ({
        code: 'BracketLeft',
        key: '[',
        defaultPrevented: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        target,
        composedPath: () => [],
      }) as unknown as KeyboardEvent;
    expect(windowKeyAction(ev(input))).toBeNull();
    expect(windowKeyAction(ev(document.body))).toEqual({ type: 'step', dir: -1 });
  });
});
