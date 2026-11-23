/**
 * The pager hooks (plan #66 Part B §3.4): one live `LogPager` per input key. The pager is created
 * in an effect, so StrictMode's second mount leaves one live pager; a new key disposes the old
 * pager (its requests abort) and starts a new one; unmount disposes.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Api } from '../api/Api';
import { useApi } from '../app/providers';
import { LogPager, logPagerKey, type LogPagerInput, type LogPagerState } from './logPager';

/** A started pager for `input` (null → null). `api` defaults to `useApi()`. */
export function useLogPager(
  input: LogPagerInput | null,
  api?: Pick<Api, 'queryLogs'>,
): LogPager | null {
  const fallback = useApi();
  const source = api ?? fallback;
  const key = input === null ? null : logPagerKey(input);
  // The input of the current key: a new but equal input object keeps the pager.
  const [keyed, setKeyed] = useState<{ key: string | null; input: LogPagerInput | null }>({
    key,
    input,
  });
  if (keyed.key !== key) setKeyed({ key, input });
  const run = keyed.key === key ? keyed.input : input;
  // The live pager is held outside React state: the effect publishes it, the hook subscribes.
  const [slot] = useState(() => new PagerSlot());
  useEffect(() => {
    if (run === null) {
      slot.set(null);
      return undefined;
    }
    const p = new LogPager(source, run);
    slot.set(p);
    void p.start();
    return () => {
      p.dispose();
    };
  }, [run, source, slot]);
  const pager = useSyncExternalStore(slot.subscribe, slot.get);
  return pager !== null && key !== null && logPagerKey(pager.input) === key ? pager : null;
}

/** The current pager of one `useLogPager` call, as an external store. */
class PagerSlot {
  private value: LogPager | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): LogPager | null => this.value;

  set(p: LogPager | null): void {
    if (p === this.value) return;
    this.value = p;
    for (const l of [...this.listeners]) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

const NO_STATE = (): null => null;
const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/** `useSyncExternalStore(pager.subscribe, pager.getState)`; null for null. */
export function useLogPagerState(pager: LogPager | null): LogPagerState | null {
  return useSyncExternalStore(
    pager === null ? NO_SUBSCRIBE : pager.subscribe,
    pager === null ? NO_STATE : pager.getState,
  );
}
