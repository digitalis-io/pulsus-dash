/**
 * The query languages (T09 §5.1, ADR-0018): a static table from language id to a lazy import of
 * its `QueryLanguage`, not a registry. Explore, the panel editor and board panels reach a
 * language only through this table and the interface.
 */
import type { LangId, QueryLanguage } from './types';

/** A language whose module is not built yet. */
export class LanguageUnavailableError extends Error {
  readonly lang: LangId;
  constructor(lang: LangId) {
    super(`query language ${lang} is not available yet`);
    this.name = 'LanguageUnavailableError';
    this.lang = lang;
  }
}

const unavailable = (lang: LangId) => () =>
  Promise.reject<QueryLanguage>(new LanguageUnavailableError(lang));

export const LANGUAGES: Readonly<Record<LangId, () => Promise<QueryLanguage>>> = Object.freeze({
  promql: () => import('./promql/promql').then((m) => m.promql),
  logql: unavailable('logql'),
  traceql: unavailable('traceql'),
  profile: unavailable('profile'),
});
