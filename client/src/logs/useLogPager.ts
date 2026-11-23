/**
 * The pager hooks (plan #66 Part B §3.4): one live `LogPager` per input key. The pager is created
 * in an effect, so StrictMode's second mount leaves one live pager; a new key (input or
 * generation) disposes the old pager (its requests abort) and starts a new one; unmount disposes.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Api } from '../api/Api';
import { useApi } from '../app/providers';
import { LogPager, logPagerKey, type LogPagerInput, type LogPagerState } from './logPager';

/**
 * A started pager for `input` (null → null). `api` defaults to `useApi()`. A new `generation` with
 * an equal input is a new run (plan #66 Part C §3.4): the page's Run with unchanged text and the
 * shell's refresh under a fixed window.
 */
export function useLogPager(
  input: LogPagerInput | null,
  api?: Pick<Api, 'queryLogs'>,
  generation = '',
): LogPager | null {
  const fallback = useApi();
  const source = api ?? fallback;
  const key = input === null ? null : generation + '\n' + logPagerKey(input);
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
    if (run === null || key === null) {
      slot.set(null, null);
      return undefined;
    }
    const p = new LogPager(source, run);
    slot.set(p, key);
    void p.start();
    return () => {
      p.dispose();
    };
    // `key` carries the generation: a new one with the same input object is a new pager.
  }, [key, run, source, slot]);
  const live = useSyncExternalStore(slot.subscribe, slot.get);
  return live !== null && key !== null && live.key === key ? live.pager : null;
}

interface Live {
  readonly pager: LogPager;
  /** The key the effect made the pager for. */
  readonly key: string;
}

/** The current pager of one `useLogPager` call and its key, as an external store. */
class PagerSlot {
  private value: Live | null = null;
  private readonly listeners = new Set<() => void>();

  get = (): Live | null => this.value;

  /** A new `{ pager, key }` (or null); the listeners are called only when the pager differs. */
  set(p: LogPager | null, key: string | null): void {
    if (p === (this.value?.pager ?? null)) return;
    this.value = p === null || key === null ? null : { pager: p, key };
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
