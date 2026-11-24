// unit:logs-page LP20 (plan #66 Part C §5.2): the editor chunk fails to load. In its own file: the
// chunk mock rejects for every test here.
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import {
  flush,
  installLogsLayout,
  logsUrl,
  openLogs,
  scriptedLogsPageApi,
  sized,
} from '../../test/logsPageKit';

vi.mock('../../editor/logqlEditor', () => Promise.reject(new Error('stub: chunk failed')));

let restore: () => void = () => undefined;
beforeEach(() => {
  installResizeObserver();
  restore = installLogsLayout();
});
afterEach(() => {
  restore();
});

describe('unit:logs-page', () => {
  it('LP20 the module import rejects: the alert, no request', async () => {
    const s = scriptedLogsPageApi();
    openLogs(logsUrl('{app="a"}'), { api: s.api });
    await sized();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The query editor could not be loaded. Reload the page to try again.',
      );
    });
    await flush();
    expect(s.logs).toHaveLength(0);
    expect(s.volume).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });
});
