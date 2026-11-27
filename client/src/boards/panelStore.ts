/**
 * The store-backed panel run's helpers (#304 §4.1, Part B §4.3): the outcome of an assembly, the
 * view a panel plans, its retain/release and subscription, and the lease gate on every reuse of
 * store-derived data (§4.5): past the lease nothing cached is painted before revalidation.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { useRangeStore } from '../data/useRangeStore';
import type { Assembled, RangeStore, RangeView } from '../data/rangeStore';
import type { TimeWindow } from '../engine/api';
import { fromRange } from '../vis/autovis';
import type { PanelOutcome } from './panelRun';
import { planRangeView, type ViewInput } from './rangeView';

const outcomes = new WeakMap<Assembled, PanelOutcome>();

/** `{ key, planned, scope, result: visible, held, fit, rank }`, per assembly (stable identity). */
export function outcomeOf(
  key: readonly unknown[],
  a: Assembled,
  scope: string,
  transition?: 'crossfade',
): PanelOutcome {
  const cached = outcomes.get(a);
  if (cached !== undefined && cached.key === key && cached.transition === transition) {
    return cached;
  }
  const o: PanelOutcome = {
    key,
    planned: a.visible.planned,
    scope,
    rank: a.rank,
    result: fromRange(a.visible),
    held: fromRange(a.held),
    fit: a.fit,
    ...(transition === undefined ? {} : { transition }),
  };
  outcomes.set(a, o);
  return o;
}

/** A store-derived outcome (it carries the scope it was assembled under). */
export const fromStore = (o: PanelOutcome | undefined | null): boolean =>
  o !== undefined && o !== null && o.scope !== undefined;

export interface StoreRun {
  readonly store: RangeStore;
  /** This run's owner id (one per hook instance). */
  readonly owner: string;
  /** The view, or null: not eligible (or no grid). */
  readonly view: RangeView | null;
  /** `view` is admitted (not bypassed). */
  readonly backed: boolean;
  /** The tenant's scope epoch now. */
  readonly scope: string;
  /** A cached read is allowed (§4.5). */
  readonly lease: boolean;
  readonly stale: readonly TimeWindow[];
}

const NO_STALE: readonly TimeWindow[] = Object.freeze([]);

/**
 * The view of a panel run (`input` null: ineligible), retained while `enabled`; the tenant's scope
 * and lease and the view's stale spans as external stores. A store event on the view's identity
 * puts the latest assembly into the query `key` when it holds store data and no error.
 */
export function useStoreRun(
  input: Omit<ViewInput, 'scope'> | null,
  enabled: boolean,
  key: readonly unknown[],
): StoreRun {
  const store = useRangeStore();
  const owner = useId();
  const qc = useQueryClient();
  const tenant = input?.tenant ?? '';
  const scope = useSyncExternalStore(
    (cb) => store.subscribe(tenant, cb),
    () => store.scopeOf(tenant),
  );
  const lease = useSyncExternalStore(
    (cb) => store.subscribe(tenant, cb),
    () => store.leaseValid(tenant),
  );
  const inputKey = input === null || !store.enabled ? null : JSON.stringify(input);
  const view = useMemo(
    () => (input === null || inputKey === null ? null : planRangeView({ ...input, scope })),
    // `inputKey` stands for `input`'s fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inputKey, scope],
  );
  const idKey = view?.idKey ?? '';
  const bypassed = useSyncExternalStore(
    (cb) => store.subscribe(idKey, cb),
    () => idKey !== '' && store.bypassed(idKey),
  );
  const staleJson = useSyncExternalStore(
    (cb) => store.subscribe(idKey, cb),
    () => (view === null ? '[]' : store.staleSpans(view)),
  );
  const stale = useMemo(
    () => (staleJson === '[]' ? NO_STALE : (JSON.parse(staleJson) as TimeWindow[])),
    [staleJson],
  );
  const backed = view !== null && !bypassed;

  useEffect(() => {
    if (!enabled || view === null || bypassed) return;
    store.retain(owner, view);
    return () => {
      store.release(owner);
    };
  }, [store, owner, view, enabled, bypassed]);

  useEffect(() => {
    if (view === null || bypassed) return;
    return store.subscribe(view.idKey, () => {
      const q = qc.getQueryCache().find({ queryKey: key, exact: true });
      const data = q?.state.data as PanelOutcome | undefined;
      if (q === undefined || q.state.status === 'error' || !fromStore(data)) return;
      const a = store.peek(view);
      if (a === null || a.rank !== 1) return;
      qc.setQueryData(key, outcomeOf(key, a, view.id.scope));
    });
  }, [store, view, bypassed, qc, key]);

  return { store, owner, view, backed, scope, lease, stale };
}
