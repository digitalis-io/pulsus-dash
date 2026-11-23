import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/types';
import type { RangeResult } from '../data/decode';
import { fromInstant, fromRange } from '../vis/autovis';
import { R_A, R_H1 } from '../test/rangeFixtures';
import {
  positionText,
  panelIdleKey,
  panelRunKey,
  panelView,
  PANEL_KEY_HEAD,
  sameExceptWindow,
  sameKey,
} from './panelRun';
import type { PanelRun } from './usePanelRun';

const W = { fromMs: 1, toMs: 2 };
const R = { text: 'up', vars: '[]' };

describe('panelRunKey and sameExceptWindow', () => {
  it('panelRunKey and sameExceptWindow', () => {
    const k = panelRunKey('demo', 'p-1', R, 'range', 5000, W);
    expect(k).toEqual(['data', 'panel', 'demo', 'p-1', 'up', '[]', 'range', 5000, 1, 2]);
    expect(PANEL_KEY_HEAD).toBe(7);
    expect(panelIdleKey('demo', 'p-1', 'up')).toEqual(['data', 'panel', 'demo', 'p-1', 'up', null]);
    const heads = [
      panelRunKey('other', 'p-1', R, 'range', 5000, W),
      panelRunKey('demo', 'p-2', R, 'range', 5000, W),
      panelRunKey('demo', 'p-1', { ...R, text: 'x' }, 'range', 5000, W),
      panelRunKey('demo', 'p-1', { ...R, vars: '[["a","b"]]' }, 'range', 5000, W),
      panelRunKey('demo', 'p-1', R, 'instant', 5000, W),
    ];
    for (const h of heads) {
      expect(sameExceptWindow(k, h)).toBe(false);
      expect(sameKey(k, h)).toBe(false);
    }
    const windows = [
      panelRunKey('demo', 'p-1', R, 'range', 30000, W),
      panelRunKey('demo', 'p-1', R, 'range', 5000, { fromMs: 0, toMs: 2 }),
      panelRunKey('demo', 'p-1', R, 'range', 5000, { fromMs: 1, toMs: 3 }),
    ];
    for (const w of windows) {
      expect(sameExceptWindow(k, w)).toBe(true);
      expect(sameKey(k, w)).toBe(false);
    }
    const idle = panelIdleKey('demo', 'p-1', 'up');
    expect(sameExceptWindow(k, idle)).toBe(false);
    expect(sameExceptWindow(idle, idle)).toBe(false);
    expect(sameKey(k, panelRunKey('demo', 'p-1', R, 'range', 5000, W))).toBe(true);
  });
});

const BASE: PanelRun = {
  text: 'up{',
  blocked: null,
  missing: [],
  refusal: null,
  ready: true,
  outcome: null,
  error: null,
  diagnostics: [],
  fetching: false,
  stepMs: 5000,
  expanded: null,
};

function outcome(r: RangeResult, facts: { rateApplied?: boolean } = {}) {
  return {
    key: [],
    planned: { ...r.planned, ...facts },
    result: fromRange(r),
  };
}

