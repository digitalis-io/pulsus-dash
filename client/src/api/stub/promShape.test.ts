/**
 * unit:plan-shape (stub, plan #112 §5.2): the stub shape (Lezer plus the type check of A.9) equals
 * the Go parser's shape on every case of the shared fixture, D1–D9 and their variations included,
 * with no exemption; the stub's function table equals the parser's.
 */
import { describe, expect, it } from 'vitest';
import { expandedOf, FIXTURE, shapeOf } from './planFixture';
import { STABLE_FUNCTIONS } from './promFunctions';
import { stubShape, unquote } from './promShape';

describe('unit:plan-shape (stub)', () => {
  for (const c of FIXTURE.plan) {
    if (c.shape === undefined) continue;
    const shape = c.shape;
    it(c.name, () => {
      const text = expandedOf(c);
      if (text === null) throw new Error('a shape without a plan');
      expect(stubShape(text)).toEqual(shapeOf(shape));
    });
  }

  it('STABLE_FUNCTIONS equals the fixture functions', () => {
    const ours = Object.entries(STABLE_FUNCTIONS)
      .map(([name, f]) => ({
        name,
        arg_types: [...f.argTypes],
        variadic: f.variadic,
        return: f.returns,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    expect(FIXTURE.functions.length).toBeGreaterThan(70);
    expect(ours).toEqual(FIXTURE.functions);
  });
});

describe('unquote (§4.4)', () => {
  it('reads the upstream escapes', () => {
    for (const [lit, want] of [
      ['"\\a\\b\\f\\n\\r\\t\\v\\\\\\""', '\x07\b\f\n\r\t\v\\"'],
      ["'\\''", "'"],
      ['"\\x41\\101\\u00e9\\U0001F600"', 'AAé😀'],
      ['`a\rb`', 'a\rb'],
      ['"\\ufffd"', '\ufffd'],
      ["'\\ufffd'", '\ufffd'],
    ] as const)
      expect(unquote(lit), lit).toBe(want);
  });

  it('refuses what the upstream lexer refuses', () => {
    for (const lit of [
      '"\\\'"',
      "'\\\"'",
      '"\\q"',
      '"\\x4"',
      '"\\400"',
      '"\\ud800"',
      '"\\U00110000"',
      '"a\nb"',
      '"a\ufffdb"',
      "'\ufffd'",
      '`\ufffd`',
    ])
      expect(unquote(lit), lit).toBeNull();
  });
});
