import { describe, expect, it } from 'vitest';
import {
  ALL_TOKEN,
  checkFilterKey,
  decodeValue,
  encodeValue,
  withVarValues,
  checkParamValue,
  fitsUrlBudget,
  overrideReserve,
  readBoardParams,
  requestTargetBytes,
  withFilter,
  withoutSectionOverrides,
  withSectionOverride,
  withVar,
} from './boardParams';
import {
  contextSearchString,
  DEFAULT_CONTEXT,
  readContextSearch,
  type SearchParamPair,
} from './contextSearch';

const env = { nowMs: Date.UTC(2026, 10, 19, 13, 3), timeZone: 'Europe/London' };

/** `o` written as a URL and read back: the `rest` the Context hook would give. */
function roundTrip(o: readonly SearchParamPair[]): readonly SearchParamPair[] {
  return readContextSearch(new URLSearchParams(contextSearchString(DEFAULT_CONTEXT, o)), env).rest;
}

describe('board params', () => {
  it('read board params', () => {
    const r = readBoardParams([
      ['f', 'env=prod'],
      ['f', 'region=eu=1'],
      ['f', 'bad key=x'],
      ['f', 'env=dup'],
      ['f', 'novalue='],
      ['f', 'noequals'],
      ['var-env', 'prod'],
      ['var-env', 'x'],
      ['var-9x', 'y'],
      ['var-region', ''],
    ]);
    expect(Object.fromEntries(r.vars)).toEqual({ env: ['prod', 'x'] });
    expect(r.filters).toEqual([
      { key: 'env', value: 'prod' },
      { key: 'region', value: 'eu=1' },
    ]);
  });

  it('filter and value limits', () => {
    const many: SearchParamPair[] = Array.from({ length: 25 }, (_, i) => ['f', `k${String(i)}=v`]);
    expect(readBoardParams(many).filters.map((f) => f.key)).toEqual(
      Array.from({ length: 20 }, (_, i) => `k${String(i)}`),
    );
    const v200 = '😀'.repeat(200);
    expect(v200.length).toBe(400);
    expect(readBoardParams([['var-a', v200]]).vars.get('a')).toEqual([v200]);
    expect(readBoardParams([['var-a', '😀'.repeat(201)]]).vars.has('a')).toBe(false);
    expect(readBoardParams([['f', `a=${v200}`]]).filters).toEqual([{ key: 'a', value: v200 }]);
    expect(readBoardParams([['f', `a=${'😀'.repeat(201)}`]]).filters).toEqual([]);
  });

  it('with var and filter', () => {
    const outputs: SearchParamPair[][] = [];
    const check = (o: SearchParamPair[], want: SearchParamPair[]): void => {
      expect(o).toEqual(want);
      outputs.push(o);
    };
    check(
      withVar(
        [
          ['q', 'x'],
          ['var-env', 'a'],
        ],
        'env',
        'b',
      ),
      [
        ['q', 'x'],
        ['var-env', 'b'],
      ],
    );
    check(
      withVar(
        [
          ['q', 'x'],
          ['var-env', 'a'],
        ],
        'env',
        null,
      ),
      [['q', 'x']],
    );
    check(withVar([['zz', '1']], 'a', 'v'), [
      ['var-a', 'v'],
      ['zz', '1'],
    ]);
    const ab: SearchParamPair[] = [
      ['f', 'a=1'],
      ['f', 'b=2'],
    ];
    check(withFilter(ab, 'a', '3'), [
      ['f', 'a=3'],
      ['f', 'b=2'],
    ]);
    check(withFilter(ab, 'c', '4'), [
      ['f', 'a=1'],
      ['f', 'b=2'],
      ['f', 'c=4'],
    ]);
    check(withFilter(ab, 'a', null), [['f', 'b=2']]);
    for (const o of outputs) expect(roundTrip(o)).toEqual(o);
  });

  it('section overrides', () => {
    const ids = ['s-1', 's-2'];
    const r = readBoardParams([
      ['collapse', 's-1'],
      ['expand', 's-2'],
      ['collapse', 's-2'],
      ['collapse', 'S 1'],
      ['collapse', 's-1'],
    ]);
    expect([...r.sections.collapse]).toEqual(['s-1']);
    expect([...r.sections.expand]).toEqual([]);
    const a = withSectionOverride([], 's-2', true, ids);
    expect(a).toEqual([['collapse', 's-2']]);
    const b = withSectionOverride(a, 's-1', false, ids);
    expect(b).toEqual([
      ['collapse', 's-2'],
      ['expand', 's-1'],
    ]);
    const c = withSectionOverride(b, 's-2', null, ids);
    expect(c).toEqual([['expand', 's-1']]);
    const d = withSectionOverride([['collapse', 'gone']], 's-1', true, ids);
    expect(d).toEqual([['collapse', 's-1']]);
    const e = withoutSectionOverrides([
      ['collapse', 's-1'],
      ['f', 'a=1'],
    ]);
    expect(e).toEqual([['f', 'a=1']]);
    for (const o of [a, b, c, d, e]) expect(roundTrip(o)).toEqual(o);
  });

  it('url budget', () => {
    const path = '/t/demo/board/b-3';
    const context = { from: 'now-1h', to: 'now', refresh: 'off' } as const;
    expect(contextSearchString(context)).toHaveLength(31);
    const v = (k: number, n: number, c: string): SearchParamPair => [
      `var-v${String(k)}`,
      c.repeat(n),
    ];
    expect(requestTargetBytes('/a', '?x=%C3%A9')).toBe(11);
    expect(overrideReserve(['s-1', 's-22'])).toBe(27);

    const e = (n: number) => Array.from({ length: n }, (_, i) => v(i + 1, 200, 'é'));
    expect(requestTargetBytes(path, contextSearchString(context, e(1))) - 48).toBe(1208);
    expect(fitsUrlBudget(path, context, e(3), [])).toBe(true);
    expect(fitsUrlBudget(path, context, e(4), [])).toBe(false);
    const smile = (n: number) => Array.from({ length: n }, (_, i) => v(i + 1, 200, '😀'));
    expect(requestTargetBytes(path, contextSearchString(context, smile(1))) - 48).toBe(2408);
    expect(fitsUrlBudget(path, context, smile(1), [])).toBe(true);
    expect(fitsUrlBudget(path, context, smile(2), [])).toBe(false);

    // One-character variables: true up to the last that keeps the total within 4 096 − 96. (300
    // such pairs come to 3 240 bytes, inside the budget; 400 cross it.)
    const xs = Array.from({ length: 400 }, (_, i) => v(i + 1, 1, 'x'));
    const bytes = (n: number) =>
      requestTargetBytes(path, contextSearchString(context, xs.slice(0, n)));
    let last = 0;
    expect(bytes(300)).toBeLessThanOrEqual(4096 - 96);
    while (last < 400 && bytes(last + 1) <= 4096 - 96) last += 1;
    expect(last).toBeGreaterThan(300);
    expect(last).toBeLessThan(400);
    expect(fitsUrlBudget(path, context, xs.slice(0, last), [])).toBe(true);
    expect(fitsUrlBudget(path, context, xs.slice(0, last + 1), [])).toBe(false);

    // Section ids reduce the room by exactly their override reserve.
    const ids = Array.from({ length: 50 }, (_, i) => `s-${String(i + 1)}`);
    const reserve = overrideReserve(ids);
    let withIds = 0;
    while (bytes(withIds + 1) + reserve <= 4096 - 96) withIds += 1;
    expect(fitsUrlBudget(path, context, xs.slice(0, withIds), ids)).toBe(true);
    expect(fitsUrlBudget(path, context, xs.slice(0, withIds + 1), ids)).toBe(false);
    expect(withIds).toBeLessThan(last);
    // Overrides already in the URL are not counted twice: the reserve covers them.
    const withOverrides: SearchParamPair[] = [
      ...xs.slice(0, withIds),
      ...ids.map((id): SearchParamPair => ['collapse', id]),
    ];
    expect(fitsUrlBudget(path, context, withOverrides, ids)).toBe(true);
  });

  it('param checks', () => {
    expect(checkFilterKey('service.name')).toBeNull();
    for (const k of ['9a', 'a-b', '']) expect(checkFilterKey(k), k).toBe('filter.keyInvalid');
    expect(checkParamValue('')).toBe('filter.valueRequired');
    expect(checkParamValue('  ')).toBe('filter.valueRequired');
    expect(checkParamValue('a'.repeat(201))).toBe('filter.valueTooLong');
    expect(checkParamValue('x')).toBeNull();
  });
});

