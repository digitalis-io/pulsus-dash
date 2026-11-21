import { QueryClient } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import type { Api } from '../api/Api';
import { createClock } from '../state/clock';
import { Providers, useBoardPrefs } from './providers';
import type { RouterDeps } from './router';

/** Records one view as soon as it mounts, once per app (an effect may run twice in StrictMode). */
function ViewOnMount({ uid }: { uid: string }) {
  const prefs = useBoardPrefs();
  useEffect(() => {
    const t = setTimeout(() => {
      prefs.recordView('demo', uid);
    }, 0);
    return () => {
      clearTimeout(t);
    };
  }, [prefs, uid]);
  return null;
}

function app(): { deps: RouterDeps; qc: QueryClient } {
  const qc = new QueryClient();
  qc.setQueryData(['recent', 'demo'], []);
  qc.setQueryData(['starred', 'demo'], []);
  const api = { recordView: () => Promise.resolve() } as unknown as Api;
  return { qc, deps: { api, queryClient: qc, clock: createClock(() => 0), timeZone: 'UTC' } };
}

const invalidated = (qc: QueryClient, kind: string) =>
  qc.getQueryState([kind, 'demo'])?.isInvalidated ?? false;

describe('Providers', () => {
  // Review code c-r1 #3: StrictMode runs the effect's setup, cleanup and setup again on one prefs.
  it('board prefs survive the StrictMode effect replay', async () => {
    const a = app();
    const b = app();
    const tree = render(
      <StrictMode>
        <Providers deps={b.deps}>{null}</Providers>
        <Providers deps={a.deps}>
          <ViewOnMount uid="b-1" />
        </Providers>
      </StrictMode>,
    );
    // A's own view success invalidates A's Recent, and the channel tells app B.
    await waitFor(() => {
      expect(invalidated(a.qc, 'recent')).toBe(true);
    });
    await waitFor(() => {
      expect(invalidated(b.qc, 'recent')).toBe(true);
    });
    expect(invalidated(b.qc, 'starred')).toBe(false);
    tree.unmount();
  });
});
