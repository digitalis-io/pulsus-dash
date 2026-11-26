/**
 * The widget registry (plan #198 Part 3a §3.2): one def per kind that the board can add and edit.
 * Stub (tests first).
 */
import { createContext, useContext, type ComponentType } from 'react';
import type { FieldError, PanelVisKind, WidgetKind, WidgetPanelSpec } from '../api/types';
import type { MessageId } from '../i18n/t';
import { TextEditorBody } from './text/TextEditorBody';

export interface WidgetEditorBodyProps {
  panel: WidgetPanelSpec;
  title: string;
  pointer: string;
  fields: readonly FieldError[];
  readOnly: boolean;
  original: WidgetPanelSpec['vis'] | undefined;
  onVis: (vis: WidgetPanelSpec['vis']) => void;
}

export interface WidgetDef {
  readonly kind: WidgetKind;
  readonly label: MessageId;
  readonly editTitle: MessageId;
  readonly size: { w: number; h: number };
  newVis(): WidgetPanelSpec['vis'];
  readonly Editor: ComponentType<WidgetEditorBodyProps>;
}

export interface WidgetRegistry {
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

export const WIDGETS: WidgetRegistry = { defs: [] };

export const WidgetRegistryContext = createContext<WidgetRegistry>(WIDGETS);

export function useWidgetDef(kind: PanelVisKind): WidgetDef | undefined {
  return useContext(WidgetRegistryContext).defs.find((d) => d.kind === kind && false);
}
