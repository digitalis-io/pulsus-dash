/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardSpec, PanelSpec } from '../api/types';
import { messages } from '../i18n/messages.en-GB';
import { fieldMessage } from './fieldMessages';
import { GRID_LIMITS } from './layout';
import { canonicalJson, checkBoardSpec, nextPanelId } from './spec';

/** `api/fixtures/board-spec/` (vitest runs in `client/`). */
const FIXTURES = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

interface Case {
  name: string;
  spec?: unknown;
  raw?: string;
  fields: { pointer: string; message_key: string }[];
}

const cases = fixture('invalid.json') as Case[];

function panel(id: string, [x, y, w, h]: readonly number[]): PanelSpec {
  return {
    id,
    title: id,
    grid: { x: x ?? 0, y: y ?? 0, w: w ?? 1, h: h ?? 1 },
    query: { lang: 'promql', text: 'up' },
    vis: { kind: 'line' },
  };
}

describe('unit:board-spec (TS)', () => {
  it('v1 fixtures round-trip', () => {
    for (const name of ['v1-minimal.json', 'v1-full.json']) {
      const x = fixture(name);
      expect(checkBoardSpec(x), name).toEqual([]);
      expect(JSON.parse(canonicalJson(x)), name).toEqual(x);
    }
    expect(canonicalJson(fixture('v1-minimal.json'))).toBe(
      '{"panels":[],"sections":[],"title":"New board"}',
    );
  });

  it('invalid fixtures match the server', () => {
    const raw: string[] = [];
    for (const c of cases) {
      if (c.raw !== undefined) {
        raw.push(c.name);
        continue;
      }
      expect(checkBoardSpec(c.spec), c.name).toEqual(
        c.fields.map((f) => ({ pointer: f.pointer, messageKey: f.message_key })),
      );
    }
    expect(raw.sort()).toEqual(
      ['not-json', 'trailing-data', 'empty-body', 'duplicate-key', 'float-grid', 'exp-grid'].sort(),
    );
  });

  it('every message key has text', () => {
    const keys = new Set(cases.flatMap((c) => c.fields.map((f) => f.message_key)));
    expect(keys.size).toBeGreaterThan(20);
    const catalogue = new Set<string>(Object.values(messages));
    for (const key of keys) {
      const text = fieldMessage(key);
      expect(text, key).not.toBe('');
      expect(catalogue.has(text), key).toBe(true);
    }
  });

  it('nextPanelId', () => {
    const spec = (ids: string[]): BoardSpec => ({
      title: 'B',
      panels: ids.map((id) => panel(id, [0, 0, 1, 1])),
      sections: [],
    });
    expect(nextPanelId(spec([]))).toBe('p-1');
    expect(nextPanelId(spec(['p-1', 'x', 'p-9']))).toBe('p-10');
  });

  it('limits match the server', () => {
    expect(GRID_LIMITS).toEqual({ cols: 12, maxY: 9999, maxH: 100, maxBottom: 10099 });
    const out = cases.find((c) => c.name === 'grid-out-of-bounds');
    expect(out?.fields).toEqual([
      { pointer: '/panels/0/grid', message_key: 'board.grid.outOfBounds' },
    ]);
    const board = (grid: readonly number[]): BoardSpec => ({
      title: 'B',
      panels: [panel('p-1', grid)],
      sections: [],
    });
    const bounds = [{ pointer: '/panels/0/grid', messageKey: 'board.grid.outOfBounds' }];
    expect(checkBoardSpec(board([0, 9999, 12, 100]))).toEqual([]);
    expect(checkBoardSpec(board([0, 10000, 12, 1]))).toEqual(bounds);
    expect(checkBoardSpec(board([0, 0, 12, 101]))).toEqual(bounds);
  });
});
