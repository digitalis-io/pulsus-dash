/**
 * Application-wide providers and the hooks that read them: the API, the clock, the time zone, the
 * query cache and React Aria's locale.
 */
import { QueryClientProvider, useSuspenseQuery } from '@tanstack/react-query';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { I18nProvider } from 'react-aria-components';
import type { Api } from '../api/Api';
import { StubApi } from '../api/StubApi';
import type { Session } from '../api/types';
import { TimeZoneContext } from '../state/timeZone';
import { ClockContext } from '../state/useTimeContext';
import { sessionQuery, type RouterDeps } from './router';

const ApiContext = createContext<Api>(new StubApi());

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

export function Providers({ deps, children }: { deps: RouterDeps; children: ReactNode }) {
  const [focus] = useState(createShellFocusRequest);
  return (
    <I18nProvider locale="en-GB">
      <QueryClientProvider client={deps.queryClient}>
        <ApiContext.Provider value={deps.api}>
          <ClockContext.Provider value={deps.clock}>
            <TimeZoneContext.Provider value={deps.timeZone}>
              <ShellFocusContext.Provider value={focus}>{children}</ShellFocusContext.Provider>
            </TimeZoneContext.Provider>
          </ClockContext.Provider>
        </ApiContext.Provider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
