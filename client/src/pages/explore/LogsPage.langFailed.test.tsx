// unit:logs-page LP21 (#147): the LogQL language rejects while the editor chunk is held. No text
// area appears; the editor that loads later runs. In its own file: the mocks hold for every test
// here.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import {
  flush,
  installLogsLayout,
  logsUrl,
  openLogs,
  runButton,
  scriptedLogsPageApi,
  setDraft,
  sized,
  textbox,
} from '../../test/logsPageKit';

const gate = vi.hoisted(() => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
});

vi.mock('../../editor/logqlEditor', async () => {
  await gate.promise;
  return import('../../test/fakeLogqlEditor');
});
vi.mock('../../editor/lang/index', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../editor/lang/index')>();
  return {
    ...m,
    LANGUAGES: Object.freeze({
      ...m.LANGUAGES,
      logql: () => Promise.reject(new Error('stub: language failed')),
    }),
  };
});

const LOAD_FAILED = 'The query editor could not be loaded. Reload the page to try again.';

let restore: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  restore = installLogsLayout();
});
afterEach(() => {
  restore();
});

describe('unit:logs-page', () => {
  it('LP21 the language rejects while the editor is pending', async () => {
    const s = scriptedLogsPageApi();
    openLogs(logsUrl('{app="a"}'), { api: s.api });
    await sized();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(LOAD_FAILED);
    });
    expect(screen.queryByRole('textbox', { name: 'LogQL query' })).toBeNull();
    expect(runButton()).toBeDisabled();
    await flush();
    expect(s.logs).toHaveLength(0);

    gate.resolve();
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'LogQL query' })).not.toBeNull();
    });
    expect(textbox().closest('[data-editor-host]')).not.toBeNull();
    expect(textbox()).toHaveValue('{app="a"}');
    await waitFor(() => {
      expect(runButton()).toBeEnabled();
    });
    await waitFor(() => {
      expect(s.logs).toHaveLength(1);
    });

    setDraft('{app="b"}');
    fireEvent.click(runButton());
    await waitFor(() => {
      expect(s.logs.at(-1)?.req.query).toBe('{app="b"}');
    });
  });
});
