/**
 * The Query field of the panel editor for PromQL (plan #64 §3.8, A.10, A.2; T09-004): the metric
 * picker, the Run hint and the Run query button, Explore's PromQL editor from the lazy chunk (its
 * placeholder while it loads, a plain text area if it fails) and one status row. The text goes to
 * the draft on every change; it runs (the preview and the panel behind) on Run, Shift+Enter or
 * Mod+Enter, and when focus leaves the field with a text that has not run.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, type JSX } from 'react';
import { useApi } from '../../app/providers';
import type { PromMetadata } from '../../data/decode';
import type { PromQLEditorHandle } from '../../editor/PromQLEditor';
import type { Diagnostic } from '../../editor/lang/types';
import { promMetadataQuery } from '../../explore/promMetadata';
import { useEditorModules } from '../../explore/useEditorModules';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { TextArea } from '../../kit/TextArea';
import { useTimeContext } from '../../state/useTimeContext';
import { MetricPicker, PICKER_KEEP } from '../explore/MetricPicker';
import styles from './Board.module.css';

export interface PanelQueryFieldProps {
  readonly tenant: string;
  readonly value: string;
  /** The text the preview and the panel run now (§4.4). */
  readonly runText: string;
  /** Of the run of `runText`. */
  readonly diagnostics: readonly Diagnostic[];
  /** The field error of the last invalid save (#90). */
  readonly error: string | null;
  readonly readOnly: boolean;
  readonly onChange: (text: string) => void;
  readonly onRun: (text: string) => void;
}

const NO_META: PromMetadata['metrics'] = Object.freeze({});
const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);

export function PanelQueryField(p: PanelQueryFieldProps): JSX.Element {
  const api = useApi();
  const queryClient = useQueryClient();
  const statusId = useId();
  const modules = useEditorModules();
  const { tenant, onChange, onRun } = p;
  // The picker's and completion's metadata only (ADR-0021: the server reads metric types).
  const metaQ = useQuery(promMetadataQuery(api, tenant));
  const meta = metaQ.data?.metrics ?? NO_META;

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
    return editor.createPromSource({ api, queryClient, tenant, window });
  }, [editor, api, queryClient, tenant]);
  const names = useMemo(() => (source === null ? null : () => source.metricNames()), [source]);

  // The latest text, for the editor's Run keys (they carry no text) and the blur rule.
  const valueRef = useRef(p.value);
  const runTextRef = useRef(p.runText);
  const onRunRef = useRef(onRun);
  useLayoutEffect(() => {
    valueRef.current = p.value;
    runTextRef.current = p.runText;
    onRunRef.current = onRun;
  });
  const editorRef = useRef<PromQLEditorHandle>(null);
  const runButtonRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);

  const onDraft = useCallback(
    (text: string) => {
      valueRef.current = text;
      onChange(text);
    },
    [onChange],
  );
  const run = useCallback(() => {
    onRun(valueRef.current);
  }, [onRun]);
  const onEscape = useCallback(() => {
    runButtonRef.current?.focus();
  }, []);
  const onPick = useCallback((name: string) => {
    editorRef.current?.insert(name);
    editorRef.current?.focus();
  }, []);
  // Focus leaving the field (not to its own controls or the picker's list) runs a text not yet run.
  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget;
      if (next instanceof Node && field.contains(next)) return;
      if (next instanceof Element && next.closest(PICKER_KEEP) !== null) return;
      if (valueRef.current !== runTextRef.current) onRunRef.current(valueRef.current);
    };
    field.addEventListener('focusout', onFocusOut);
    return () => {
      field.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const Editor = editor?.PromQLEditor ?? null;
  const unrun = p.value !== p.runText;
  return (
    <div ref={fieldRef} className={cx(styles['queryField'])}>
      <div className={cx(styles['queryHeader'])}>
        <MetricPicker tenant={tenant} names={names} meta={meta} onPick={onPick} />
        <span className={cx(styles['querySpacer'])} />
        <span className={cx(styles['queryHint'])} aria-hidden="true">
          {t('explore.query.runHint')}
        </span>
        <Button
          variant="primary"
          ref={runButtonRef}
          isDisabled={Editor === null || p.readOnly}
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
          label={t('editor.query')}
          placeholder={t('explore.query.placeholder')}
        />
      ) : modules.failed ? (
        <>
          <TextArea
            label={t('editor.query')}
            value={p.value}
            onChange={onDraft}
            isReadOnly={p.readOnly}
            mono
            rows={5}
            spellCheck="false"
            autoComplete="off"
          />
          <p role="alert" className={cx(styles['queryStatus'])}>
            {t('explore.query.loadFailed')}
          </p>
        </>
      ) : (
        <div className={cx(styles['queryEditor'], styles['queryLoading'])}>
          <p>{t('explore.query.loading')}</p>
        </div>
      )}
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
