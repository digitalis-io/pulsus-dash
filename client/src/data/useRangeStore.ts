/**
 * The page's range store (#304 §3.2) for the board and Explore route chunks: created on first use
 * in the providers' slot (so the initial bundle holds none of it) and wired there (§4.5): each
 * bootstrap observed once at its original receipt time (never a render's), a dropped tenant's
 * `['data', …]` outcomes removed, and the lease ticked every second.
 */
import type { Query, QueryClient } from '@tanstack/react-query';
import type { Api } from '../api/Api';
import type { Session } from '../api/types';
import { useRangeStoreSlot } from '../app/providers';
import { createRangeStore, type RangeStore } from './rangeStore';

/** The lease's expiry is noticed within this long. */
const LEASE_TICK_MS = 1_000;

/** The session's tenants into the store, at the bootstrap's receipt time. Returns the unsubscribe. */
function observeSessions(qc: QueryClient, store: RangeStore): () => void {
  const seen = new WeakSet<object>();
  const observe = (q: Query): void => {
    if (q.queryKey[0] !== 'session') return;
    const s = q.state.data as Session | undefined;
    if (s === undefined || seen.has(s)) return;
    seen.add(s);
    // Its age moved into the store's clock: a late subscription keeps the original receipt time.
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

function wire(store: RangeStore, qc: QueryClient): () => void {
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
}

const create = (api: Api): RangeStore => createRangeStore({ api });

/** The page's one range store and, through it, the board range scheduler. */
export function useRangeStore(): RangeStore {
  const slot = useRangeStoreSlot();
  if (slot === null) throw new Error('useRangeStore outside Providers');
  return slot.ensure(create, wire);
}
