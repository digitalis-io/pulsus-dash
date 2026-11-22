import { describe, expect, it } from 'vitest';
import { defaultSeed } from '../api/stubData';
import { panelVars, referencedVariables } from './variableRefs';
import { boardVariables } from './variables';

describe('referencedVariables and panelVars', () => {
  it('referencedVariables and panelVars', () => {
    const text = '$a ${b} $__interval $1 $ $a';
    expect(referencedVariables(text)).toEqual(['a', 'b']);
    const vars = new Map([
      ['a', 'x'],
      ['c', 'y'],
    ]);
    expect(panelVars(text, vars)).toEqual([['a', 'x']]);
    expect(
      panelVars(
        '$z $y',
        new Map([
          ['y', '1'],
          ['z', '2'],
        ]),
      ),
    ).toEqual([
      ['y', '1'],
      ['z', '2'],
    ]);
    expect(referencedVariables(`$${'v'.repeat(65)}`)).toEqual([]);
    expect(referencedVariables('up')).toEqual([]);
    // #61's seeds: unchanged output.
    const b3 = defaultSeed.boards.find((b) => b.uid === 'b-3');
    if (b3 === undefined) throw new Error('no b-3');
    expect(boardVariables(b3.spec)).toEqual(['region', 'env']);
  });
});
