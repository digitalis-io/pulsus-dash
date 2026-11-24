// Explore › Metrics M1 (#147): the editor chunk rejects and the PromQL language is held. The text
// area runs degraded (the range route) on Run and the three Run keys; a language that loads later
// wins (a scalar already run moves to the instant route). In its own file: the chunk mock rejects
// for every test here.
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StubApi } from '../../api/StubApi';
import type { InstantResult } from '../../data/decode';
import {
  EMPTY_COMPLETENESS,
  HOUR,
  openExplore,
  plannedAs,
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
  W0,
} from '../../test/exploreTestKit';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { locationOf } from '../../test/renderApp';

const gate = vi.hoisted(() => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
});

vi.mock('../../editor/editor', () => Promise.reject(new Error('stub: chunk failed')));
vi.mock('../../editor/lang/index', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../editor/lang/index')>();
  return {
    ...m,
    LANGUAGES: Object.freeze({
      ...m.LANGUAGES,
      promql: () => gate.promise.then(() => m.LANGUAGES.promql()),
    }),
  };
});

const LOAD_FAILED = 'The query editor could not be loaded. Reload the page to try again.';

const I1: InstantResult = {
  kind: 'scalar',
  scalar: { value: 2, timestampMs: W0 + HOUR },
  atMs: W0 + HOUR,
  completeness: EMPTY_COMPLETENESS,
  planned: plannedAs('1 + 1', { valueType: 'scalar' }, null),
};

beforeEach(() => {
  installResizeObserver();
});

describe('Explore › Metrics fallback', () => {
  it('M1 the editor rejects and the language never settles: the text area runs degraded; a language that loads wins', async () => {
    const api = new StubApi();
    const calls = spyRange(api, [S1, S2, S3, S1, S2, S3]);
    const inst = spyInstant(api, [I1]);
    const { router } = openExplore(url('up'), { api });
    const run = await ready();
    expect(screen.getByRole('alert')).toHaveTextContent(LOAD_FAILED);
    expect(textbox().tagName).toBe('TEXTAREA');
    expect(textbox()).toHaveValue('up');
    expect(run).toBeEnabled();
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.req.query).toBe('up');

    fireEvent.click(runButton());
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.req.query).toBe('up');

    runKey({ shiftKey: true });
    await waitFor(() => {
      expect(calls).toHaveLength(3);
    });
    expect(calls[2]?.req.query).toBe('up');

    setDraft('up2');
    runKey({ ctrlKey: true });
    await waitFor(() => {
      expect(calls).toHaveLength(4);
    });
    expect(calls[3]?.req.query).toBe('up2');
    expect(locationOf(router)).toContain('q=up2');

    runKey({ metaKey: true });
    await waitFor(() => {
      expect(calls).toHaveLength(5);
    });
    expect(calls[4]?.req.query).toBe('up2');

    // A scalar while the language is pending: the range route too.
    setDraft('1 + 1');
    fireEvent.click(runButton());
    await waitFor(() => {
      expect(calls).toHaveLength(6);
    });
    expect(calls[5]?.req.query).toBe('1 + 1');
    expect(inst).toHaveLength(0);

    // The language loads: the scalar already run moves to the instant route (a new key).
    gate.resolve();
    await waitFor(() => {
      expect(inst).toHaveLength(1);
    });
    expect(inst[0]?.req.query).toBe('1 + 1');

    // Run again: the language wins, so the instant route reruns it.
    fireEvent.click(runButton());
    await waitFor(() => {
      expect(inst).toHaveLength(2);
    });
    expect(inst[1]?.req.query).toBe('1 + 1');
    expect(calls).toHaveLength(6);
  });
});
