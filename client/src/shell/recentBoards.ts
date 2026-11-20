/** The last five boards visited, per tenant, kept locally (not a server preference). */
export const RECENT_KEY = (tenant: string): string => `pulsus-dash.recent.${tenant}`;
export const RECENT_MAX = 5;

export function readRecent(storage: Storage | null, tenant: string): string[] {
  try {
    const raw = storage?.getItem(RECENT_KEY(tenant));
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

/** Subscribes to `pushRecent` calls (for `useSyncExternalStore`). */
export function subscribeRecent(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Moves `uid` to the front, de-duplicates and keeps five. Returns the new list. */
export function pushRecent(storage: Storage | null, tenant: string, uid: string): string[] {
  const next = [uid, ...readRecent(storage, tenant).filter((x) => x !== uid)].slice(0, RECENT_MAX);
  try {
    storage?.setItem(RECENT_KEY(tenant), JSON.stringify(next));
  } catch {
    // Storage unavailable: recent boards are not kept.
  }
  for (const cb of [...listeners]) cb();
  return next;
}
