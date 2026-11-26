/** Stub (tests first): plan #198 Part 3a §3.1. */
import { memo, type ReactElement } from 'react';
import type { WidgetPanelSpec } from '../../api/types';
import type { TextOptions } from '../spec';

export const loadTextMarkdown = () => import('./TextMarkdown');

export type RegionName = { labelledBy: string } | { label: string };

export interface TextBodyProps {
  panel: WidgetPanelSpec;
  name: RegionName;
  editing: boolean;
  context: 'board' | 'preview';
}

export const TextBody = memo(function TextBody(_p: TextBodyProps): ReactElement {
  return <div />;
});

export function textVars(
  _all: ReadonlyMap<string, string>,
  _o: TextOptions,
): ReadonlyMap<string, string> {
  return new Map();
}
