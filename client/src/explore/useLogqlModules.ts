/**
 * The LogQL language and editor chunk for Explore › Logs (plan #66 Part C §3.5, ADR-0018 §5): both
 * imports start on mount; a rejection is kept as `failed`, not thrown. The page reaches the
 * language only through `LANGUAGES` and imports `editor/logqlEditor.ts` dynamically.
 */
import { useEffect, useState } from 'react';
import { LANGUAGES } from '../editor/lang/index';
import type { QueryLanguage } from '../editor/lang/types';

export type LogqlEditorModule = typeof import('../editor/logqlEditor');

export interface LogqlModules {
  readonly lang: QueryLanguage | null;
  readonly editor: LogqlEditorModule | null;
  readonly failed: boolean;
}

const INITIAL: LogqlModules = { lang: null, editor: null, failed: false };

/** `LANGUAGES.logql()` and `import('../editor/logqlEditor')` start on mount; a rejection sets `failed`. */
export function useLogqlModules(): LogqlModules {
  const [modules, setModules] = useState<LogqlModules>(INITIAL);
  useEffect(() => {
    let live = true;
    const update = (p: Partial<LogqlModules>): void => {
      if (live) setModules((m) => ({ ...m, ...p }));
    };
    LANGUAGES.logql().then(
      (lang) => {
        update({ lang });
      },
      () => {
        update({ failed: true });
      },
    );
    Promise.reject<LogqlEditorModule>(new Error('gate-proof')).then(
      (editor) => {
        update({ editor });
      },
      () => {
        update({ failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return modules;
}
