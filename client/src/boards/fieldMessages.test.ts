/** A save's field error texts (#290 §4.4): an older server's refusal of panel units. */
import { describe, expect, it } from 'vitest';
import type { BoardSpec } from '../api/types';
import { fieldMessage, saveFieldMessage, unitsUnsupported } from './fieldMessages';

const SPEC: BoardSpec = {
  title: 'B',
  panels: [
    {
      id: 'p-1',
      title: 'A',
      grid: { x: 0, y: 0, w: 6, h: 8 },
      query: { lang: 'promql', text: 'up' },
      vis: { kind: 'line', unit: { id: 'seconds' } },
    },
  ],
  sections: [],
};

describe('unitsUnsupported', () => {
  it('board.json.unknownKey at …/vis/unit is the units text', () => {
    const f = { pointer: '/panels/0/vis/unit', messageKey: 'board.json.unknownKey' };
    expect(unitsUnsupported(f)).toBe(true);
    expect(saveFieldMessage(SPEC, f)).toBe('This server does not support panel units yet');
    const other = { pointer: '/panels/0/vis/legend', messageKey: 'board.json.unknownKey' };
    expect(unitsUnsupported(other)).toBe(false);
    expect(saveFieldMessage(SPEC, other)).toBe(fieldMessage('board.json.unknownKey'));
    const suffix = {
      pointer: '/panels/0/vis/unit/suffix',
      messageKey: 'board.unit.suffix.invalid',
    };
    expect(unitsUnsupported(suffix)).toBe(false);
    expect(saveFieldMessage(SPEC, suffix)).toBe('Suffix: 1 to 16 characters, no spaces');
  });
});
