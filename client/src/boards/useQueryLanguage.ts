/**
 * One `LANGUAGES[id]()` per page load, as state (plan #64 §3.2; ADR-0018): a board's panels share
 * one import. A language that has loaded is returned on the first render, so a warm board has no
 * render without it; a rejection is kept as `failed` and never retried until the page reloads.
 * A null id (a panel of another language, plan #67) loads nothing and stays loading.
 */
import { useEffect, useState } from 'react';
import { LANGUAGES } from '../editor/lang/index';
import type { LangId, QueryLanguage } from '../editor/lang/types';

export interface LoadedLanguage {
  readonly lang: QueryLanguage | null;
  readonly failed: boolean;
}

const LOADING: LoadedLanguage = Object.freeze({ lang: null, failed: false });
const FAILED: LoadedLanguage = Object.freeze({ lang: null, failed: true });

const loads = new Map<LangId, Promise<LoadedLanguage>>();
const settled = new Map<LangId, LoadedLanguage>();

function load(id: LangId): Promise<LoadedLanguage> {
  let p = loads.get(id);
  if (p === undefined) {
    p = LANGUAGES[id]().then(
      (lang): LoadedLanguage => ({ lang, failed: false }),
      (): LoadedLanguage => FAILED,
    );
    p.then(
      (s) => {
        // A reset while loading (tests) drops this result.
        if (loads.get(id) === p) settled.set(id, s);
      },
      () => undefined,
    );
    loads.set(id, p);
  }
  return p;
}

export function useQueryLanguage(id: LangId | null): LoadedLanguage {
  const [state, setState] = useState<LoadedLanguage>(() =>
    id === null ? LOADING : (settled.get(id) ?? LOADING),
  );
  // A new id (a panel's language changed): the last result is not this language's.
  const [seen, setSeen] = useState(id);
  let current = state;
  if (seen !== id) {
    current = id === null ? LOADING : (settled.get(id) ?? LOADING);
    setSeen(id);
    setState(current);
  }
  useEffect(() => {
    if (id === null) return undefined;
    let live = true;
    load(id).then(
      (s) => {
        if (live) setState(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id]);
  return current;
}

/** Forgets every load, so the next panel imports again (tests only). */
export function resetQueryLanguages(): void {
  loads.clear();
  settled.clear();
}
