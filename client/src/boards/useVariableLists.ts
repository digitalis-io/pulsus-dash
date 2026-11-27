/**
 * The value lists of a board's variables and their states (plan #289 §4.3, SRF-017): a custom
 * variable's values, sorted, without a request; a query variable's from `POST /variables/values`
 * (one TanStack query each, `['varValues', tenant, uid, name, text, varsJson, fromMs, toMs]`),
 * fetched in spec order: a key exists only once the variables its query references are ready, so a
 * dependent fetches after them and again whenever their values change. `refresh: load` keeps the
 * window of the first ready render; `timeChange` follows the window. A new key or an unmount
 * aborts the request in flight (TanStack cancels an unused query whose signal was read).
 */
import { useQueries, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import type { BoardVariable, VariableValues, VarValue } from '../api/types';
import { useApi } from '../app/providers';
import { useTimeContext } from '../state/useTimeContext';
import {
  customList,
  dependencyBlock,
  resolveVariables,
  sortValues,
  type VariableList,
  type VarState,
} from './resolveVariables';
import { panelVars } from './variableRefs';

export interface VariableListsInput {
  readonly tenant: string;
  readonly uid: string;
  readonly defs: readonly BoardVariable[];
  readonly address: ReadonlyMap<string, readonly string[]>;
  /** Names the board references and does not define (legacy strings). */
  readonly legacy?: readonly string[];
  readonly timeReady: boolean;
}

export interface VariableLists {
  readonly states: ReadonlyMap<string, VarState>;
  readonly lists: ReadonlyMap<string, VariableList>;
  /** Fetches a variable's list again (Retry). */
  readonly retry: (name: string) => void;
}

/** The limit of one list (plan #289 §4.3). */
export const LIST_LIMIT = 1000;
const NO_NAMES: readonly string[] = Object.freeze([]);

interface Window {
  readonly fromMs: number;
  readonly toMs: number;
}

export function useVariableLists(i: VariableListsInput): VariableLists {
  const api = useApi();
  const queryClient = useQueryClient();
  const { window } = useTimeContext();
  const { tenant, uid, defs, address, timeReady } = i;
  const legacy = i.legacy ?? NO_NAMES;

  // The window of `refresh: load`: the one of the first ready render of this board.
  const [load, setLoad] = useState<{ uid: string; w: Window } | null>(null);
  if (timeReady && load?.uid !== uid) {
    setLoad({ uid, w: { fromMs: window.fromMs, toMs: window.toMs } });
  }
  const loadWindow = load?.uid === uid ? load.w : null;

  // The keys in spec order: each from the states of the variables before it, read from the cache.
  const plan = (() => {
    const lists = new Map<string, VariableList>();
    const keys = new Map<string, QueryKey>();
    const configs: {
      queryKey: QueryKey;
      queryFn: (c: { signal: AbortSignal }) => Promise<VariableValues>;
    }[] = [];
    for (let k = 0; k < defs.length; k++) {
      const def = defs[k];
      if (def === undefined) continue;
      if (def.kind === 'custom') {
        lists.set(def.name, customList(def));
        continue;
      }
      if (def.kind !== 'query' || def.query === undefined || !timeReady) continue;
      // Step 0 of §4.2: no key while a referenced variable is not ready.
      const before = resolveVariables(defs.slice(0, k), address, lists);
      if (dependencyBlock(def, before) !== null) continue;
      const ready = new Map<string, VarValue>();
      for (const [n, st] of before) if (st.kind === 'ready') ready.set(n, st.value);
      const sent = panelVars(def.query.text, ready);
      const w = def.refresh === 'load' && loadWindow !== null ? loadWindow : window;
      const lang = def.query.lang;
      const text = def.query.text;
      const queryKey: QueryKey = [
        'varValues',
        tenant,
        uid,
        def.name,
        text,
        JSON.stringify(sent),
        w.fromMs,
        w.toMs,
      ];
      keys.set(def.name, queryKey);
      configs.push({
        queryKey,
        queryFn: ({ signal }) =>
          api.variableValues(
            tenant,
            {
              lang,
              query: text,
              fromMs: w.fromMs,
              toMs: w.toMs,
              vars: Object.fromEntries(sent),
              limit: LIST_LIMIT,
            },
            signal,
          ),
      });
      const st = queryClient.getQueryState<VariableValues>(queryKey);
      lists.set(
        def.name,
        st?.status === 'success' && st.data !== undefined
          ? {
              status: 'ready',
              values: sortValues(st.data.values, def.sort),
              truncated: st.data.truncated,
            }
          : st?.status === 'error'
            ? { status: 'failed', error: st.error }
            : { status: 'loading' },
      );
    }
    return { lists, keys, configs };
  })();

  // Subscribes to every key (a fetch, and a render when one settles); the states above read the
  // same cache entries.
  const results = useQueries({
    queries: plan.configs.map((c) => ({ ...c, staleTime: Infinity, retry: false })),
  });
  const settled = results.map((r) => `${String(r.dataUpdatedAt)}.${String(r.errorUpdatedAt)}`);
  // The lists kept while their content is the same, so the states (and every panel) keep theirs.
  const sig = JSON.stringify([[...plan.lists], settled]);
  const [kept, setKept] = useState({ sig, lists: plan.lists });
  if (kept.sig !== sig) setKept({ sig, lists: plan.lists });
  const lists = kept.sig === sig ? kept.lists : plan.lists;
  const states = useMemo(
    () => resolveVariables(defs, address, lists, legacy),
    [defs, address, lists, legacy],
  );

  const keys = plan.keys;
  const retry = useCallback(
    (name: string): void => {
      const key = keys.get(name);
      if (key !== undefined) void queryClient.refetchQueries({ queryKey: key, exact: true });
    },
    [keys, queryClient],
  );
  return { states, lists, retry };
}
