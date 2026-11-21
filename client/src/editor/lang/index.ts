import type { LangId, QueryLanguage } from './types';

export class LanguageUnavailableError extends Error {
  readonly lang: LangId;
  constructor(lang: LangId) {
    super('not implemented');
    this.name = 'LanguageUnavailableError';
    this.lang = lang;
  }
}
const ni = (id: LangId) => () => Promise.reject(new LanguageUnavailableError(id));
export const LANGUAGES: Readonly<Record<LangId, () => Promise<QueryLanguage>>> = {
  promql: ni('promql'),
  logql: ni('logql'),
  traceql: ni('traceql'),
  profile: ni('profile'),
};
