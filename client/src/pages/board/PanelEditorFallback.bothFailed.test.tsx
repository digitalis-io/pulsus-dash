/**
 * The panel editor's PromQL field when both the editor chunk and the PromQL language fail to load
 * (#147 B2): the text area runs the edited panel degraded (the range route, no language) on Run
 * query and the Run keys; the 128 KB refusal still sends nothing. In its own file: both imports
 * reject for every test here.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { editorOn, flush, openBoard, ready, reqs, show } from '../../test/boardPanelKit';
import { panel, panelState } from '../../test/boardTestKit';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { installResizeObserver } from '../../test/fakeResizeObserver';

vi.mock('../../editor/editor', () => Promise.reject(new Error('stub: chunk failed')));
vi.mock('../../editor/lang/index', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../editor/lang/index')>();
  return {
    ...m,
    LANGUAGES: Object.freeze({
      ...m.LANGUAGES,
      promql: () => Promise.reject(new Error('stub: language failed')),
    }),
  };
});

const LOAD_FAILED = 'The query editor could not be loaded. Reload the page to try again.';

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
});

afterEach(() => {
  uninstallIntersectionObserver();
});

describe('panel editor fallback, both imports reject', () => {
  it('B2 both imports reject: the PromQL fallback runs degraded on Run and the three keys', async () => {
    const t = openBoard([panel('p-1', 'S', '1 + 1')]);
    await ready('S');
    show('S');
    await waitFor(() => {
      expect(panelState('S')).toBe('langFailed');
    });
    expect(t.range).not.toHaveBeenCalled();

    const d = await editorOn(t, 'S');
    await waitFor(() => {
      expect(within(d).getByRole('alert')).toHaveTextContent(LOAD_FAILED);
    });
    const box = within(d).getByRole('textbox', { name: 'Query' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveValue('1 + 1');
    const run = within(d).getByRole('button', { name: 'Run query' });
    expect(run).toBeEnabled();
    // The edited panel (the preview and the panel behind) runs degraded: the range route.
    await flush();
    expect(reqs(t).filter((r) => r.query === '1 + 1').length).toBeGreaterThanOrEqual(1);

    let n = t.range.mock.calls.length;
    await t.user.click(run);
    await waitFor(() => {
      expect(t.range.mock.calls.length).toBeGreaterThan(n);
    });
    expect(reqs(t).at(-1)?.query).toBe('1 + 1');

    n = t.range.mock.calls.length;
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    await waitFor(() => {
      expect(t.range.mock.calls.length).toBeGreaterThan(n);
    });
    expect(reqs(t).at(-1)?.query).toBe('1 + 1');

    fireEvent.change(box, { target: { value: 'up' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(reqs(t).at(-1)?.query).toBe('up');
    });

    n = t.range.mock.calls.length;
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(t.range.mock.calls.length).toBeGreaterThan(n);
    });
    expect(reqs(t).at(-1)?.query).toBe('up');
    expect(t.instant).not.toHaveBeenCalled();

    // Over 128 KB (T09-015): refused, nothing is sent.
    fireEvent.change(box, { target: { value: 'a'.repeat(131_073) } });
    n = t.range.mock.calls.length;
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await flush();
    expect(t.range.mock.calls.length).toBe(n);
    expect(t.instant).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit panel' })).toBeInTheDocument();
  });
});
