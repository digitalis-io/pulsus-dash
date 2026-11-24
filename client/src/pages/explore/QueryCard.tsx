/**
 * The Query card of Explore › Metrics (plan #63 Part C §3.3, C.2): the language tag, the metric
 * picker, the Run hint and button, the PromQL editor from the lazy chunk (or its placeholder while
 * it loads, `QueryFallback` if it fails; the load-failed alert whenever an import failed) and the
 * status line, which the Run button is described by.
 */
import { useId, useMemo, type JSX, type ReactNode, type Ref } from 'react';
import type { PromQLEditorHandle } from '../../editor/PromQLEditor';
import type { Diagnostic, PromSource } from '../../editor/lang/types';
import type { PromMetadata } from '../../data/decode';
import type { EditorModules } from '../../explore/useEditorModules';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { Card } from '../../kit/Card';
import { cx } from '../../kit/cx';
import styles from './Explore.module.css';
import { QueryFallback } from './QueryFallback';
import { MetricPicker } from './MetricPicker';

export interface QueryCardProps {
  readonly modules: EditorModules;
  readonly tenant: string;
  /** The URL query: the editor follows it. */
  readonly q: string;
  /** Null until the editor chunk has loaded. */
  readonly source: PromSource | null;
  readonly meta: PromMetadata['metrics'];
  readonly diagnostics: readonly Diagnostic[];
  readonly onDraft: (text: string) => void;
  readonly onRun: () => void;
  readonly onEscape: () => void;
  readonly onPick: (name: string) => void;
  readonly status: ReactNode;
  readonly runReady: boolean;
  readonly editorRef: Ref<PromQLEditorHandle>;
  readonly runButtonRef: Ref<HTMLButtonElement>;
}

export function QueryCard({ editorRef, runButtonRef, ...p }: QueryCardProps): JSX.Element {
  const statusId = useId();
  const Editor = p.modules.editor?.PromQLEditor ?? null;
  const source = p.source;
  const names = useMemo(() => (source === null ? null : () => source.metricNames()), [source]);
  return (
    <Card title={t('explore.query.title')}>
      <div className={cx(styles['header'])}>
        <span className={cx(styles['lang'])}>{t('explore.query.language')}</span>
        <MetricPicker tenant={p.tenant} names={names} meta={p.meta} onPick={p.onPick} />
        <span className={cx(styles['spacer'])} />
        <span className={cx(styles['hint'])} aria-hidden="true">
          {t('explore.query.runHint')}
        </span>
        <Button
          variant="primary"
          ref={runButtonRef}
          isDisabled={!p.runReady}
          aria-describedby={statusId}
          onPress={p.onRun}
        >
          {t('explore.query.run')}
        </Button>
      </div>
      {Editor !== null && p.source !== null ? (
        <Editor
          ref={editorRef}
          className={cx(styles['editorHost'])}
          value={p.q}
          onChange={p.onDraft}
          onRun={p.onRun}
          onEscape={p.onEscape}
          source={p.source}
          diagnostics={p.diagnostics}
          label={t('explore.query.label')}
          placeholder={t('explore.query.placeholder')}
        />
      ) : p.modules.editorFailed ? (
        <QueryFallback
          label={t('explore.query.label')}
          value={p.q}
          onChange={p.onDraft}
          onRun={p.onRun}
        />
      ) : (
        <div className={cx(styles['editorPlaceholder'])}>
          {p.modules.failed ? null : <p>{t('explore.query.loading')}</p>}
        </div>
      )}
      {p.modules.failed ? (
        <p role="alert" className={cx(styles['statusRow'])}>
          {t('explore.query.loadFailed')}
        </p>
      ) : null}
      <div id={statusId} className={cx(styles['statusRow'])}>
        {p.status}
      </div>
    </Card>
  );
}
