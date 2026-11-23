import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../test/random';
import { advance, lexLogQL, scanAt, startLex, type Frame, type TokenKind } from './lexer';

// Appendix A.2.2 of plan #66 Part A.
type Row = readonly [TokenKind, string, boolean?];
const S: Row = ['space', ' '];

const shown = (text: string) =>
  lexLogQL(text).map((t) => [t.kind, text.slice(t.from, t.to), t.closed] as const);
const want = (rows: readonly Row[]) => rows.map(([k, s, c]) => [k, s, c ?? true] as const);

describe('unit:logql-lex', () => {
  const rows: [string, string, Row[]][] = [
    [
      'L1',
      '{app="a\\"b"}',
      [
        ['lbrace', '{'],
        ['ident', 'app'],
        ['matchOp', '='],
        ['string', '"a\\"b"'],
        ['rbrace', '}'],
      ],
    ],
    // LogQL has no comments (#121): a `#` outside a string is one error token and the rest of the
    // line is scanned as LogQL.
    [
      'L2',
      '|= `x` # c',
      [['lineFilter', '|='], S, ['rawString', '`x`'], S, ['error', '#'], S, ['ident', 'c']],
    ],
    [
      'L2b',
      '#{a',
      [
        ['error', '#'],
        ['lbrace', '{'],
        ['ident', 'a'],
      ],
    ],
    ['L2c', '"a#b"', [['string', '"a#b"']]],
    ['L3', '"ab', [['string', '"ab', false]]],
    [
      'L4',
      '"a\nb"',
      [
        ['string', '"a', false],
        ['space', '\n'],
        ['ident', 'b'],
        ['string', '"', false],
      ],
    ],
    ['L5', '`a\nb`', [['rawString', '`a\nb`']]],
    [
      'L6',
      '5m 1h30m 5µs 5 2.5 10KB 3MiB 5x',
      [
        ['duration', '5m'],
        S,
        ['duration', '1h30m'],
        S,
        ['duration', '5µs'],
        S,
        ['number', '5'],
        S,
        ['number', '2.5'],
        S,
        ['bytes', '10KB'],
        S,
        ['bytes', '3MiB'],
        S,
        ['error', '5x'],
      ],
    ],
    [
      'L7',
      '!= !~ =~ = ==',
      [
        ['matchOp', '!='],
        S,
        ['matchOp', '!~'],
        S,
        ['matchOp', '=~'],
        S,
        ['matchOp', '='],
        S,
        ['cmpOp', '=='],
      ],
    ],
    [
      'L8',
      '>= <= > <',
      [['cmpOp', '>='], S, ['cmpOp', '<='], S, ['cmpOp', '>'], S, ['cmpOp', '<']],
    ],
    [
      'L9',
      '| |~ |> !>',
      [['pipe', '|'], S, ['lineFilter', '|~'], S, ['lineFilter', '|>'], S, ['lineFilter', '!>']],
    ],
    ['L10', '+-*/%^', ['+', '-', '*', '/', '%', '^'].map((c): Row => ['arith', c])],
    [
      'L11',
      '$x',
      [
        ['error', '$'],
        ['ident', 'x'],
      ],
    ],
    [
      'L12',
      'sum by(pod)',
      [['ident', 'sum'], S, ['ident', 'by'], ['lparen', '('], ['ident', 'pod'], ['rparen', ')']],
    ],
    [
      'L13',
      '[5m],',
      [
        ['lbracket', '['],
        ['duration', '5m'],
        ['rbracket', ']'],
        ['comma', ','],
      ],
    ],
    ['L14', '"\\', [['string', '"\\', false]]],
    ['L15', '😀', [['error', '😀']]],
    ['L16', '__error__', [['ident', '__error__']]],
  ];
  for (const [name, text, expected] of rows) {
    it(name, () => {
      expect(shown(text)).toEqual(want(expected));
    });
  }

  it('a backtick string continued from an earlier line (inRaw)', () => {
    const t = scanAt('"a`b"', 0, true);
    expect([t.kind, t.from, t.to, t.closed]).toEqual(['rawString', 0, 3, true]);
  });

  it('property: any text lexes without throwing into contiguous tokens', () => {
    // A.2 P1: one entry per symbol (the emoji is one entry of two code units).
    const alphabet = [
      ...Array.from('{}()[],|=!~<>+-*/%^"\\`#'),
      '\n',
      '\t',
      ' ',
      ...Array.from('abz09_.µ'),
      '😀',
      '$',
    ];
    const rnd = mulberry32(66);
    for (let n = 0; n < 1000; n++) {
      const len = Math.floor(rnd() * 65);
      let text = '';
      for (let i = 0; i < len; i++) text += alphabet[Math.floor(rnd() * alphabet.length)] ?? '';
      const tokens = lexLogQL(text);
      let at = 0;
      for (const t of tokens) {
        expect(t.from, JSON.stringify(text)).toBe(at);
        expect(t.from).toBeLessThan(t.to);
        at = t.to;
      }
      expect(at, JSON.stringify(text)).toBe(text.length);
    }
  });
});

