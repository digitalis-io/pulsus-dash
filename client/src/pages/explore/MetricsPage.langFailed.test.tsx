// Explore › Metrics M2 (#147): the PromQL language rejects while the editor chunk is held. No text
// area appears; the editor that loads later runs degraded (the range route). In its own file: the
// mocks hold for every test here.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import {
  flush,
  openExplore,
  runButton,
  S1,
  S2,
  setDraft,
  sized,
  spyInstant,
  spyRange,
  textbox,
  url,
} from '../../test/exploreTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import { F } from '../../test/fakePromSource';
import { installResizeObserver } from '../../test/fakeResizeObserver';

const gate = vi.hoisted(() => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
});

vi.mock('../../editor/editor', async () => {
  await gate.promise;
  return import('../../test/fakeEditor');
});
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
  fakeEditorSource.data = F;
});

describe('Explore › Metrics, the language rejects', () => {
  it('M2 the language rejects while the editor is pending: no text area; the editor that loads later runs degraded', async () => {
    const api = new StubApi();
    const calls = spyRange(api, [S1, S2]);
    const inst = spyInstant(api, []);
    openExplore(url('up'), { api });
    await sized();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(LOAD_FAILED);
    });
    expect(screen.queryByRole('textbox', { name: 'PromQL query' })).toBeNull();
    expect(runButton()).toBeDisabled();
    await flush();
    expect(calls).toHaveLength(0);

    gate.resolve();
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'PromQL query' })).not.toBeNull();
    });
    expect(textbox().closest('[data-editor-host]')).not.toBeNull();
    expect(textbox()).toHaveValue('up');
    await waitFor(() => {
      expect(runButton()).toBeEnabled();
    });
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.req.query).toBe('up');

    setDraft('up2');
    fireEvent.click(runButton());
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.req.query).toBe('up2');
    expect(screen.getByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(inst).toHaveLength(0);
  });
});
