/** One `LANGUAGES[id]()` per page load, as state (plan #64 §3.2). */
import type { LangId, QueryLanguage } from '../editor/lang/types';

export function useQueryLanguage(_id: LangId): {
  readonly lang: QueryLanguage | null;
  readonly failed: boolean;
} {
  throw new Error('not implemented');
}

/** Forgets the loaded languages (tests only). */
export function resetQueryLanguages(): void {
  // not implemented
}
