/**
 * The widget editor (plan #198 Part 3a §3.2): the panel editor's window (kit `ModalDialog` size
 * `editor`) for a widget, titled by its def. Title, then the def's own editor body, then Remove
 * panel, the mirrored save status (the board behind is `aria-hidden`) and Done. Every change goes
 * to the draft at once (`updateWidget`); the page returns focus with `focusAfterEditor` as for the
 * panel editor. While the body reports a local field text it cannot write (`onLocalInvalid`, plan
 * #216 Part 2b §4.1), Done is disabled and the status line leads with its message; the page hears
 * it too, to refuse Save.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FieldError, WidgetPanelSpec } from '../../api/types';
import type { WidgetPatch } from '../../boards/editorState';
import { fieldMessage } from '../../boards/fieldMessages';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { ModalDialog } from '../../kit/Dialog';
import { TextField } from '../../kit/TextField';
import type { WidgetDef } from '../../widgets/registry';
import styles from './Board.module.css';

export interface WidgetEditorProps {
  panel: WidgetPanelSpec;
  def: WidgetDef;
  /** The panel's JSON pointer (`/panels/0`, `/sections/1/panels/2`). */
  pointer: string;
  fields: readonly FieldError[];
  readOnly: boolean;
  /** The page's save status line, mirrored in the dialog. */
  statusText: string;
  /** The head's vis of this panel; undefined for a panel the head does not have. */
  original: WidgetPanelSpec['vis'] | undefined;
  onChange: (patch: WidgetPatch) => void;
  onRemove: () => void;
  onClose: () => void;
  /** The body's local invalid text (null when none, and when the editor closes). */
  onLocalInvalid?: (message: string | null) => void;
}

export function WidgetEditor({
  panel,
  def,
  pointer,
  fields,
  readOnly,
  statusText,
  original,
  onChange,
  onRemove,
  onClose,
  onLocalInvalid,
}: WidgetEditorProps) {
  const titleError = fields.find((f) => f.pointer === `${pointer}/title`);
  const Editor = def.Editor;
  const [local, setLocal] = useState<string | null>(null);
  const report = useRef(onLocalInvalid);
  useLayoutEffect(() => {
    report.current = onLocalInvalid;
  });
  // Closing the editor drops a local text, as for any editor close.
  useEffect(
    () => () => {
      report.current?.(null);
    },
    [],
  );
  const status =
    local === null ? statusText : statusText === '' ? local : `${local} · ${statusText}`;
  return (
    <ModalDialog
      title={t(def.editTitle)}
      isOpen
      size="editor"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className={cx(styles['editorBody'])}>
        <div className={cx(styles['widgetEditorFields'])}>
          <TextField
            label={t('editor.panelTitle')}
            value={panel.title}
            onChange={(title) => {
              onChange({ title });
            }}
            error={titleError === undefined ? null : fieldMessage(titleError.messageKey)}
            isReadOnly={readOnly}
            autoComplete="off"
          />
          <Editor
            panel={panel}
            title={panel.title}
            pointer={pointer}
            fields={fields}
            readOnly={readOnly}
            original={original}
            onVis={(vis) => {
              onChange({ vis });
            }}
            onLocalInvalid={(m) => {
              setLocal(m);
              report.current?.(m);
            }}
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
            {status}
          </p>
          <Button variant="primary" onPress={onClose} isDisabled={local !== null}>
            {t('editor.close')}
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}
