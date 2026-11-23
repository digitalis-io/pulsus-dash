import { CompletionContext } from '@codemirror/autocomplete';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { newCompleteStrategy, PromQLExtension } from '@prometheus-io/codemirror-promql';
import {
  QuotedLabelMatcher,
  StringLiteral,
  UnquotedLabelMatcher,
} from '@prometheus-io/lezer-promql';
import { describe, expect, it } from 'vitest';
import { replaceRange } from './replace';

// Plan #107 §5.1, `unit:promql-replace` range rows and package parity.

/** A fully parsed PromQL state on `text`. */
function stateOf(text: string): EditorState {
  const state = EditorState.create({
    doc: text,
    extensions: [
      new PromQLExtension().activateLinter(false).activateCompletion(false).asExtension(),
    ],
  });
  ensureSyntaxTree(state, text.length, 1000);
  return state;
}

/** `marked` without its `‸`, and the caret's index. */
function caretOf(marked: string): { text: string; pos: number } {
  const pos = marked.indexOf('‸');
  if (pos < 0) throw new Error(`no caret in ${marked}`);
  return { text: marked.slice(0, pos) + marked.slice(pos + 1), pos };
}

describe('unit:promql-replace (range)', () => {
  const rows: [string, string, number, '' | '"' | "'" | '`'][] = [
    ['E1', '{app="w‸rong"}', 11, ''],
    ['E2', 'up{app="w‸rong', 13, '"'],
    ['E3', 'up{app="w‸rong}', 13, '"'],
    ['E4', 'up{app="w‸rong, x="1"}', 13, '"'],
    ['E5', 'up{app="w‸rong"', 13, ''],
    ['E6', 'up{app=`w‸rong`}', 13, ''],
    ['E7', 'up{ap‸xx="v"}', 7, ''],
    ['E8', 'htt‸p_requests_tot{job="a"}', 17, ''],
    ['E9', 'sum by (‸', 8, ''],
    ['E10', 'up{‸}', 3, ''],
    ['E11', 'rate(up[5‸', 9, ''],
    ['E12', 'up{app="w‸x, y"}', 13, ''],
    ['E13', 'up{app="w‸x\\"z', 13, '"'],
    ['E14', 'up{app="w‸x\\"}', 12, '"'],
    ['E15', 'up{app="w‸x\\\\"}', 12, ''],
    ['E16', 'up{app="w‸x\\', 11, '"'],
    ['E17', "up{app='w‸x\\'z", 13, "'"],
    ['E18', 'up{app="w\\‸"z', 12, '"'],
  ];
  for (const [id, marked, end, suffix] of rows) {
    it(`${id}: ${marked}`, () => {
      const { text, pos } = caretOf(marked);
      expect(replaceRange(stateOf(text), pos)).toEqual({ end, suffix });
    });
  }
});

const CORPUS = [
  'sum(rate(http_requests_total{job="api",code=~"5.."}[5m])) by (job)',
  'up{job="a"} offset 5m',
  'histogram_quantile(0.9, sum by (le) (rate(x_bucket[5m])))',
  'up{"service.name"="api",job=`b`}',
  'rate(up[1h:5m])',
  "up{a='x'} and on(job) down",
  'topk(5, up) @ end()',
  'up{',
  'sum(',
  'up{job="',
  'up{job="a',
  '{"my.metric",job="x"}',
  'up == bool 1',
  'max without (pod) (up)',
  'rate(up[5m] offset -1d)',
];

/** True where §3.4 row 5 applies: a label value that is not well closed. */
function notWellClosedValue(state: EditorState, pos: number): boolean {
  const n = syntaxTree(state).resolve(pos, -1);
  const parent = n.parent?.type.id;
  if (n.type.id !== StringLiteral) return false;
  if (parent !== UnquotedLabelMatcher && parent !== QuotedLabelMatcher) return false;
  const doc = state.doc.toString();
  const s = doc.slice(n.from, n.to);
  const q = s[0] ?? '';
  let closed = s.length >= 2 && s.endsWith(q);
  if (closed && q !== '`') {
    let k = 0;
    for (let i = n.to - 2; i > n.from && doc[i] === '\\'; i--) k++;
    closed = k % 2 === 0;
  }
  const next = /^\s*(.?)/.exec(doc.slice(n.to))?.[1] ?? '';
  return !(closed && (next === '}' || next === ','));
}

describe('unit:promql-replace (parity)', () => {
  it('P: equals the package end rule wherever row 5 does not apply', async () => {
    const strategy = newCompleteStrategy();
    const mismatches: string[] = [];
    let checked = 0;
    for (const text of CORPUS) {
      const state = stateOf(text);
      for (let pos = 0; pos <= text.length; pos++) {
        if (notWellClosedValue(state, pos)) continue;
        const r = await strategy.promQL(new CompletionContext(state, pos, true));
        if (r === null) continue;
        checked++;
        const want = Math.max(r.to ?? pos, pos);
        const got = replaceRange(state, pos).end;
        if (got !== want)
          mismatches.push(`${text} @${String(pos)}: ${String(got)} ≠ ${String(want)}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(300);
  });
});
