/** The Edit-mode grid (plan #61 Part B §4.3), loaded lazily. Stub. */
import type { ReactNode } from 'react';
import type { PanelSpec } from '../../api/types';
import type { LayoutItem } from '../../boards/editorState';

export interface BoardGridEditorProps {
  panels: readonly PanelSpec[];
  readOnly: boolean;
  onLayout: (items: LayoutItem[]) => void;
  onBlocked: (panel: PanelSpec) => void;
  renderPanel: (panel: PanelSpec) => ReactNode;
}

export function BoardGridEditor(_props: BoardGridEditorProps) {
  return <div />;
}

export default BoardGridEditor;
