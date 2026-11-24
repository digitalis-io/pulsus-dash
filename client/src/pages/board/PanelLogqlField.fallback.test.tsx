/**
 * The panel editor's LogQL field when the LogQL editor chunk fails to load (plan #67 review r1 #1):
 * the plain text area runs on Run query and on its Run keys, unchanged text included. In its own
 * file: the chunk mock rejects for every test here.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { editorOn, ready, show } from '../../test/boardPanelKit';
import { aborted, installLogLayout, lines, logPanel, openLogBoard } from '../../test/boardLogKit';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { installResizeObserver } from '../../test/fakeResizeObserver';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));
vi.mock('../../editor/logqlEditor', () => Promise.reject(new Error('stub: chunk failed')));

const Q = '{app="a"}';
let restoreLayout: () => void = () => undefined;

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  restoreLayout = installLogLayout();
});

afterEach(() => {
  restoreLayout();
  uninstallIntersectionObserver();
});

describe('LogQL field fallback', () => {
  it('Run query and the Run keys run the text area, unchanged text included', async () => {
    const t = openLogBoard([logPanel('p-1', 'S', Q)]);
    await ready('S');
    show('S');
    await waitFor(() => {
      expect(t.logs).toHaveLength(1);
    });
    await t.logs[0]?.resolve(lines(3));
    const d = await editorOn(t, 'S');
    await waitFor(() => {
      expect(within(d).getByRole('alert')).toHaveTextContent(
        'The query editor could not be loaded. Reload the page to try again.',
      );
    });
    const box = within(d).getByRole('textbox', { name: 'Query' });
    expect(box.tagName).toBe('TEXTAREA');
    // The preview's own first page.
    await waitFor(() => {
      expect(t.logs).toHaveLength(2);
    });

    const run = within(d).getByRole('button', { name: 'Run query' });
    expect(run).toBeEnabled();
    await t.user.click(run);
    await waitFor(() => {
      expect(t.logs).toHaveLength(3);
    });
    expect(aborted(t.logs[1])).toBe(true);
    expect(t.logs[2]?.req.query).toBe(Q);

    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    await waitFor(() => {
      expect(t.logs).toHaveLength(4);
    });
    expect(t.logs[3]?.req.query).toBe(Q);

    fireEvent.change(box, { target: { value: '{app="b"}' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => {
      expect(t.logs.at(-1)?.req.query).toBe('{app="b"}');
    });
    expect(screen.getByRole('dialog', { name: 'Edit panel' })).toBeInTheDocument();
  });
});
