import { describe, expect, it } from 'vitest';
import {
  checkFilterKey,
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
    expect(Object.fromEntries(r.vars)).toEqual({ env: 'prod' });
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
    expect(readBoardParams([['var-a', v200]]).vars.get('a')).toBe(v200);
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

    // 300 one-character variables: true up to the last that keeps the total within 4 096 − 96.
    const xs = Array.from({ length: 300 }, (_, i) => v(i + 1, 1, 'x'));
    const bytes = (n: number) =>
      requestTargetBytes(path, contextSearchString(context, xs.slice(0, n)));
    let last = 0;
    while (last < 300 && bytes(last + 1) <= 4096 - 96) last += 1;
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(300);
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
