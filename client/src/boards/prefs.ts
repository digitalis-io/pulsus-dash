/**
 * Starred and Recent of one app instance (plan #61 Part C §3.8; IA-021, D-RECENT-window).
 *
 * - **Views.** Each view is stamped with a navigation time that strictly increases within the app
 *   (even if the clock steps back) and is sent at once, with no queue. The server keeps each
 *   board's greatest time, so Recent follows navigation order within this app whatever order the
 *   requests commit in. A request is aborted after `VIEW_TIMEOUT_MS`; the abort only frees the
 *   connection, since the server may still commit it.
 * - **Reconciliation.** After an ambiguous failure (the timeout, `network`, or `unknown`, which
 *   covers 5xx) one timer per app refetches Recent at the request's send time +
 *   `VIEW_TIMEOUT_MS` + `RECONCILE_DELAY_MS`; several pending reconciliations coalesce into the
 *   latest due time. A commit later than that is seen at the next invalidation or focus refetch.
 * - **Other tabs.** Each change is posted on a `BroadcastChannel`, and a message received
 *   invalidates that list here. A channel never delivers its own posts.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { Api } from '../api/Api';
import { isApiError } from '../api/types';

export const PREFS_CHANNEL = 'pulsus-dash.board-prefs';
export const VIEW_TIMEOUT_MS = 10_000;
/** After the request's abort: a reconciliation is due 15 s after the send. */
export const RECONCILE_DELAY_MS = 5_000;

export interface PrefsMessage {
  readonly kind: 'starred' | 'recent';
}

export interface PrefsChannel {
  post(m: PrefsMessage): void;
  onMessage(f: (m: PrefsMessage) => void): void;
  close(): void;
}

function isPrefsMessage(v: unknown): v is PrefsMessage {
  if (typeof v !== 'object' || v === null) return false;
  const kind = (v as Record<string, unknown>)['kind'];
  return kind === 'starred' || kind === 'recent';
}

/** `new BroadcastChannel(PREFS_CHANNEL)` wrapped; null when `BroadcastChannel` is absent. */
export function openPrefsChannel(): PrefsChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  const c = new BroadcastChannel(PREFS_CHANNEL);
  return {
    post: (m) => {
      c.postMessage(m);
    },
    onMessage: (f) => {
      c.onmessage = (e: MessageEvent<unknown>) => {
        if (isPrefsMessage(e.data)) f(e.data);
      };
    },
    close: () => {
      c.onmessage = null;
      c.close();
    },
  };
}

export interface BoardPrefs {
  /** Stamps the view (monotonic per app) and sends it at once; requests may overlap. */
  recordView(tenant: string, uid: string): void;
  /** After a star change settled (success or failure): invalidate ['starred'] here, post to other tabs. */
  starredChanged(): Promise<void>;
  /** Opens the channel (if any) and returns its close; idempotent per call pair (StrictMode safe). */
  connect(): () => void;
  /** Clears the reconciliation timer and closes any channel (Providers' unmount). */
  dispose(): void;
}

/** An abort from fetch: a DOMException, which is not an Error subclass in every runtime. */
function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'name' in e && e.name === 'AbortError';
}

/** A failure after which the server may still have committed the view. */
function isAmbiguous(e: unknown): boolean {
  return isAbort(e) || isApiError(e, 'network') || isApiError(e, 'unknown');
}

export function createBoardPrefs(
  api: Api,
  qc: QueryClient,
  open: () => PrefsChannel | null = openPrefsChannel,
  now: () => number = Date.now,
): BoardPrefs {
  let last = 0;
  let channel: PrefsChannel | null = null;
  let disposed = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileDue = 0;

  // Posts while no channel is open are dropped: the focus refetch covers the other tab.
  const post = (m: PrefsMessage): void => {
    channel?.post(m);
  };

  const recentChanged = (): void => {
    void qc.invalidateQueries({ queryKey: ['recent'] });
    post({ kind: 'recent' });
  };

  /** One timer per app: armed at `due`, or re-armed when `due` is later than the pending one. */
  const reconcile = (sentAt: number): void => {
    if (disposed) return;
    const due = sentAt + VIEW_TIMEOUT_MS + RECONCILE_DELAY_MS;
    if (reconcileTimer !== null) {
      if (reconcileDue >= due) return;
      clearTimeout(reconcileTimer);
    }
    reconcileDue = due;
    const delay = Math.min(VIEW_TIMEOUT_MS + RECONCILE_DELAY_MS, Math.max(0, due - now()));
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      recentChanged();
    }, delay);
  };

  return {
    recordView(tenant, uid) {
      const sentAt = now();
      const at = Math.max(Math.floor(sentAt), last + 1);
      last = at;
      const c = new AbortController();
      const timeout = setTimeout(() => {
        c.abort();
      }, VIEW_TIMEOUT_MS);
      api.recordView(tenant, uid, at, c.signal).then(
        () => {
          clearTimeout(timeout);
          if (!disposed) recentChanged();
        },
        (e: unknown) => {
          clearTimeout(timeout);
          // notFound (deleted meanwhile) and other refusals: nothing was recorded.
          if (isAmbiguous(e)) reconcile(sentAt);
        },
      );
    },

    async starredChanged() {
      post({ kind: 'starred' });
      await qc.invalidateQueries({ queryKey: ['starred'] });
    },

    connect() {
      const ch = disposed ? null : open();
      if (ch === null) return () => undefined;
      channel = ch;
      ch.onMessage((m) => {
        void qc.invalidateQueries({ queryKey: [m.kind] });
      });
      return () => {
        if (channel === ch) channel = null;
        ch.close();
      };
    },

    dispose() {
      disposed = true;
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      reconcileTimer = null;
      channel?.close();
      channel = null;
    },
  };
}
