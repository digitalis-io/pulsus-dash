// unit:escape-ladder, unit:escape-skips, unit:host-registries, unit:inspector-collapse
// (T25-006, T25-007, T25-008, T25-011, T25-013; plan #192 §5).
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  K1,
  P_ORIGIN,
  P_TARGET,
  esc,
  pRequest,
  renderHost,
  stubReducedMotion,
} from '../test/inspectorKit';
import type { EscapeProvider } from './host';
import type { MemberList } from './members';

let restore: () => void = () => undefined;
beforeEach(() => {
  // Reduced motion: a close unmounts at once, so "closed" is visible without timers.
  restore = stubReducedMotion(true);
});
afterEach(() => {
  restore();
});

/** A provider whose `pre` and `post` hand out their steps in order, logging each as it runs. */
function ladder(log: string[], pre: string[], post: string[]): EscapeProvider {
  const step = (list: string[]) => () => {
    const name = list[0];
    if (name === undefined) return null;
    return () => {
      list.shift();
      log.push(name);
    };
  };
  return { pre: step([...pre]), post: step([...post]) };
}

const heading = (): HTMLElement => screen.getByRole('heading', { level: 2 });

describe('unit:escape-ladder', () => {
  it('(a) pre steps, clear selection, close, post steps; the 8th Esc is not prevented', () => {
    const h = renderHost(
      <div data-panel-id="p1" tabIndex={-1}>
        <button type="button" data-testid="origin">
          origin
        </button>
      </div>,
    );
    const log: string[] = [];
    act(() => {
      h.api().registerEscape(
        'p1',
        ladder(log, ['exitFly', 'clearBrush', 'clearSearch'], ['reroot', 'overview']),
      );
    });
    const origin = screen.getByTestId('origin');
    h.inspect(pRequest({ returnFocus: origin }));
    act(() => {
      heading().focus();
    });
    const seen: string[] = [];
    const prevented: boolean[] = [];
    for (let i = 0; i < 8; i++) {
      const before = { sel: h.selection(), open: h.aside() !== null, n: log.length };
      const e = esc();
      prevented.push(e.defaultPrevented);
      if (log.length > before.n) seen.push(log.at(-1) ?? '');
      else if (before.sel !== 'null' && h.selection() === 'null') seen.push('clearSelection');
      else if (before.open && h.aside() === null) {
        seen.push('close');
        expect(document.activeElement).toBe(origin);
      }
    }
    expect(seen).toEqual([
      'exitFly',
      'clearBrush',
      'clearSearch',
      'clearSelection',
      'close',
      'reroot',
      'overview',
    ]);
    expect(prevented).toEqual([true, true, true, true, true, true, true, false]);
  });

  it('(b) a marked search field clears first and keeps focus', () => {
    const h = renderHost(
      <div data-panel-id="p1" tabIndex={-1}>
        <input aria-label="search" data-escape-ladder="" defaultValue="foo" />
      </div>,
    );
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'search' });
    const log: string[] = [];
    const posts = ladder(log, [], ['reroot', 'overview']);
    act(() => {
      h.api().registerEscape('p1', {
        pre: () =>
          input.value === ''
            ? null
            : () => {
                input.value = '';
                log.push('clearSearch');
              },
        post: () => posts.post(),
      });
    });
    h.inspect(pRequest());
    act(() => {
      input.focus();
    });
    esc();
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(log).toEqual(['clearSearch']);
    esc();
    expect(h.selection()).toBe('null');
    expect(h.aside()).not.toBeNull();
    esc();
    expect(h.aside()).toBeNull();
    act(() => {
      input.focus();
    });
    esc();
    esc();
    expect(log).toEqual(['clearSearch', 'reroot', 'overview']);
  });

  it('(c) an unmarked input: no step runs', () => {
    const h = renderHost(
      <div data-panel-id="p1" tabIndex={-1}>
        <input aria-label="plain" />
      </div>,
    );
    h.inspect(pRequest());
    act(() => {
      screen.getByRole('textbox', { name: 'plain' }).focus();
    });
    const e = esc();
    expect(e.defaultPrevented).toBe(false);
    expect(h.selection()).toBe(`${K1}|null|null`);
    expect(h.aside()).not.toBeNull();
  });
});

