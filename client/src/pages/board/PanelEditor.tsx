/**
 * The panel editor (#90): a centred modal window of fixed size over the dimmed board (kit
 * `ModalDialog` size `editor`; T08-017's modal exception). A live preview of the draft panel at the
 * top, drawn through the board panel's own query and `ChartFrame` path; then Title, Query language,
 * Query and Visualisation. Every change updates the draft at once; the field errors of the last
 * invalid save show under their controls (T08-008). Esc, Done or a click outside closes it, and the
 * page returns focus with `focusAfterEditor`. The board behind is `aria-hidden` while it is open, so
 * the save status is mirrored at its foot. For PromQL the Query field is the PromQL editor with the
 * metric picker (plan #64 §3.8, A.10): the text goes to the draft on every change and runs on Run,
 * the Run keys or leaving the field; the dialog owns the preview's run, which shares the board
 * panel's key (the run text and the panel's width). After Visualisation come Thresholds and Legend
 * (plan #64 Part B §3.10); every vis edit merges into the panel's `vis`, so a kind change keeps
 * them. They change the spec, not the query key: the preview reruns nothing.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FieldError, PanelSpec, PanelVisKind, QueryLang } from '../../api/types';
import { panelView } from '../../boards/panelRun';
import { fieldMessage } from '../../boards/fieldMessages';
import { usePanelWidth } from '../../boards/panelWidths';
import { usePanelRun } from '../../boards/usePanelRun';
import type { Unit, VisKind } from '../../engine/api';
import { useElementWidth } from '../../explore/useElementWidth';
import { t, type MessageId } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { ModalDialog } from '../../kit/Dialog';
import { Select } from '../../kit/Select';
import { TextArea } from '../../kit/TextArea';
import { TextField } from '../../kit/TextField';
import { autoVis } from '../../vis/autovis';
import styles from './Board.module.css';
import { PanelPreview } from './PanelFrame';
import { PanelQueryField } from './PanelQueryField';
import { ThresholdsField } from './ThresholdsField';

const LANGS: readonly { id: QueryLang; label: MessageId }[] = [
  { id: 'promql', label: 'editor.lang.promql' },
  { id: 'logql', label: 'editor.lang.logql' },
];

const VIS_LABELS: Readonly<Record<VisKind, MessageId>> = {
  line: 'editor.vis.line',
  bars: 'editor.vis.bars',
  heatmap: 'editor.vis.heatmap',
  stat: 'editor.vis.stat',
};

const LEGENDS: readonly { id: 'table' | 'hidden'; label: MessageId }[] = [
  { id: 'table', label: 'editor.legend.table' },
  { id: 'hidden', label: 'editor.legend.hidden' },
];

const NO_UNIT: Unit = { kind: 'none' };

/**
 * False in the task that mounts the editor, true from the next animation frame: the Thresholds and
 * Legend fields mount then, so opening the editor is not one long task (`bench:rooms-long-tasks`;
 * the threshold rows then follow over the next frames).
 */
function useAfterFirstFrame(): boolean {
  const [after, setAfter] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setAfter(true);
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, []);
  return after;
}

/** `value` by its JSON: the same object while the JSON is unchanged, so memoised children skip. */
function useStable<T>(value: T): T {
  const key = JSON.stringify(value);
  return useMemo(() => JSON.parse(key) as T, [key]);
}

/** `vis` without the member `key` (absent, not undefined: the saved spec has no such key). */
function without(vis: PanelSpec['vis'], key: 'thresholds' | 'legend'): PanelSpec['vis'] {
  return Object.fromEntries(Object.entries(vis).filter(([k]) => k !== key)) as PanelSpec['vis'];
}

const KINDS: readonly { id: PanelVisKind; label: MessageId }[] = [
  { id: 'auto', label: 'editor.vis.auto' },
  { id: 'line', label: 'editor.vis.line' },
  { id: 'bars', label: 'editor.vis.bars' },
  { id: 'heatmap', label: 'editor.vis.heatmap' },
  { id: 'stat', label: 'editor.vis.stat' },
  { id: 'logs', label: 'editor.vis.logs' },
];

