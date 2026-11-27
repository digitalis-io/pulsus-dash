/**
 * Application-wide providers and the hooks that read them: the API, the clock, the time zone, the
 * query cache, the board preferences (Starred and Recent, plan #61 Part C §3.8), the page's range
 * store and its scheduler (#304 §4.5, §4.6) and React Aria's locale.
 */
import {
  QueryClientProvider,
  useSuspenseQuery,
  type Query,
  type QueryClient,
} from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components';
import type { Api } from '../api/Api';
import { StubApi } from '../api/StubApi';
import type { Session } from '../api/types';
import { createRangeStore, type RangeStore } from '../data/rangeStore';
import { createBoardPrefs, type BoardPrefs } from '../boards/prefs';
import { TimeZoneContext } from '../state/timeZone';
import { ClockContext } from '../state/useTimeContext';
import { sessionQuery, type RouterDeps } from './router';

export const ApiContext = createContext<Api>(new StubApi());

export function useApi(): Api {
  return useContext(ApiContext);
}

/** The signed-in session; the tenant loader has already put it in the cache. */
export function useSession(): Session {
  return useSuspenseQuery(sessionQuery(useApi())).data;
}

/**
 * Set by the error page's Retry; read by the shell when it mounts, so focus moves to `main` after a
 * successful retry (§4.3 of plan #57).
 */
export interface ShellFocusRequest {
  request: () => void;
  /** True once after `request()`. */
  consume: () => boolean;
}

export function createShellFocusRequest(): ShellFocusRequest {
  let pending = false;
  return {
    request() {
      pending = true;
    },
    consume() {
      const p = pending;
      pending = false;
      return p;
    },
  };
}

const ShellFocusContext = createContext<ShellFocusRequest>(createShellFocusRequest());

export function useShellFocusRequest(): ShellFocusRequest {
  return useContext(ShellFocusContext);
}

const BoardPrefsContext = createContext<BoardPrefs | null>(null);

/** The app's one `BoardPrefs` (stamped views, the cross-tab channel). */
export function useBoardPrefs(): BoardPrefs {
  const prefs = useContext(BoardPrefsContext);
  if (prefs === null) throw new Error('useBoardPrefs outside Providers');
  return prefs;
}

const RangeStoreContext = createContext<RangeStore | null>(null);

/** The page's one range store (#304 §3.2) and, through it, the board range scheduler. */
export function useRangeStore(): RangeStore {
  const s = useContext(RangeStoreContext);
  if (s === null) throw new Error('useRangeStore outside Providers');
  return s;
}

/** The range store, or null outside `Providers` (a provider that only drops a tenant's data). */
export function useOptionalRangeStore(): RangeStore | null {
  return useContext(RangeStoreContext);
}

/** The lease's expiry is noticed within this long (#304 §4.5). */
const LEASE_TICK_MS = 1_000;

/**
 * The session's tenants into the store (#304 §4.5): each bootstrap is observed once, at its
 * original receipt time (its age moved into the store's clock), never at a render's time, so a
 * provider rerender never renews the lease. Returns the unsubscribe.
 */
function observeSessions(qc: QueryClient, store: RangeStore): () => void {
  const seen = new WeakSet<object>();
  const observe = (q: Query): void => {
    if (q.queryKey[0] !== 'session') return;
    const s = q.state.data as Session | undefined;
    if (s === undefined || seen.has(s)) return;
    seen.add(s);
    const at = store.now() - Math.max(0, Date.now() - q.state.dataUpdatedAt);
    for (const t of s.tenants) {
      if (t.scopeEpoch === undefined) continue;
      store.observeScope(t.slug, { epoch: t.scopeEpoch, seq: t.scopeSeq ?? 0 }, at);
    }
  };
  for (const q of qc.getQueryCache().getAll()) observe(q);
  return qc.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' && e.action.type === 'success') observe(e.query as Query);
  });
}

/**
 * The store's wiring (#304 §4.5): sessions observed, a dropped tenant's `['data', …]` outcomes
 * removed (so nothing of the old scope is drawn again), and the lease ticked.
 */
function useRangeStoreWiring(qc: QueryClient, store: RangeStore): void {
  useEffect(() => {
    const unobserve = observeSessions(qc, store);
    const undrop = store.onDrop((tenant) => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] === 'data' && q.queryKey[2] === tenant });
    });
    const tick = setInterval(() => {
      store.tick();
    }, LEASE_TICK_MS);
    return () => {
      unobserve();
      undrop();
      clearInterval(tick);
    };
  }, [qc, store]);
}

export function Providers({
  deps,
  children,
  rangeStore,
}: {
  deps: RouterDeps;
  children: ReactNode;
  /** The page's range store (#304); tests inject one, the app makes its own. */
  rangeStore?: RangeStore;
}) {
  const [store] = useState(
    () => rangeStore ?? deps.rangeStore ?? createRangeStore({ api: deps.api }),
  );
  useRangeStoreWiring(deps.queryClient, store);
  const [focus] = useState(createShellFocusRequest);
  const [prefs] = useState(() => createBoardPrefs(deps.api, deps.queryClient));
  // One effect, so a StrictMode replay (setup, cleanup, setup) reconnects what it disposed.
  useEffect(() => {
    const close = prefs.connect();
    return () => {
      close();
      prefs.dispose();
    };
  }, [prefs]);
  return (
    <I18nProvider locale="en-GB">
      <QueryClientProvider client={deps.queryClient}>
        <ApiContext.Provider value={deps.api}>
          <ClockContext.Provider value={deps.clock}>
            <TimeZoneContext.Provider value={deps.timeZone}>
              <ShellFocusContext.Provider value={focus}>
                <BoardPrefsContext.Provider value={prefs}>
                  <RangeStoreContext.Provider value={store}>{children}</RangeStoreContext.Provider>
                </BoardPrefsContext.Provider>
              </ShellFocusContext.Provider>
            </TimeZoneContext.Provider>
          </ClockContext.Provider>
        </ApiContext.Provider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
