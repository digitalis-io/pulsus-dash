/**
 * The Query field of the panel editor for LogQL (plan #67 §3.5; T09-001, T09-004, T09-014): the Run
 * hint and the Run query button, the LogQL editor from Explore › Logs' lazy chunk (its placeholder
 * while it loads, `QueryFallback` if it fails; the load-failed alert whenever an import failed) and one status row, as the PromQL field without
 * the metric picker. Its completion source is made once per tenant and reads the board window at
 * each lookup. The run rules are `useQueryFieldRun`'s; `QueryFallback` has them too: Run
 * query and Shift+Enter or Mod+Enter run it, unchanged text included.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import { useApi } from '../../app/providers';
import type { Diagnostic } from '../../editor/lang/types';
import type { QueryEditorHandle } from '../../editor/QueryEditorHost';
import { useLogqlModules } from '../../explore/useLogqlModules';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { useTimeContext } from '../../state/useTimeContext';
import { QueryFallback } from '../explore/QueryFallback';
import styles from './Board.module.css';
import type { PanelQueryFieldProps } from './PanelQueryField';
import { useQueryFieldRun } from './useQueryFieldRun';

const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);

export function PanelLogqlField(p: PanelQueryFieldProps): JSX.Element {
  const api = useApi();
  const queryClient = useQueryClient();
  const statusId = useId();
  const modules = useLogqlModules();
  const { tenant } = p;

  // The window the completion lookups read, kept current (T09-014: one source per tenant).
  const { window: win } = useTimeContext();
  const winRef = useRef(win);
  useEffect(() => {
    winRef.current = win;
  }, [win]);
  const editor = modules.editor;
  const source = useMemo(() => {
    if (editor === null) return null;
    const window = () => winRef.current;
    // eslint-disable-next-line react-hooks/refs -- `window` runs on lookups, not during render
    return editor.createLogSource({ api, queryClient, tenant, window });
  }, [editor, api, queryClient, tenant]);

  const editorRef = useRef<QueryEditorHandle>(null);
  const { fieldRef, runButtonRef, onDraft, run, onEscape } = useQueryFieldRun(p);

  // The view mounts a frame after the field, as the PromQL field's (`bench:rooms-long-tasks`).
  const [mountable, setMountable] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setMountable(true);
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, []);
  const Editor = mountable ? (editor?.LogQLEditor ?? null) : null;
  const fallback = modules.editorFailed;
  const unrun = p.value !== p.runText;
  return (
    <div ref={fieldRef} className={cx(styles['queryField'])}>
      <div className={cx(styles['queryHeader'])}>
        <span className={cx(styles['querySpacer'])} />
        <span className={cx(styles['queryHint'])} aria-hidden="true">
          {t('explore.query.runHint')}
        </span>
        <Button
          variant="primary"
          ref={runButtonRef}
          isDisabled={(Editor === null && !fallback) || p.readOnly}
          aria-describedby={statusId}
          onPress={run}
        >
          {t('panelEditor.run')}
        </Button>
      </div>
      {Editor !== null && source !== null ? (
        <Editor
          ref={editorRef}
          className={cx(styles['queryEditor'])}
          value={p.value}
          onChange={onDraft}
          onRun={run}
          onEscape={onEscape}
          source={source}
          diagnostics={unrun ? NO_DIAGNOSTICS : p.diagnostics}
          readOnly={p.readOnly}
          label={t('editor.query')}
          placeholder={t('explore.logs.placeholder')}
        />
      ) : fallback ? (
        <QueryFallback
          label={t('editor.query')}
          value={p.value}
          onChange={onDraft}
          onRun={run}
          readOnly={p.readOnly}
        />
      ) : (
        <div className={cx(styles['queryEditor'], styles['queryLoading'])}>
          {modules.failed ? null : <p>{t('explore.query.loading')}</p>}
        </div>
      )}
      {modules.failed ? (
        <p role="alert" className={cx(styles['queryStatus'])}>
          {t('explore.query.loadFailed')}
        </p>
      ) : null}
      <div id={statusId} className={cx(styles['queryStatus'])}>
        {p.error !== null ? (
          <p role="alert">{p.error}</p>
        ) : unrun ? (
          <p role="status">{t('panelEditor.unrun')}</p>
        ) : null}
      </div>
    </div>
  );
}
