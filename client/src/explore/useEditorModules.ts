/**
 * The editor chunk and the PromQL language for the Explore page (plan #63 Part C §3.1, ADR-0018):
 * both imports start on mount; a rejection is kept as `failed` (the editor's also as
 * `editorFailed`), not thrown. The page reaches the
 * language only through `LANGUAGES` and imports the editor chunk dynamically.
 */
import { useEffect, useState } from 'react';
import { LANGUAGES } from '../editor/lang/index';
import type { QueryLanguage } from '../editor/lang/types';

export type EditorModule = typeof import('../editor/editor');

export interface EditorModules {
  readonly lang: QueryLanguage | null;
  readonly editor: EditorModule | null;
  /** Either import rejected: the load-failed alert shows and runs are degraded (#147). */
  readonly failed: boolean;
  /** The editor import rejected: the field is `QueryFallback` (#147). */
  readonly editorFailed: boolean;
}

const INITIAL: EditorModules = { lang: null, editor: null, failed: false, editorFailed: false };

export function useEditorModules(): EditorModules {
  const [modules, setModules] = useState<EditorModules>(INITIAL);
  useEffect(() => {
    let live = true;
    const update = (p: Partial<EditorModules>): void => {
      if (live) setModules((m) => ({ ...m, ...p }));
    };
    LANGUAGES.promql().then(
      (lang) => {
        update({ lang });
      },
      () => {
        update({ failed: true });
      },
    );
    import('../editor/editor').then(
      (editor) => {
        update({ editor });
      },
      () => {
        update({ failed: true, editorFailed: true });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return modules;
}
