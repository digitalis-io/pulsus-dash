/**
 * The board panel run's query key and what a panel shows (plan #64 §3.1, §4.2). The key carries the
 * inputs the panel sends (ADR-0021: never a planned text) and, outside its head, the step and the
 * resolved window, so a time change, a zoom or a relative refresh is a new key whose placeholder is
 * the previous result (§4.3).
 */
import type { PanelVisKind } from '../api/types';
import type { FrameData } from '../data/frames';
import type { Diagnostic } from '../editor/lang/types';
import type { VisKind, VisSpec } from '../engine/api';
import { errorView, refusalText } from '../explore/statusText';
import { t } from '../i18n/t';
import { autoVis, chooseVis } from '../vis/autovis';
import { framePlan } from '../vis/framePlan';
import type { PanelRun } from './usePanelRun';

export interface Resolved {
  /** The panel text as saved (or the editor's run text, §4.4); sent raw. */
  readonly text: string;
  /** JSON of `panelVars(text, vars)`: `[name, value]` pairs sorted by name. */
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

/** The head: indices 0–6 (through `kind`). */
export const PANEL_KEY_HEAD = 7;
const RUN_KEY_LENGTH = 10;

/** `['data', 'panel', tenant, id, text, vars, kind, step, fromMs, toMs]`. */
export function panelRunKey(
  tenant: string,
  id: string,
  r: Resolved,
  kind: 'range' | 'instant',
  stepMs: number,
  w: { readonly fromMs: number; readonly toMs: number },
): readonly unknown[] {
  return ['data', 'panel', tenant, id, r.text, r.vars, kind, stepMs, w.fromMs, w.toMs];
}

/** The key while nothing can be sent (no request): `['data', 'panel', tenant, id, text, null]`. */
export function panelIdleKey(tenant: string, id: string, text: string): readonly unknown[] {
  return ['data', 'panel', tenant, id, text, null];
}

/** Equal heads (`===` per element) and both are run keys (length 10). */
export function sameExceptWindow(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== RUN_KEY_LENGTH || b.length !== RUN_KEY_LENGTH) return false;
  for (let i = 0; i < PANEL_KEY_HEAD; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Equal length and `===` per element. */
export function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * ` (line {line}, column {column})` of the first diagnostic when it has a position: 1-based, lines
 * split on `\n`, the column in code points of `text`, at `from`; otherwise ''.
 */
export function positionText(text: string, diagnostics: readonly Diagnostic[]): string {
  const d = diagnostics[0];
  if (d === undefined || !d.positionKnown) return '';
  const before = text.slice(0, d.from);
  const start = before.lastIndexOf('\n') + 1;
  let line = 1;
  for (const c of before) if (c === '\n') line += 1;
  const column = Array.from(before.slice(start)).length + 1;
  return t('panel.errorAt', { line, column });
}

const message = (state: PanelState, text: string): PanelView => ({
  kind: 'message',
  state,
  text,
});

/** Pure: §4.2's table, first match. `title` is the panel title (`panelTitle`). */
export function panelView(run: PanelRun, vis: PanelVisKind, title: string): PanelView {
  switch (run.blocked) {
    case 'unsupported':
      return message('unsupported', t('panel.noRoute.logql'));
    case 'logs':
      return message('logs', t('panel.noVis'));
    case 'empty':
      return message('empty', t('panel.empty'));
    case 'variable':
      return message(
        'variable',
        t('panel.variable', { names: run.missing.map((n) => `$${n}`).join(', ') }),
      );
    case 'langFailed':
      return message('langFailed', t('panel.langFailed'));
    case 'refused':
      return message('refused', refusalText(run.refusal ?? 'queryTooLarge'));
    default:
      break;
  }
  if (run.error !== null) {
    const ev = errorView(run.error, run.diagnostics) ?? { text: t('error.generic'), narrow: false };
    return {
      kind: 'error',
      text: ev.text,
      detail: ev.text + positionText(run.text, run.diagnostics),
      narrow: ev.narrow,
    };
  }
  const o = run.outcome;
  if (o === null) return { kind: 'loading' };
  const r = o.result;
  if (r.kind === 'string') return message('string', t('explore.result.string', { value: r.value }));
  const auto = autoVis({
    histogram: o.planned.histogram,
    rateApplied: o.planned.rateApplied,
    result: r,
  });
  // `logs` is blocked above; any other saved kind overrides the auto vis.
  const chosen = chooseVis(vis === 'auto' || vis === 'logs' ? 'auto' : vis, auto) ?? 'line';
  const plan = framePlan(chosen, r, {
    isolatedKey: null,
    title,
    rateApplied: o.planned.rateApplied,
  });
  if (plan.notice === 'noBuckets') return message('noBuckets', t('explore.vis.noBuckets'));
  if (plan.notice === 'tooManyTimestamps') {
    return message('tooManyTimestamps', t('explore.vis.tooManyTimestamps'));
  }
  if (plan.notice === 'string') return message('string', t('explore.result.string', { value: '' }));
  return { kind: 'frame', spec: plan.spec, data: plan.data, vis: chosen };
}