describe('panelView', () => {
  it('blocked states', () => {
    const msg = (run: Partial<PanelRun>) => panelView({ ...BASE, ...run }, { kind: 'auto' }, 'T');
    expect(msg({ blocked: 'unsupported' })).toEqual({
      kind: 'message',
      state: 'unsupported',
      text: 'Runs when LogQL support lands',
    });
    expect(msg({ blocked: 'logs' })).toEqual({
      kind: 'message',
      state: 'logs',
      text: 'The log stream arrives with LogQL panels',
    });
    expect(msg({ blocked: 'empty' })).toEqual({
      kind: 'message',
      state: 'empty',
      text: 'Add a query',
    });
    expect(msg({ blocked: 'variable', missing: ['a', 'b'] })).toEqual({
      kind: 'message',
      state: 'variable',
      text: 'Set a value for $a, $b to run this panel',
    });
    expect(msg({ blocked: 'langFailed' })).toEqual({
      kind: 'message',
      state: 'langFailed',
      text: 'PromQL support could not be loaded. Reload the page.',
    });
    expect(msg({ blocked: 'refused', refusal: 'queryTooLarge' })).toMatchObject({
      kind: 'message',
      state: 'refused',
    });
    const big = msg({ blocked: 'refused', refusal: 'queryTooLarge' });
    const long = msg({ blocked: 'refused', refusal: 'tooLong' });
    expect(big).not.toEqual(long);
  });

  it('error, loading and results', () => {
    const e = new ApiError('queryInvalid', 'bad', { detail: { position: 3 } });
    expect(
      panelView(
        {
          ...BASE,
          error: e,
          diagnostics: [{ from: 2, to: 3, message: 'bad', positionKnown: true }],
        },
        { kind: 'auto' },
        'T',
      ),
    ).toEqual({ kind: 'error', text: 'bad', detail: 'bad (line 1, column 3)', narrow: false });
    const multi = panelView(
      {
        ...BASE,
        text: 'ab\ncd',
        error: e,
        diagnostics: [{ from: 4, to: 5, message: 'bad', positionKnown: true }],
      },
      { kind: 'auto' },
      'T',
    );
    // The diagnostics index the text the run had.
    expect(multi).toMatchObject({ kind: 'error', detail: 'bad (line 2, column 2)' });
    const broad = panelView(
      { ...BASE, error: new ApiError('tooBroad', 'wide') },
      { kind: 'auto' },
      'T',
    );
    expect(broad).toMatchObject({ kind: 'error', text: 'wide', narrow: true });
    expect(panelView(BASE, { kind: 'auto' }, 'T')).toEqual({ kind: 'loading' });

    const line = panelView({ ...BASE, outcome: outcome(R_A) }, { kind: 'auto' }, 'T');
    expect(line).toMatchObject({ kind: 'frame', vis: 'line', spec: { kind: 'line', title: 'T' } });
    const heat = panelView({ ...BASE, outcome: outcome(R_H1) }, { kind: 'auto' }, 'T');
    expect(heat).toMatchObject({ kind: 'frame', vis: 'heatmap' });
    const stat = panelView({ ...BASE, outcome: outcome(R_A) }, { kind: 'stat' }, 'T');
    expect(stat).toMatchObject({ kind: 'frame', vis: 'stat' });
    const rate = panelView(
      { ...BASE, outcome: outcome(R_A, { rateApplied: true }) },
      { kind: 'auto' },
      'T',
    );
    expect(rate).toMatchObject({ kind: 'frame', spec: { unit: { kind: 'suffix', suffix: '/s' } } });
    const noBuckets = panelView({ ...BASE, outcome: outcome(R_A) }, { kind: 'heatmap' }, 'T');
    expect(noBuckets).toMatchObject({ kind: 'message', state: 'noBuckets' });
    const str = panelView(
      {
        ...BASE,
        outcome: {
          key: [],
          planned: { ...R_A.planned, valueType: 'string' },
          result: fromInstant({
            planned: R_A.planned,
            kind: 'string',
            value: 'hi',
            timestampMs: 1,
            atMs: 1,
            completeness: R_A.completeness,
          }),
        },
      },
      { kind: 'auto' },
      'T',
    );
    expect(str).toEqual({ kind: 'message', state: 'string', text: 'String result: hi' });
  });

  it('position text in lines and code points', () => {
    expect(positionText('up{', [{ from: 2, to: 3, message: 'm', positionKnown: true }])).toBe(
      ' (line 1, column 3)',
    );
    expect(positionText('ab\ncd', [{ from: 4, to: 5, message: 'm', positionKnown: true }])).toBe(
      ' (line 2, column 2)',
    );
    expect(positionText('😀x', [{ from: 2, to: 3, message: 'm', positionKnown: true }])).toBe(
      ' (line 1, column 2)',
    );
    expect(positionText('x', [{ from: 0, to: 1, message: 'm', positionKnown: false }])).toBe('');
    expect(positionText('x', [])).toBe('');
  });
});

describe('panelView thresholds (#64 Part B §4.1)', () => {
  it('heatmap ignores thresholds', () => {
    const vis = {
      kind: 'heatmap' as const,
      thresholds: {
        direction: 'above' as const,
        steps: [{ value: 2, state: 'degraded' as const, label: '' }],
      },
    };
    const view = panelView({ ...BASE, outcome: outcome(R_H1) }, vis, 'T');
    expect(view).toMatchObject({ kind: 'frame', vis: 'heatmap' });
    if (view.kind !== 'frame') throw new Error('not a frame');
    expect('thresholds' in view.spec).toBe(false);
  });
});
