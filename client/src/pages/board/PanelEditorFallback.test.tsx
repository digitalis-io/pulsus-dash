/**
 * The panel editor's Query field when the editor chunk fails to load (plan #64 §5.1 `editor picker
 * and fallback`, second case; #147 B1): the plain text area runs on Run query and on its Run keys,
 * unchanged text included. In its own file: the chunk mock rejects for every test here.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { editorOn, openBoard, ready, reqs, show } from '../../test/boardPanelKit';
import { boardWith, engineWrapper, panel } from '../../test/boardTestKit';
import { fakeEngine } from '../../test/fakeEngine';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { renderApp } from '../../test/renderApp';

vi.mock('../../editor/editor', () => Promise.reject(new Error('stub: chunk failed')));

const LOAD_FAILED = 'The query editor could not be loaded. Reload the page to try again.';

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
});

afterEach(() => {
  uninstallIntersectionObserver();
});

describe('panel editor fallback', () => {
  it('editor picker and fallback: the chunk import rejects', async () => {
    const api = new StubApi(boardWith([panel('p-1', 'Requests', 'up')]));
    const { user } = renderApp('/t/demo/board/b-1?from=now-1h&to=now&refresh=off', {
      api,
      wrapper: engineWrapper(fakeEngine()),
    });
    await user.click(await screen.findByRole('button', { name: 'Panel menu: Requests' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit panel' }));
    const d = await screen.findByRole('dialog', { name: 'Edit panel' });
    await waitFor(() => {
      expect(within(d).getByRole('alert')).toHaveTextContent(LOAD_FAILED);
    });
    const box = within(d).getByRole('textbox', { name: 'Query' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveValue('up');
  });

  it('B1 PromQL fallback: Run query and the Run keys run the text area, unchanged text included', async () => {
    const t = openBoard([panel('p-1', 'S', 'up')]);
    await ready('S');
    show('S');
    const d = await editorOn(t, 'S');
    await waitFor(() => {
      expect(within(d).getByRole('alert')).toHaveTextContent(LOAD_FAILED);
    });
    const box = within(d).getByRole('textbox', { name: 'Query' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveValue('up');

    const run = within(d).getByRole('button', { name: 'Run query' });
    expect(run).toBeEnabled();
    let n = t.range.mock.calls.length;
    await t.user.click(run);
    await waitFor(() => {
      expect(t.range.mock.calls.length).toBeGreaterThan(n);
    });
    expect(reqs(t).at(-1)?.query).toBe('up');

    n = t.range.mock.calls.length;
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    await waitFor(() => {
      expect(t.range.mock.calls.length).toBeGreaterThan(n);
    });
    expect(reqs(t).at(-1)?.query).toBe('up');

    fireEvent.change(box, { target: { value: 'up2' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(reqs(t).at(-1)?.query).toBe('up2');
    });

    n = t.range.mock.calls.length;
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(t.range.mock.calls.length).toBeGreaterThan(n);
    });
    expect(reqs(t).at(-1)?.query).toBe('up2');
    expect(screen.getByRole('dialog', { name: 'Edit panel' })).toBeInTheDocument();
  });
});
