/**
 * The panel editor (#90): a centred modal window of fixed size over the dimmed board (kit
 * `ModalDialog` size `editor`; T08-017's modal exception). A live preview of the draft panel at the
 * top, drawn through the board panel's own query and `ChartFrame` path; then Title, Query language,
 * Query and Visualisation. Every change updates the draft at once; the field errors of the last
 * invalid save show under their controls (T08-008). Esc, Done or a click outside closes it, and the
 * page returns focus with `focusAfterEditor`. The board behind is `aria-hidden` while it is open, so
 * the save status is mirrored at its foot.
 */
import type { FieldError, PanelSpec, PanelVisKind, QueryLang } from '../../api/types';
import { fieldMessage } from '../../boards/fieldMessages';
import { t, type MessageId } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { ModalDialog } from '../../kit/Dialog';
import { Select } from '../../kit/Select';
import { TextArea } from '../../kit/TextArea';
import { TextField } from '../../kit/TextField';
import styles from './Board.module.css';
import { PanelPreview } from './PanelFrame';

const LANGS: readonly { id: QueryLang; label: MessageId }[] = [
  { id: 'promql', label: 'editor.lang.promql' },
  { id: 'logql', label: 'editor.lang.logql' },
];

const KINDS: readonly { id: PanelVisKind; label: MessageId }[] = [
  { id: 'auto', label: 'editor.vis.auto' },
  { id: 'line', label: 'editor.vis.line' },
  { id: 'bars', label: 'editor.vis.bars' },
  { id: 'heatmap', label: 'editor.vis.heatmap' },
  { id: 'stat', label: 'editor.vis.stat' },
  { id: 'logs', label: 'editor.vis.logs' },
];

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
  onChange,
  onRemove,
  onClose,
}: PanelEditorProps) {
  const errorAt = (suffix: string): string | null => {
    const f = fields.find((x) => x.pointer === `${pointer}${suffix}`);
    return f === undefined ? null : fieldMessage(f.messageKey);
  };
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
        <PanelPreview panel={panel} tenant={tenant} />
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
          <Select
            label={t('editor.vis')}
            value={panel.vis.kind}
            options={KINDS.map((k) => ({ id: k.id, label: t(k.label) }))}
            onChange={(kind) => {
              onChange({ vis: { kind } });
            }}
            error={errorAt('/vis/kind')}
            isDisabled={readOnly}
          />
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
