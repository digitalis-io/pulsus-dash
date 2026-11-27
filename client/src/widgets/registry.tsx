/**
 * The widget registry (plan #198 Part 3a §3.2): one def per kind the board can add and edit, in
 * menu order. "Add widget" lists the defs, `addWidget` takes a def's `newVis()` and `size`, a
 * widget's Edit panel opens `WidgetEditor` with the def's `Editor` body, and a kind without a def
 * keeps Duplicate and Remove only. The registry comes from `WidgetRegistryContext` (default
 * `WIDGETS`), so a test, or #216 Part 2 adding the board list, provides another.
 */
import { createContext, useContext, type ComponentType } from 'react';
import type { FieldError, PanelVisKind, WidgetKind, WidgetPanelSpec } from '../api/types';
import type { MessageId } from '../i18n/t';
import { BoardListEditorBody } from './boardList/BoardListEditorBody';
import { TextEditorBody } from './text/TextEditorBody';

/** What a def's editor body gets from `WidgetEditor`. */
export interface WidgetEditorBodyProps {
  /** The draft panel. */
  panel: WidgetPanelSpec;
  title: string;
  /** The panel's JSON pointer (`/panels/0`, `/sections/1/panels/2`). */
  pointer: string;
  /** The last save's field errors. */
  fields: readonly FieldError[];
  readOnly: boolean;
  /** The head's vis of this panel; undefined for a panel the head does not have. */
  original: WidgetPanelSpec['vis'] | undefined;
  /** The next vis, of the same kind (`updateWidget` refuses another). */
  onVis: (vis: WidgetPanelSpec['vis']) => void;
  /** Stub (tests first, plan #216 Part 2b §3.1). */
  onLocalInvalid?: (message: string | null) => void;
}

export interface WidgetDef {
  readonly kind: WidgetKind;
  /** The "Add widget" item. */
  readonly label: MessageId;
  /** The editor dialog's title. */
  readonly editTitle: MessageId;
  /** A new panel's width and height. */
  readonly size: { w: number; h: number };
  /** A new panel's vis. */
  newVis(): WidgetPanelSpec['vis'];
  readonly Editor: ComponentType<WidgetEditorBodyProps>;
}

export interface WidgetRegistry {
  /** In menu order. */
  readonly defs: readonly WidgetDef[];
}

export const TEXT_DEF: WidgetDef = {
  kind: 'text',
  label: 'widget.kind.text',
  editTitle: 'widget.text.editTitle',
  size: { w: 6, h: 6 },
  newVis: () => ({ kind: 'text', options: { mode: 'markdown', content: '' } }),
  Editor: TextEditorBody,
};

export const BOARD_LIST_DEF: WidgetDef = {
  kind: 'boardList',
  label: 'widget.kind.boardList',
  editTitle: 'widget.boardList.editTitle',
  size: { w: 4, h: 8 },
  newVis: () => ({ kind: 'boardList' }),
  Editor: BoardListEditorBody,
};

export const WIDGETS: WidgetRegistry = { defs: [TEXT_DEF] };

export const WidgetRegistryContext = createContext<WidgetRegistry>(WIDGETS);

/** The def of `kind` in the context's registry, if it has one. */
export function useWidgetDef(kind: PanelVisKind): WidgetDef | undefined {
  return useContext(WidgetRegistryContext).defs.find((d) => d.kind === kind);
}