describe('unit:escape-ladder (mirror listbox)', () => {
  it('a listbox marked data-escape-ladder is not skipped; an unmarked one is', () => {
    const h = renderHost(
      <div data-panel-id="p1" tabIndex={-1}>
        <div role="listbox" tabIndex={0} aria-label="bars" data-escape-ladder="" />
        <div role="listbox" tabIndex={0} aria-label="plain list" />
      </div>,
    );
    h.inspect(pRequest());
    const want = `${K1}|null|null`;
    const plain = esc(screen.getByRole('listbox', { name: 'plain list' }));
    expect(plain.defaultPrevented).toBe(false);
    expect(h.selection()).toBe(want);
    const marked = esc(screen.getByRole('listbox', { name: 'bars' }));
    expect(marked.defaultPrevented).toBe(true);
    expect(h.selection()).toBe('null');
  });
});

describe('unit:escape-skips', () => {
  it('dialogs, editors, modals, IME and prevented events take no step', () => {
    const h = renderHost(
      <>
        <div role="dialog" aria-label="d">
          <button type="button">in dialog</button>
        </div>
        <div className="cm-editor">
          <button type="button">in editor</button>
        </div>
        <button type="button">plain</button>
      </>,
    );
    h.inspect(pRequest());
    const want = `${K1}|null|null`;
    esc(screen.getByRole('button', { name: 'in dialog' }));
    expect(h.selection()).toBe(want);
    esc(screen.getByRole('button', { name: 'in editor' }));
    expect(h.selection()).toBe(want);
    esc(screen.getByRole('button', { name: 'plain' }), { isComposing: true });
    expect(h.selection()).toBe(want);
    const prevented = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    prevented.preventDefault();
    act(() => {
      screen.getByRole('button', { name: 'plain' }).dispatchEvent(prevented);
    });
    expect(h.selection()).toBe(want);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.append(modal);
    esc(screen.getByRole('button', { name: 'plain' }));
    expect(h.selection()).toBe(want);
    modal.remove();
    esc(screen.getByRole('button', { name: 'plain' }));
    expect(h.selection()).toBe('null');
  });
});

describe('unit:host-registries', () => {
  it('members: last wins; a stale disposer keeps the newer entry', () => {
    const h = renderHost();
    const a: MemberList = { texts: ['a'], members: [] };
    const b: MemberList = { texts: ['b'], members: [] };
    let offA: () => void = () => undefined;
    act(() => {
      offA = h.api().registerMembers('P2', () => a);
      h.api().registerMembers('P2', () => b);
    });
    expect(h.api().resolveMembers('P2', 'P2:K:r0')).toBe(b);
    act(() => {
      offA();
    });
    expect(h.api().resolveMembers('P2', 'P2:K:r0')).toBe(b);
    expect(h.api().resolveMembers('P1', 'P2:K:r0')).toBeNull();
  });

  it('unit:geo-preview-members (c): a per-panel stack; each disposer removes only its own entry', () => {
    const h = renderHost();
    const a: MemberList = { texts: ['a'], members: [] };
    const b: MemberList = { texts: ['b'], members: [] };
    let offA: () => void = () => undefined;
    let offB: () => void = () => undefined;
    act(() => {
      offA = h.api().registerMembers('P2', () => a);
      offB = h.api().registerMembers('P2', () => b);
    });
    expect(h.api().resolveMembers('P2', 'r')).toBe(b);
    act(() => {
      offB();
    });
    // The earlier registration answers again (a full screen closed, StrictMode's re-mount).
    expect(h.api().resolveMembers('P2', 'r')).toBe(a);
    act(() => {
      offA();
    });
    expect(h.api().resolveMembers('P2', 'r')).toBeNull();
    act(() => {
      offA = h.api().registerMembers('P2', () => a);
      offB = h.api().registerMembers('P2', () => b);
    });
    act(() => {
      offA();
    });
    expect(h.api().resolveMembers('P2', 'r')).toBe(b);
    act(() => {
      offB();
      offB();
    });
    expect(h.api().resolveMembers('P2', 'r')).toBeNull();
  });

  it('select never opens or closes the Inspector', () => {
    const h = renderHost();
    act(() => {
      h.api().select({ keys: [K1], fromMs: null, toMs: null }, { kind: 'tableRow', panelId: 'p1' });
    });
    expect(h.aside()).toBeNull();
    expect(h.selection()).toBe(`${K1}|null|null`);
    h.inspect(pRequest());
    act(() => {
      h.api().select(null, { kind: 'mark', panelId: 'p1' });
    });
    expect(h.aside()).not.toBeNull();
    expect(h.selection()).toBe('null');
  });

  it('a changed or removed origin closes the Inspector; the selection stays', () => {
    let key: string | null = 'k';
    const h = renderHost(null, { originKey: () => key });
    h.inspect(pRequest());
    h.rerender();
    expect(h.aside()).not.toBeNull();
    key = 'k2';
    h.rerender();
    expect(h.aside()).toBeNull();
    expect(h.selection()).toBe(`${K1}|null|null`);
    key = 'k';
    h.inspect(pRequest());
    key = null;
    h.rerender();
    expect(h.aside()).toBeNull();
  });
});

