// Stub for the tests-first commit: the implementation follows.
import { type ReactNode } from 'react';

import type { Api } from '../api/Api';

import type { Session } from '../api/types';

import { type RouterDeps } from './router';

export function useApi(): Api {
  throw new Error('not implemented');
}

export function useSession(): Session {
  throw new Error('not implemented');
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
  throw new Error('not implemented');
}

export function useShellFocusRequest(): ShellFocusRequest {
  throw new Error('not implemented');
}

export function Providers({
  deps,
  children,
}: {
  deps: RouterDeps;
  children: ReactNode;
}): import('react').JSX.Element {
  throw new Error('not implemented');
}
