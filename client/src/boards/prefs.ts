/** Starred and Recent preferences of one app instance (plan #61 Part C §3.8). Stub. */
import type { QueryClient } from '@tanstack/react-query';
import type { Api } from '../api/Api';

export const PREFS_CHANNEL = 'pulsus-dash.board-prefs';
export const VIEW_TIMEOUT_MS = 10_000;
export const RECONCILE_DELAY_MS = 5_000;

export interface PrefsMessage {
  readonly kind: 'starred' | 'recent';
}

export interface PrefsChannel {
  post(m: PrefsMessage): void;
  onMessage(f: (m: PrefsMessage) => void): void;
  close(): void;
}

export function openPrefsChannel(): PrefsChannel | null {
  return null;
}

export interface BoardPrefs {
  recordView(tenant: string, uid: string): void;
  starredChanged(): Promise<void>;
  connect(): () => void;
  dispose(): void;
}

export function createBoardPrefs(
  api: Api,
  qc: QueryClient,
  open: () => PrefsChannel | null = openPrefsChannel,
  now: () => number = Date.now,
): BoardPrefs {
  api;
  qc;
  open;
  now;
  return {
    recordView: () => undefined,
    starredChanged: () => Promise.resolve(),
    connect: () => () => undefined,
    dispose: () => undefined,
  };
}