interface Snap {
  readonly text: string;
  readonly stack: Frame[];
  readonly depthOver: number;
  readonly prevWord: string | null;
}

/** The state after each significant token of `text`. */
function walk(text: string): Snap[] {
  const st = startLex();
  const out: Snap[] = [];
  for (const t of lexLogQL(text)) {
    if (t.kind === 'space') continue;
    advance(st, t, text);
    out.push({
      text: text.slice(t.from, t.to),
      stack: [...st.stack],
      depthOver: st.depthOver,
      prevWord: st.prevWord,
    });
  }
  return out;
}

const at = (snaps: Snap[], i: number): Snap => {
  const s = snaps.at(i);
  if (s === undefined) throw new Error(`no token ${String(i)}`);
  return s;
};

describe('unit:logql-state', () => {
  it('S1: a selector pushes and pops a brace frame', () => {
    const s = walk('{a="b"}');
    expect([at(s, 0).stack, at(s, 0).prevWord]).toEqual([['brace'], null]);
    expect([at(s, -1).stack, at(s, -1).prevWord]).toEqual([[], null]);
  });

  it('S2: a paren after a grouping word is a group frame', () => {
    const s = walk('sum by (a) (x)');
    // sum · by · ( · a · ) · ( · x · )
    expect([at(s, 1).text, at(s, 1).stack, at(s, 1).prevWord]).toEqual(['by', [], 'by']);
    expect([at(s, 2).text, at(s, 2).stack, at(s, 2).prevWord]).toEqual(['(', ['group'], null]);
    expect([at(s, 4).text, at(s, 4).stack, at(s, 4).prevWord]).toEqual([')', [], null]);
    expect([at(s, 6).text, at(s, 6).stack, at(s, 6).prevWord]).toEqual(['x', ['paren'], 'x']);
  });

  it('S3: an unmatched closer is ignored', () => {
    const s = walk(')');
    expect([at(s, 0).stack, at(s, 0).prevWord]).toEqual([[], null]);
  });

  it('S4: a closer that does not match the top is ignored', () => {
    const s = walk('{(}');
    expect([at(s, 1).stack, at(s, 1).prevWord]).toEqual([['brace', 'paren'], null]);
    expect([at(s, 2).stack, at(s, 2).prevWord]).toEqual([['brace', 'paren'], null]);
  });

  it('S5: depth is capped at 64 frames', () => {
    const s = walk('('.repeat(70) + ')'.repeat(70));
    expect(at(s, 69).stack).toHaveLength(64);
    expect(at(s, 69).depthOver).toBe(6);
    expect(at(s, -1).stack).toEqual([]);
    expect(at(s, -1).depthOver).toBe(0);
    expect(at(s, -1).prevWord).toBeNull();
  });
});
