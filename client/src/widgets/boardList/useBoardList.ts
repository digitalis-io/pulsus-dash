/**
 * A board list's model (plan #216 Part 2a §3.1, §4.1; T24-021, T24-023, T24-024, T24 §4.5):
 * react-query owns the fetch under the mode's key (`boardListKey`); the hook reads only the current
 * key, so a key change shows pending at once and a late answer of an old key never renders.
 *
 * The shown count belongs to the key: the first snapshot of a key (or a new `limit`) shows `limit`
 * rows, each later snapshot of that key clamps the count to the loaded rows (an empty one starts
 * again at `limit`), and only Show more grows it (by `limit`, up to the loaded rows). A failed refetch keeps the rows, stale since the
 * failure.
 */
import { hashKey, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { isApiError, type BoardListMode, type BoardPage, type RefPage } from '../../api/types';
import { CAPABILITIES } from '../../app/capabilities';
import { useApi } from '../../app/providers';
import type { SummaryFacts } from '../../engine/api';
import { withStale, type ListSnapshot } from '../lists/snapshot';
import { boardListFacts } from './facts';
import type { BoardListOptions } from './options';
import { boardSnapshot, rankingCaption, type BoardRow } from './rows';
import { boardListFetch, boardListKey } from './source';

export type BoardListPhase = 'pending' | 'ok' | 'empty' | 'error';

export interface BoardListModel {
  readonly key: readonly unknown[];
  readonly mode: BoardListMode;
  readonly q: string;
  readonly tag: string | null;
  readonly phase: BoardListPhase;
  /** This key's only; stale applied. */
  readonly snapshot: ListSnapshot<BoardRow> | null;
  readonly notice: 'tagNeedsServer' | null;
  /** Phase `error` only. */
  readonly error: 'store' | 'generic' | null;
  readonly refreshFailed: boolean;
  readonly shown: number;
  readonly caption: string | null;
  readonly facts: SummaryFacts | null;
  /** The key is fetching (a first load or a refetch). */
  readonly fetching: boolean;
  /** When the current snapshot was fetched; 0 without one. */
  readonly updatedAtMs: number;
  /** Changes with each new answer (by identity) of any key. */
  readonly answerGen: number;
  readonly retry: () => void;
  /** Shows `limit` more rows; returns the first new row's index. */
  readonly showMore: () => number;
}

interface Shown {
  readonly keyHash: string;
  readonly limit: number;
  /** The answer the count was last set for (by identity); null before the key's first. */
  readonly data: BoardPage | RefPage | null;
  /** Counts the key's answers: a new one is a refresh. */
  readonly gen: number;
  readonly n: number;
}

export function useBoardList(i: {
  tenant: string;
  currentUid: string | null;
  title: string;
  options: BoardListOptions;
  q: string;
}): BoardListModel {
  const { tenant, currentUid, title, options, q } = i;
  const api = useApi();
  const key = useMemo(() => boardListKey(tenant, options, q), [tenant, options, q]);
  const keyHash = hashKey(key);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => boardListFetch(api, tenant, options, q, signal),
    refetchOnWindowFocus: 'always',
  });
  const { data, dataUpdatedAt, errorUpdatedAt, isError, error, isFetching } = query;

  // The loaded rows of this answer, before the shown count (it does not change them).
  const loaded = useMemo(
    () =>
      data === undefined
        ? 0
        : boardSnapshot(key, data, {
            mode: options.mode,
            q,
            tag: options.tag,
            currentUid,
            shown: 0,
            nowMs: dataUpdatedAt,
          }).snapshot.rows.length,
    [data, key, options.mode, options.tag, q, currentUid, dataUpdatedAt],
  );

  const limit = options.limit;
  const answer = data ?? null;
  const [shownState, setShown] = useState<Shown>({
    keyHash,
    limit,
    data: answer,
    gen: 0,
    n: limit,
  });
  // Adjusted while rendering (as `useDelayedFlag`): the key's first snapshot, then the clamp.
  let s = shownState;
  if (s.keyHash !== keyHash || s.limit !== limit) {
    s = { keyHash, limit, data: answer, gen: s.gen + 1, n: limit };
  } else if (s.data === null && answer !== null) {
    s = { ...s, data: answer, gen: s.gen + 1, n: limit };
  } else if (answer !== null && s.data !== answer) {
    // An empty answer keeps no shown rows: the next answer starts again at `limit`.
    s = { ...s, data: answer, gen: s.gen + 1, n: loaded === 0 ? limit : Math.min(s.n, loaded) };
  }
  if (s !== shownState) setShown(s);
  const shown = Math.min(s.n, loaded);

  const result = useMemo(() => {
    if (data === undefined) return null;
    const r = boardSnapshot(key, data, {
      mode: options.mode,
      q,
      tag: options.tag,
      currentUid,
      shown,
      nowMs: dataUpdatedAt,
    });
    return isError ? { ...r, snapshot: withStale(r.snapshot, errorUpdatedAt) } : r;
  }, [
    data,
    key,
    options.mode,
    options.tag,
    q,
    currentUid,
    shown,
    dataUpdatedAt,
    isError,
    errorUpdatedAt,
  ]);

  const snapshot = result?.snapshot ?? null;
  const notice = result?.notice ?? null;
  let phase: BoardListPhase;
  if (snapshot === null) phase = isError ? 'error' : 'pending';
  else phase = snapshot.rows.length > 0 && notice === null ? 'ok' : 'empty';

  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const showMore = useCallback((): number => {
    const old = Math.min(s.n, loaded);
    setShown({ ...s, n: Math.min(s.n + limit, loaded) });
    return old;
  }, [s, loaded, limit]);

  const facts = useMemo(
    () => boardListFacts(title, options.mode, snapshot),
    [title, options.mode, snapshot],
  );

  return {
    key,
    mode: options.mode,
    q,
    tag: options.tag,
    phase,
    snapshot,
    notice,
    error: phase === 'error' ? (isApiError(error, 'unavailable') ? 'store' : 'generic') : null,
    refreshFailed: snapshot !== null && isError,
    shown,
    caption: rankingCaption(options.sort, CAPABILITIES),
    facts,
    fetching: isFetching,
    updatedAtMs: snapshot === null ? 0 : dataUpdatedAt,
    answerGen: s.gen,
    retry,
    showMore,
  };
}