// unit:board-params-multi (IA-022, plan #289 §4.1): repeated var- values and the $ escape.
describe('board params: multi-value variables', () => {
  const defined = new Set(['n']);
  it('keeps distinct values in address order', () => {
    const r = readBoardParams(
      [
        ['var-n', 'a'],
        ['var-n', 'b'],
        ['var-n', 'a'],
      ],
      defined,
    );
    expect(r.vars.get('n')).toEqual(['a', 'b']);
  });

  it('reads $__all as All and $$__all as the literal', () => {
    expect(ALL_TOKEN).toBe('$__all');
    const all = readBoardParams([['var-n', '$__all']], defined).vars.get('n') ?? [];
    expect(all.map(decodeValue)).toEqual([{ all: true }]);
    const lit = readBoardParams([['var-n', '$$__all']], defined).vars.get('n') ?? [];
    expect(lit.map(decodeValue)).toEqual([{ value: '$__all' }]);
    // One leading $ is stripped from any other value of a defined variable.
    expect(decodeValue('$$x')).toEqual({ value: '$x' });
    expect(decodeValue('$x')).toEqual({ value: 'x' });
    expect(decodeValue('x')).toEqual({ value: 'x' });
  });

  it('writes a literal starting with $ with one more $', () => {
    expect(encodeValue('$x')).toBe('$$x');
    expect(encodeValue('$__all')).toBe('$$__all');
    expect(encodeValue('x')).toBe('x');
    expect(
      withVarValues([['from', 'now-1h']], 'n', [encodeValue('a'), encodeValue('$b'), ALL_TOKEN]),
    ).toEqual([
      ['from', 'now-1h'],
      ['var-n', 'a'],
      ['var-n', '$$b'],
      ['var-n', '$__all'],
    ]);
    expect(
      withVarValues(
        [
          ['var-n', 'a'],
          ['var-m', 'x'],
        ],
        'n',
        null,
      ),
    ).toEqual([['var-m', 'x']]);
  });

  it('applies the 200 code-point limit to the decoded value', () => {
    const literal = '$' + 'y'.repeat(199);
    const param = encodeValue(literal);
    expect([...param].length).toBe(201);
    const got = readBoardParams([['var-n', param]], defined).vars.get('n') ?? [];
    expect(got.map(decodeValue)).toEqual([{ value: literal }]);
    // An undefined variable is read raw: 201 code points are over its limit.
    expect(readBoardParams([['var-m', param]], defined).vars.has('m')).toBe(false);
    // A decoded value over 200 is dropped.
    expect(readBoardParams([['var-n', '$$' + 'y'.repeat(200)]], defined).vars.has('n')).toBe(false);
  });

  it('a write over the budget is refused', () => {
    const path = '/t/demo/b/x';
    const context = DEFAULT_CONTEXT;
    const values = Array.from(
      { length: 200 },
      (_, i) => `clickhouse-node-${String(i).padStart(3, '0')}-replica`,
    );
    const next = withVarValues([], 'n', values);
    expect(fitsUrlBudget(path, context, next, [])).toBe(false);
    expect(fitsUrlBudget(path, context, withVarValues([], 'n', values.slice(0, 10)), [])).toBe(
      true,
    );
  });
});