/**
 * Thresholds and Legend (§3.10). Memoised, with stable props from the editor, so an edit elsewhere
 * in the dialog (title, language, query) does not render them again (`bench:rooms-long-tasks`).
 */
const VisExtras = memo(function VisExtras({
  vis,
  unit,
  fields,
  pointer,
  readOnly,
  onVis,
}: {
  vis: PanelSpec['vis'];
  unit: Unit;
  /** The field errors under the panel's `/vis`. */
  fields: readonly FieldError[];
  pointer: string;
  readOnly: boolean;
  onVis: (next: PanelSpec['vis']) => void;
}) {
  const errorAt = (suffix: string): string | null => {
    const f = fields.find((x) => x.pointer === `${pointer}${suffix}`);
    return f === undefined ? null : fieldMessage(f.messageKey);
  };
  return (
    <>
      <div className={cx(styles['editorWide'])}>
        <ThresholdsField
          value={vis.thresholds}
          onChange={(thresholds) => {
            onVis(thresholds === undefined ? without(vis, 'thresholds') : { ...vis, thresholds });
          }}
          errorAt={(suffix) => errorAt(`/vis/thresholds${suffix}`)}
          unit={unit}
          readOnly={readOnly}
        />
      </div>
      <div className={cx(styles['editorWide'])}>
        <Select
          label={t('editor.legend')}
          value={vis.legend?.mode ?? 'table'}
          options={LEGENDS.map((l) => ({ id: l.id, label: t(l.label) }))}
          onChange={(mode) => {
            onVis(mode === 'hidden' ? { ...vis, legend: { mode } } : without(vis, 'legend'));
          }}
          error={errorAt('/vis/legend/mode')}
          isDisabled={readOnly}
        />
      </div>
    </>
  );
});

