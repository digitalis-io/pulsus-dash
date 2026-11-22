/** The panel run's key and view (plan #64 §3.1, §4.2). */
import type { PanelVisKind } from '../api/types';
import type { FrameData } from '../data/frames';
import type { Diagnostic } from '../editor/lang/types';
import type { VisKind, VisSpec } from '../engine/api';
import type { PanelRun } from './usePanelRun';

export interface Resolved {
  readonly text: string;
  readonly vars: string;
}

export type PanelView =
  | { readonly kind: 'message'; readonly state: PanelState; readonly text: string }
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'error';
      readonly text: string;
      readonly detail: string;
      readonly narrow: boolean;
    }
  | {
      readonly kind: 'frame';
      readonly spec: VisSpec;
      readonly data: FrameData;
      readonly vis: VisKind;
    };

export type PanelState =
  | 'empty'
  | 'variable'
  | 'unsupported'
  | 'logs'
  | 'refused'
  | 'langFailed'
  | 'noBuckets'
  | 'tooManyTimestamps'
  | 'string';

export const PANEL_KEY_HEAD = 7;

export function panelRunKey(
  _tenant: string,
  _id: string,
  _r: Resolved,
  _kind: 'range' | 'instant',
  _stepMs: number,
  _w: { readonly fromMs: number; readonly toMs: number },
): readonly unknown[] {
  throw new Error('not implemented');
}

export function panelIdleKey(_tenant: string, _id: string, _text: string): readonly unknown[] {
  throw new Error('not implemented');
}

export function sameExceptWindow(_a: readonly unknown[], _b: readonly unknown[]): boolean {
  throw new Error('not implemented');
}

export function sameKey(_a: readonly unknown[], _b: readonly unknown[]): boolean {
  throw new Error('not implemented');
}

/** ` (line {line}, column {column})` of the first diagnostic with a position; else ''. */
export function positionText(_text: string, _diagnostics: readonly Diagnostic[]): string {
  throw new Error('not implemented');
}

export function panelView(_run: PanelRun, _vis: PanelVisKind, _title: string): PanelView {
  throw new Error('not implemented');
}
