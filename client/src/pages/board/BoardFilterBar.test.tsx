/** The board filter bar and Copy link of the board's parameters (plan #61 Part C §4.3, §3.7). */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineWrapper, panelTitles } from '../../test/boardTestKit';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { renderApp, type RenderAppOptions } from '../../test/renderApp';

// The panel editor's Query field loads the editor chunk: a textarea stands in (plan #64 A.5).
vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

function open(url: string, o: RenderAppOptions = {}) {
  return renderApp(url, { wrapper: EngineWrapper, ...o });
}

/** Add panel, then close the editor it opens (#90, Appendix A R1). */
async function addPanel(user: ReturnType<typeof open>['user'], name = 'Add panel') {
  await user.click(await screen.findByRole('button', { name }));
  const d = await screen.findByRole('dialog', { name: 'Edit panel' });
  await user.click(within(d).getByRole('button', { name: 'Done' }));
  await waitFor(() => {
    expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
  });
}

type User = ReturnType<typeof open>['user'];

const BASE = 'from=now-1h&to=now&refresh=off';
const DEEP = `/t/demo/board/b-3?${BASE}&f=service%3Dcheckout&var-env=prod`;
const LONG = Array.from({ length: 3 }, (_, i) => `var-v${String(i + 1)}=${'é'.repeat(200)}`)
  .map((p) => {
    const [k, v] = p.split('=');
    return `${k ?? ''}=${encodeURIComponent(v ?? '')}`;
  })
  .join('&');

async function chips(): Promise<string[]> {
  const group = await screen.findByRole('group', { name: 'Board filters' });
  return within(group)
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? b.textContent);
}

async function dialog(name: string): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name });
}

/** Replaces the text of `field` with `text` (pasted, so long values are quick). */
async function setText(user: User, field: HTMLElement, text: string): Promise<void> {
  await user.clear(field);
  await user.click(field);
  if (text !== '') await user.paste(text);
}

function stubClipboard(): ReturnType<typeof vi.fn<(s: string) => Promise<void>>> {
  const writeText = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}

async function copyRelativeLink(user: User): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Share' }));
  const share = await dialog('Share board');
  await user.click(within(share).getByRole('checkbox', { name: 'Keep relative' }));
  await user.click(within(share).getByRole('button', { name: 'Copy link' }));
}

async function addFilter(user: User, label: string, value: string): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Filter' }));
  const d = await dialog('Add filter');
  await setText(user, within(d).getByRole('textbox', { name: 'Label' }), label);
  await setText(user, within(d).getByRole('textbox', { name: 'Value' }), value);
  await user.click(within(d).getByRole('button', { name: 'Add' }));
  return d;
}

