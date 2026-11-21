/**
 * The panel editor (plan #61 Part B §4.3): a non-modal region at the right of the grid in Edit
 * mode (T08-017: focus is never trapped). Every change updates the draft at once. The field errors
 * of the last invalid save show under their controls (T08-008).
 */
import type { FieldError, PanelSpec, PanelVisKind, QueryLang } from '../../api/types';
import { fieldMessage } from '../../boards/fieldMessages';
import { t, type MessageId } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Icon } from '../../kit/Icon';
import { Select } from '../../kit/Select';
import { TextArea } from '../../kit/TextArea';
import { TextField } from '../../kit/TextField';
import styles from './Board.module.css';

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
  /** The panel's JSON pointer (`/panels/0`, `/sections/1/panels/2`). */
  pointer: string;
  fields: readonly FieldError[];
  readOnly: boolean;
  onChange: (patch: Partial<Pick<PanelSpec, 'title' | 'query' | 'vis'>>) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function PanelEditor({
  panel,
  pointer,
  fields,
  readOnly,
  onChange,
  onRemove,
  onClose,
}: PanelEditorProps) {
  const errorAt = (suffix: string): string | null => {
    const f = fields.find((x) => x.pointer === `${pointer}${suffix}`);
    return f === undefined ? null : fieldMessage(f.messageKey);
  };
  return (
    <aside className={cx(styles['editor'])} aria-label={t('editor.title')}>
      <h2 className={cx(styles['editorTitle'])}>{t('editor.title')}</h2>
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
      <TextArea
        label={t('editor.query')}
        value={panel.query.text}
        onChange={(text) => {
          onChange({ query: { ...panel.query, text } });
        }}
        error={errorAt('/query/text')}
        isReadOnly={readOnly}
        mono
        rows={6}
        spellCheck="false"
        autoComplete="off"
      />
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
      <div className={cx(styles['editorActions'])}>
        <Button onPress={onRemove} isDisabled={readOnly}>
          {t('editor.remove')}
        </Button>
        <Button onPress={onClose}>
          <Icon name="x" />
          {t('editor.close')}
        </Button>
      </div>
    </aside>
  );
}

/** After the dialog closes: the panel's Panel menu button, else the toolbar's Add panel. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub until the implementation
export function focusAfterEditor(root: ParentNode, panelId: string): void {
  // Stub (#90, tests first).
}