describe('unit:inspector-collapse', () => {
  it('a new target expands the sheet; only a keyboard open moves focus', () => {
    const h = renderHost();
    const target = (title: string) =>
      pRequest({ origin: { ...P_ORIGIN, title }, target: P_TARGET });
    h.inspect(target('A'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    expect(h.aside()).toHaveAttribute('data-collapsed');
    const active = document.activeElement;
    h.inspect(target('B'));
    expect(h.aside()).not.toHaveAttribute('data-collapsed');
    expect(heading()).toHaveTextContent('B');
    expect(document.activeElement).toBe(active);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Inspector' }));
    expect(h.aside()).toHaveAttribute('data-collapsed');
    h.inspect({ ...target('C'), source: 'keyboard' });
    expect(h.aside()).not.toHaveAttribute('data-collapsed');
    expect(document.activeElement).toBe(heading());
    expect(heading()).toHaveTextContent('C');
  });
});

describe('unit:inspector-tenant', () => {
  const URL_B = '/t/other/board/b1?from=now-1h&to=now&refresh=30s';

  /** Each DOM change once the router is on the other tenant: any Inspector trace in the DOM. */
  function watch(onOther: () => boolean): { seen: string[]; stop: () => void } {
    const seen: string[] = [];
    const mo = new MutationObserver(() => {
      if (!onOther()) return;
      const aside = document.querySelector('[data-inspector]');
      const live = document.querySelector('[data-inspector-live]')?.textContent ?? '';
      const text = document.body.textContent;
      if (aside !== null) seen.push('aside');
      if (live !== '') seen.push(`live:${live}`);
      if (text.includes('shop/checkout')) seen.push('label');
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    return {
      seen,
      stop: () => {
        mo.disconnect();
      },
    };
  }

  for (const reduced of [true, false]) {
    it(`an open sheet: nothing of the last tenant survives (${reduced ? 'reduced' : 'full'} motion)`, async () => {
      restore();
      restore = stubReducedMotion(reduced);
      const h = renderHost();
      h.inspect(pRequest());
      expect(h.aside()).not.toBeNull();
      expect(document.body.textContent).toContain('shop/checkout');
      const w = watch(() => h.router.state.location.pathname.startsWith('/t/other/'));
      await act(async () => {
        await h.router.navigate(URL_B);
      });
      w.stop();
      expect(w.seen).toEqual([]);
      expect(document.querySelector('[data-inspector]')).toBeNull();
      expect(document.querySelector('[data-inspector-live]')?.textContent).toBe('');
      expect(h.selection()).toBe('null');
      expect(document.body.textContent).not.toContain('shop/checkout');
    });
  }

  it('a closed sheet: the selection and the live text go too', async () => {
    const h = renderHost();
    h.inspect(pRequest());
    fireEvent.click(screen.getByRole('button', { name: 'Close Inspector' }));
    expect(h.selection()).toBe(`${K1}|null|null`);
    expect(document.querySelector('[data-inspector-live]')?.textContent).not.toBe('');
    await act(async () => {
      await h.router.navigate(URL_B);
    });
    expect(h.selection()).toBe('null');
    expect(document.querySelector('[data-inspector-live]')?.textContent).toBe('');
  });
});
