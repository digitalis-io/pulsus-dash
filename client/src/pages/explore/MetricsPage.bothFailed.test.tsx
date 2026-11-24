// Explore › Metrics M3 (#147): the editor chunk and the PromQL language both reject. The text area
// runs degraded (the range route); the 128 KB refusal and a blank Run send nothing. In its own
// file: both imports reject for every test here.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import {
  flush,
  openExplore,
  ready,
  runButton,
  runKey,
  S1,
  S2,
  S3,
  setDraft,
  spyInstant,
  spyRange,
  textbox,
  url,
} from '../../test/exploreTestKit';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { locationOf } from '../../test/renderApp';

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

const QUERY_TOO_LARGE =
  'This query is over 128 KB. Completion is paused, and it cannot be run until it is shorter.';

beforeEach(() => {
  installResizeObserver();
});

describe('Explore › Metrics, both imports reject', () => {
  it('M3 both imports reject: the text area runs degraded, refusals kept', async () => {
    const api = new StubApi();
    const calls = spyRange(api, [S1, S2, S3]);
    const inst = spyInstant(api, []);
    const { router } = openExplore(url('1 + 1'), { api });
    await ready();
    expect(textbox().tagName).toBe('TEXTAREA');
    expect(textbox()).toHaveValue('1 + 1');
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.req.query).toBe('1 + 1');

    fireEvent.click(runButton());
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.req.query).toBe('1 + 1');

    setDraft('up');
    runKey({ metaKey: true });
    await waitFor(() => {
      expect(calls).toHaveLength(3);
    });
    expect(calls[2]?.req.query).toBe('up');

    setDraft('a'.repeat(131_073));
    runKey();
    await flush();
    expect(calls).toHaveLength(3);
    expect(screen.getByText(QUERY_TOO_LARGE)).toBeInTheDocument();

    setDraft('');
    runKey();
    await flush();
    expect(locationOf(router)).not.toContain('q=');
    expect(calls).toHaveLength(3);
    expect(inst).toHaveLength(0);
  });
});
