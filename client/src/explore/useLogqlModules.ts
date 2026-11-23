/**
 * The LogQL language and editor chunk for Explore › Logs (plan #66 Part C §3.5, ADR-0018 §5): both
 * imports start on mount; a rejection is kept as `failed`, not thrown. The page reaches the
 * language only through `LANGUAGES` and imports `editor/logqlEditor.ts` dynamically.
 */
import type { QueryLanguage } from '../editor/lang/types';

export type LogqlEditorModule = typeof import('../editor/logqlEditor');

export interface LogqlModules {
  readonly lang: QueryLanguage | null;
  readonly editor: LogqlEditorModule | null;
  readonly failed: boolean;
}

/** `LANGUAGES.logql()` and `import('../editor/logqlEditor')` start on mount; a rejection sets `failed`. */
export function useLogqlModules(): LogqlModules {
  throw new Error('not implemented');
}
