/**
 * One `LANGUAGES[id]()` per page load, as state (plan #64 §3.2; ADR-0018): a board's panels share
 * one import. A language that has loaded is returned on the first render, so a warm board has no
 * render without it; a rejection is kept as `failed` and never retried until the page reloads.
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

export function useQueryLanguage(id: LangId): LoadedLanguage {
  const [state, setState] = useState<LoadedLanguage>(() => settled.get(id) ?? LOADING);
  useEffect(() => {
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
  return state;
}

/** Forgets every load, so the next panel imports again (tests only). */
export function resetQueryLanguages(): void {
  loads.clear();
  settled.clear();
}
