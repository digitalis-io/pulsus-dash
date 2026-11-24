// unit:logs-page LP20 (plan #66 Part C §5.2; #147): the editor chunk fails to load and the LogQL
// language never settles. The text area runs on Run and the three Run keys, unchanged text
// included. In its own file: the mocks hold for every test here.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import {
  installLogsLayout,
  logsUrl,
  openLogs,
  runButton,
  runKey,
  scriptedLogsPageApi,
  sized,
  textbox,
} from '../../test/logsPageKit';

vi.mock('../../editor/logqlEditor', () => Promise.reject(new Error('stub: chunk failed')));
vi.mock('../../editor/lang/index', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../editor/lang/index')>();
  return {
    ...m,
    LANGUAGES: Object.freeze({
      ...m.LANGUAGES,
      // Held for good: the language import never settles.
      logql: () => new Promise<never>(() => undefined),
    }),
  };
});

let restore: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  restore = installLogsLayout();
});
afterEach(() => {
  restore();
});

describe('unit:logs-page', () => {
  it('LP20 the editor rejects and the language never settles: the text area runs', async () => {
    const s = scriptedLogsPageApi();
    openLogs(logsUrl('{app="a"}'), { api: s.api });
    await sized();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The query editor could not be loaded. Reload the page to try again.',
      );
    });
    expect(textbox().tagName).toBe('TEXTAREA');
    expect(textbox()).toHaveValue('{app="a"}');
    await waitFor(() => {
      expect(runButton()).toBeEnabled();
    });
    await waitFor(() => {
      expect(s.logs).toHaveLength(1);
      expect(s.volume).toHaveLength(1);
    });

    fireEvent.click(runButton());
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
    });
    expect(s.logs.map((c) => c.req.query)).toEqual(['{app="a"}', '{app="a"}']);

    runKey({ shiftKey: true });
    await waitFor(() => {
      expect(s.logs).toHaveLength(3);
    });

    fireEvent.change(textbox(), { target: { value: '{app="b"}' } });
    runKey({ ctrlKey: true });
    await waitFor(() => {
      expect(s.logs).toHaveLength(4);
    });
    expect(s.logs.at(-1)?.req.query).toBe('{app="b"}');

    runKey({ metaKey: true });
    await waitFor(() => {
      expect(s.logs).toHaveLength(5);
    });
    expect(s.logs.at(-1)?.req.query).toBe('{app="b"}');
  });
});
