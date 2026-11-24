/**
 * The Query card of Explore › Logs (plan #66 Part C §3.9): the language tag, the Run hint and
 * button, the LogQL editor from the lazy chunk (or its placeholder while it loads,
 * `QueryFallback` if it fails; the load-failed alert whenever an import failed) and the status
 * line, which the Run button is described by. No metric picker.
 */
import { useId, type JSX, type ReactNode, type Ref } from 'react';
import type { Diagnostic, LogSource } from '../../editor/lang/types';
import type { QueryEditorHandle } from '../../editor/QueryEditorHost';
import type { LogqlModules } from '../../explore/useLogqlModules';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { Card } from '../../kit/Card';
import { cx } from '../../kit/cx';
import styles from './Explore.module.css';
import { QueryFallback } from './QueryFallback';

export interface LogsQueryCardProps {
  readonly modules: LogqlModules;
  readonly q: string;
  /** Null until the editor chunk has loaded. */
  readonly source: LogSource | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly onDraft: (text: string) => void;
  readonly onRun: () => void;
  readonly onEscape: () => void;
  readonly status: ReactNode;
  readonly runReady: boolean;
  readonly editorRef: Ref<QueryEditorHandle>;
  readonly runButtonRef: Ref<HTMLButtonElement>;
}

export function LogsQueryCard({ editorRef, runButtonRef, ...p }: LogsQueryCardProps): JSX.Element {
  const statusId = useId();
  const Editor = p.modules.editor?.LogQLEditor ?? null;
  return (
    <Card title={t('explore.query.title')}>
      <div className={cx(styles['header'])}>
        <span className={cx(styles['lang'])}>{t('explore.logs.language')}</span>
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
          label={t('explore.logs.label')}
          placeholder={t('explore.logs.placeholder')}
        />
      ) : p.modules.editorFailed ? (
        <QueryFallback
          label={t('explore.logs.label')}
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
