// unit:logs-page LP22 (#147): the editor chunk and the LogQL language both reject. The text area
// runs; the 128 KB refusal sends nothing. In its own file: both imports reject for every test here.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import {
  flush,
  installLogsLayout,
  logsUrl,
  openLogs,
  runButton,
  runKey,
  scriptedLogsPageApi,
  setDraft,
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
      logql: () => Promise.reject(new Error('stub: language failed')),
    }),
  };
});

const QUERY_TOO_LARGE =
  'This query is over 128 KB. Completion is paused, and it cannot be run until it is shorter.';

let restore: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  restore = installLogsLayout();
});
afterEach(() => {
  restore();
});

describe('unit:logs-page', () => {
  it('LP22 both imports reject: the text area runs, refusals kept', async () => {
    const s = scriptedLogsPageApi();
    openLogs(logsUrl('{app="a"}'), { api: s.api });
    await sized();
    await waitFor(() => {
      expect(textbox().tagName).toBe('TEXTAREA');
    });
    expect(textbox()).toHaveValue('{app="a"}');
    await waitFor(() => {
      expect(s.logs).toHaveLength(1);
    });

    fireEvent.click(runButton());
    await waitFor(() => {
      expect(s.logs).toHaveLength(2);
    });
    expect(s.logs.map((c) => c.req.query)).toEqual(['{app="a"}', '{app="a"}']);

    setDraft('{app="b"}');
    runKey({ ctrlKey: true });
    await waitFor(() => {
      expect(s.logs).toHaveLength(3);
    });
    expect(s.logs.at(-1)?.req.query).toBe('{app="b"}');

    setDraft('a'.repeat(131_073));
    runKey();
    await flush();
    expect(s.logs).toHaveLength(3);
    expect(screen.getByText(QUERY_TOO_LARGE)).toBeInTheDocument();
  });
});
