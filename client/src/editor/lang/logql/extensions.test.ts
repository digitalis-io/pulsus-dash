import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { describe, expect, it } from 'vitest';
import { logqlLanguage } from './extensions';

// Appendix A.2.2 (Highlight) of plan #66 Part A.
const TAGS = tagHighlighter([
  { tag: tags.labelName, class: 'L' },
  { tag: tags.function(tags.variableName), class: 'F' },
  { tag: tags.keyword, class: 'K' },
  { tag: tags.string, class: 'S' },
  { tag: tags.number, class: 'N' },
  { tag: tags.comment, class: 'C' },
  { tag: tags.invalid, class: 'X' },
]);

function pairs(doc: string): [string, string][] {
  const state = EditorState.create({ doc, extensions: [logqlLanguage] });
  const tree = ensureSyntaxTree(state, doc.length, 1e9);
  if (tree === null) throw new Error('no tree');
  const out: [string, string][] = [];
  highlightTree(tree, TAGS, (from, to, cls) => {
    out.push([doc.slice(from, to), cls]);
  });
  return out;
}

describe('unit:logql-highlight', () => {
  const rows: [string, string, [string, string][]][] = [
    [
      'H1',
      '{app="web"} |= "x"',
      [
        ['app', 'L'],
        ['"web"', 'S'],
        ['"x"', 'S'],
      ],
    ],
    [
      'H2',
      '{app="web"} | json | line_format "{{.msg}}"',
      [
        ['app', 'L'],
        ['"web"', 'S'],
        ['json', 'K'],
        ['line_format', 'K'],
        ['"{{.msg}}"', 'S'],
      ],
    ],
    [
      'H3',
      'sum by (pod) (count_over_time({a="b"}[5m]))',
      [
        ['sum', 'F'],
        ['by', 'K'],
        ['pod', 'L'],
        ['count_over_time', 'F'],
        ['a', 'L'],
        ['"b"', 'S'],
        ['5m', 'N'],
      ],
    ],
    [
      'H4',
      '{a="b"} # note',
      [
        ['a', 'L'],
        ['"b"', 'S'],
        ['# note', 'C'],
      ],
    ],
    [
      'H5',
      '{a=`x\ny`}',
      [
        ['a', 'L'],
        ['`x', 'S'],
        ['y`', 'S'],
      ],
    ],
    [
      'H6',
      '{json="1"} | json',
      [
        ['json', 'L'],
        ['"1"', 'S'],
        ['json', 'K'],
      ],
    ],
    [
      'H7',
      '{a="b"} $',
      [
        ['a', 'L'],
        ['"b"', 'S'],
        ['$', 'X'],
      ],
    ],
  ];
  for (const [name, doc, expected] of rows) {
    it(name, () => {
      expect(pairs(doc)).toEqual(expected);
    });
  }
});