export interface PanelEditorProps {
  panel: PanelSpec;
  /** The preview's data query. */
  tenant: string;
  /** The panel's JSON pointer (`/panels/0`, `/sections/1/panels/2`). */
  pointer: string;
  fields: readonly FieldError[];
  readOnly: boolean;
  /** The page's save status line, mirrored in the dialog: the board behind is aria-hidden. */
  statusText: string;
  /** The text the preview and the panel behind run (§4.4). */
  runText: string;
  /** Run `text`: BoardPage sets the run text, or reruns it when it is already the run text. */
  onRun: (text: string) => void;
  onChange: (patch: Partial<Pick<PanelSpec, 'title' | 'query' | 'vis'>>) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function PanelEditor({
  panel,
  tenant,
  pointer,
  fields,
  readOnly,
  statusText,
  runText,
  onRun,
  onChange,
  onRemove,
  onClose,
}: PanelEditorProps) {
  const errorAt = (suffix: string): string | null => {
    const f = fields.find((x) => x.pointer === `${pointer}${suffix}`);
    return f === undefined ? null : fieldMessage(f.messageKey);
  };
  // The panel's own body width, so the preview sends what the panel sends; its own as a fallback.
  const [previewBody, ownWidth] = useElementWidth<HTMLDivElement>();
  const shared = usePanelWidth(panel.id);
  const run = usePanelRun({
    tenant,
    panel,
    text: runText,
    enabled: true,
    widthPx: shared ?? ownWidth,
  });
  const outcome = run.outcome;
  const visFields = useAfterFirstFrame();
  // The preview frame's unit, for the threshold label placeholders.
  const unit = useMemo(() => {
    const v = panelView(run, panel.vis, '');
    return v.kind === 'frame' ? v.spec.unit : NO_UNIT;
  }, [run, panel.vis]);
  // Every vis edit: the next vis, built from `panel.vis` by spread.
  const patchVis = (next: PanelSpec['vis']): void => {
    onChange({ vis: next });
  };
  // Stable props for `VisExtras`: the latest `onChange`, the unit and the `/vis` errors by value.
  const latestOnChange = useRef(onChange);
  useLayoutEffect(() => {
    latestOnChange.current = onChange;
  });
  const onVis = useCallback((next: PanelSpec['vis']) => {
    latestOnChange.current({ vis: next });
  }, []);
  const stableUnit = useStable(unit);
  const visErrors = useStable(fields.filter((f) => f.pointer.startsWith(`${pointer}/vis/`)));
  const autoLabel = useMemo(() => {
    const vis =
      outcome === null
        ? null
        : autoVis({
            histogram: outcome.planned.histogram,
            rateApplied: outcome.planned.rateApplied,
            result: outcome.result,
          }).vis;
    return vis === null ? t('editor.vis.auto') : t('explore.vis.auto', { vis: t(VIS_LABELS[vis]) });
  }, [outcome]);
  return (
    <ModalDialog
      title={t('editor.title')}
      isOpen
      size="editor"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className={cx(styles['editorBody'])}>
        <PanelPreview panel={panel} run={run} bodyRef={previewBody} />
        <div className={cx(styles['editorFields'])}>
          <TextField
            label={t('editor.panelTitle')}
            value={panel.title}
            onChange={(title) => {
              onChange({ title });
            }}
            error={errorAt('/title')}
            isReadOnly={readOnly}
            autoComplete="off"
          />
          <Select
            label={t('editor.lang')}
            value={panel.query.lang}
            options={LANGS.map((l) => ({ id: l.id, label: t(l.label) }))}
            onChange={(lang) => {
              onChange({ query: { ...panel.query, lang } });
            }}
            error={errorAt('/query/lang')}
            isDisabled={readOnly}
          />
          {panel.query.lang === 'promql' ? (
            <PanelQueryField
              tenant={tenant}
              value={panel.query.text}
              runText={runText}
              diagnostics={run.diagnostics}
              error={errorAt('/query/text')}
              readOnly={readOnly}
              onChange={(text) => {
                onChange({ query: { ...panel.query, text } });
              }}
              onRun={onRun}
            />
          ) : (
            <div className={cx(styles['editorWide'])}>
              <TextArea
                label={t('editor.query')}
                value={panel.query.text}
                onChange={(text) => {
                  onChange({ query: { ...panel.query, text } });
                }}
                error={errorAt('/query/text')}
                isReadOnly={readOnly}
                mono
                rows={5}
                spellCheck="false"
                autoComplete="off"
              />
            </div>
          )}
          <Select
            label={t('editor.vis')}
            value={panel.vis.kind}
            options={KINDS.map((k) => ({
              id: k.id,
              label: k.id === 'auto' ? autoLabel : t(k.label),
            }))}
            onChange={(kind) => {
              patchVis({ ...panel.vis, kind });
            }}
            error={errorAt('/vis/kind')}
            isDisabled={readOnly}
          />
          {visFields && (
            <VisExtras
              vis={panel.vis}
              unit={stableUnit}
              fields={visErrors}
              pointer={pointer}
              readOnly={readOnly}
              onVis={onVis}
            />
          )}
        </div>
        <div className={cx(styles['editorActions'])}>
          <Button onPress={onRemove} isDisabled={readOnly}>
            {t('editor.remove')}
          </Button>
          <p
            role="status"
            aria-label={t('board.saveStatus')}
            className={cx(styles['editorStatus'])}
          >
            {statusText}
          </p>
          <Button variant="primary" onPress={onClose}>
            {t('editor.close')}
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}

/** After the dialog closes: the panel's Panel menu button, else the toolbar's Add panel. */
export function focusAfterEditor(root: ParentNode, panelId: string): void {
  // `CSS.escape` is not used: jsdom lacks it.
  const panel = [...root.querySelectorAll<HTMLElement>('[data-panel]')].find(
    (p) => p.dataset['panel'] === panelId,
  );
  const target =
    panel?.querySelector<HTMLElement>('[data-panel-menu]') ??
    root.querySelector<HTMLElement>('[data-board-add]');
  target?.focus();
}
