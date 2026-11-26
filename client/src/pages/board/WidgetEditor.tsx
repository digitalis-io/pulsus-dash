/** Stub (tests first): plan #198 Part 3a §3.2. */
import type { FieldError, WidgetPanelSpec } from '../../api/types';
import type { WidgetPatch } from '../../boards/editorState';
import type { WidgetDef } from '../../widgets/registry';

export interface WidgetEditorProps {
  panel: WidgetPanelSpec;
  def: WidgetDef;
  pointer: string;
  fields: readonly FieldError[];
  readOnly: boolean;
  statusText: string;
  onChange: (patch: WidgetPatch) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function WidgetEditor(_p: WidgetEditorProps) {
  return null;
}