describe('filter bar', () => {
  it('variable chips come from the queries', async () => {
    const one = open('/t/demo/board/b-3');
    await waitFor(async () => {
      expect(await chips()).toEqual([
        'Variable region: not set',
        'Variable env: not set',
        'Filter',
      ]);
    });
    one.view.unmount();
    open('/t/demo/board/b-1');
    await waitFor(async () => {
      expect(await chips()).toEqual(['Filter']);
    });
  });

  it('setting a variable writes the URL', async () => {
    const { user, router } = open('/t/demo/board/b-3');
    await user.click(await screen.findByRole('button', { name: 'Variable region: not set' }));
    const d = await dialog('Variable region');
    const value = within(d).getByRole('textbox', { name: 'Value' });
    await setText(user, value, 'eu-west-1');
    await user.click(within(d).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(router.state.location.search).toContain('var-region=eu-west-1');
    });
    expect(router.state.historyAction).toBe('PUSH');
    expect(await screen.findByRole('button', { name: 'Variable region: eu-west-1' })).toBeVisible();
    await act(() => router.navigate(-1));
    expect(await screen.findByRole('button', { name: 'Variable region: not set' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Variable region: not set' }));
    await setText(user, within(await dialog('Variable region')).getByRole('textbox'), 'x');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(await screen.findByRole('button', { name: 'Variable region: x' }));
    await user.click(
      within(await dialog('Variable region')).getByRole('button', { name: 'Clear' }),
    );
    await waitFor(() => {
      expect(router.state.location.search).not.toContain('var-region');
    });
  });

  it('deep link restores chips', async () => {
    open(DEEP);
    await waitFor(async () => {
      expect(await chips()).toEqual([
        'Variable region: not set',
        'Variable env: prod',
        'Filter service: checkout',
        'Filter',
      ]);
    });
  });

  it('add, change and remove a filter', async () => {
    const { user, router } = open('/t/demo/board/b-1');
    await addFilter(user, 'service.name', 'checkout');
    await waitFor(() => {
      expect(router.state.location.search).toContain('f=service.name%3Dcheckout');
    });
    const chip = await screen.findByRole('button', { name: 'Filter service.name: checkout' });
    await user.click(chip);
    const d = await dialog('Filter service.name');
    await setText(user, within(d).getByRole('textbox', { name: 'Value' }), 'payments');
    await user.click(within(d).getByRole('button', { name: 'Apply' }));
    await screen.findByRole('button', { name: 'Filter service.name: payments' });
    expect(new URLSearchParams(router.state.location.search).getAll('f')).toEqual([
      'service.name=payments',
    ]);
    await user.click(screen.getByRole('button', { name: 'Filter service.name: payments' }));
    await user.click(
      within(await dialog('Filter service.name')).getByRole('button', { name: 'Remove filter' }),
    );
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).getAll('f')).toEqual([]);
    });
    await addFilter(user, 'service.name', 'a');
    await addFilter(user, 'service.name', 'b');
    await waitFor(() => {
      expect(new URLSearchParams(router.state.location.search).getAll('f')).toEqual([
        'service.name=b',
      ]);
    });
  });

  it('filter validation', async () => {
    const { user, router } = open('/t/demo/board/b-1');
    await screen.findByRole('button', { name: 'Filter' });
    const before = router.state.location.search;
    const cases: [string, string, string][] = [
      ['9x', 'v', 'Use a label name: letters, digits, _ and ., not starting with a digit'],
      ['k', '', 'Enter a value'],
      ['k', 'v'.repeat(201), 'Use at most 200 characters'],
    ];
    for (const [label, value, message] of cases) {
      const d = await addFilter(user, label, value);
      expect(within(d).getByText(message)).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Add filter' })).toBeInTheDocument();
      expect(router.state.location.search).toBe(before);
      await user.click(within(d).getByRole('button', { name: 'Cancel' }));
    }
    act(() => {
      void router.navigate(
        `/t/demo/board/b-1?${BASE}&${Array.from({ length: 20 }, (_, i) => `f=k${String(i)}%3Dv`).join('&')}`,
      );
    });
    await screen.findByRole('button', { name: 'Filter k19: v' });
    const full = router.state.location.search;
    const d = await addFilter(user, 'k21', 'v');
    expect(within(d).getByText('A board can have at most 20 filters')).toBeInTheDocument();
    expect(router.state.location.search).toBe(full);
  });

  it('chips follow the draft', async () => {
    const { user } = open('/t/demo/board/b-1');
    // Edit panel from the View-mode menu enters Edit with the editor on the panel.
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Request rate' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const editor = await screen.findByRole('dialog', { name: 'Edit panel' });
    const query = await within(editor).findByRole('textbox', { name: 'Query' });
    await setText(user, query, 'rate(x{app="$app"}[5m])');
    // Esc in the editor moves to Run query; a second Esc closes the dialog (T09-004).
    await user.keyboard('{Escape}');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit panel' })).toBeNull();
    });
    expect(await screen.findByRole('button', { name: 'Variable app: not set' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByRole('button', { name: 'Edit board' });
    expect(screen.queryByRole('button', { name: 'Variable app: not set' })).toBeNull();
  });

  it('filter changes never guard', async () => {
    const { user } = open('/t/demo/board/b-1');
    await user.click(await screen.findByRole('button', { name: 'Edit board' }));
    await addPanel(user);
    await addFilter(user, 'a', 'b');
    await screen.findByRole('button', { name: 'Filter a: b' });
    expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(panelTitles()).toHaveLength(5);
  });

  it('share keeps variables and filters', async () => {
    const { user } = open(DEEP);
    const writeText = stubClipboard();
    await screen.findByRole('button', { name: 'Variable env: prod' });
    await copyRelativeLink(user);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    expect(writeText.mock.calls[0]?.[0]).toMatch(
      new RegExp(`/t/demo/board/b-3\\?${BASE}&f=service%3Dcheckout&var-env=prod$`),
    );
  });

  it('share keeps section overrides', async () => {
    const { user, view } = open(`/t/demo/board/b-1?${BASE}`);
    const writeText = stubClipboard();
    await user.click(await screen.findByRole('button', { name: 'Latency' }));
    await copyRelativeLink(user);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    const copied = writeText.mock.calls[0]?.[0] ?? '';
    expect(copied).toMatch(new RegExp(`/t/demo/board/b-1\\?${BASE}&collapse=s-1$`));
    view.unmount();
    const u = new URL(copied);
    open(u.pathname + u.search);
    expect(await screen.findByRole('button', { name: 'Latency' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('filter too long for the URL', async () => {
    const { user, router } = open(`/t/demo/board/b-1?${BASE}&${LONG}`);
    await screen.findByRole('button', { name: 'Filter' });
    const before = router.state.location.search;
    const d = await addFilter(user, 'k', 'é'.repeat(200));
    const value = within(d).getByRole('textbox', { name: 'Value' });
    expect(
      within(d).getByText(
        'This would make the board link too long. Remove a filter or use a shorter value.',
      ),
    ).toBeInTheDocument();
    expect(value).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('dialog', { name: 'Add filter' })).toBeInTheDocument();
    expect(router.state.location.search).toBe(before);
    await setText(user, value, 'x');
    await user.click(within(d).getByRole('button', { name: 'Add' }));
    await user.click(await screen.findByRole('button', { name: 'Filter k: x' }));
    await user.click(
      within(await dialog('Filter k')).getByRole('button', { name: 'Remove filter' }),
    );
    await waitFor(() => {
      expect(router.state.location.search).toBe(before);
    });
  });

  it('variable too long for the URL', async () => {
    const { user, router } = open(`/t/demo/board/b-3?${BASE}&${LONG}&var-region=eu`);
    await user.click(await screen.findByRole('button', { name: 'Variable region: eu' }));
    const before = router.state.location.search;
    const d = await dialog('Variable region');
    await setText(user, within(d).getByRole('textbox', { name: 'Value' }), '😀'.repeat(200));
    await user.click(within(d).getByRole('button', { name: 'Apply' }));
    expect(
      within(d).getByText(
        'This would make the board link too long. Remove a filter or use a shorter value.',
      ),
    ).toBeInTheDocument();
    expect(router.state.location.search).toBe(before);
    await user.click(within(d).getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(router.state.location.search).not.toContain('var-region');
    });
  });
});
