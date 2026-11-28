/** unit:variable-query (plan #289 §3.3): the cases of server/internal/varquery's Go test (Go = TS). */
import { describe, expect, it } from 'vitest';
import { parseVariableQuery } from './variableQuery';

const long = 'l'.repeat(256);
const CASES: readonly (readonly [string, string, { label: string; selector: string } | null])[] = [
  ['promql', 'label_values(instance)', { label: 'instance', selector: '' }],
  [
    'promql',
    'label_values(up{job="a,b"}, instance)',
    { label: 'instance', selector: 'up{job="a,b"}' },
  ],
  ['logql', 'label_values({app="x"},pod)', { label: 'pod', selector: '{app="x"}' }],
  ['promql', 'values(x)', null],
  ['promql', 'label_values(up,)', null],
  ['promql', 'label_values(up, 9x)', null],
  ['promql', ' \tlabel_values ( up , instance ) \n', { label: 'instance', selector: 'up' }],
  ['promql', "label_values(up{a='x,y'}, b)", { label: 'b', selector: "up{a='x,y'}" }],
  ['promql', 'label_values(up{a=`x,y`}, b)', { label: 'b', selector: 'up{a=`x,y`}' }],
  ['promql', 'label_values(up{a="x\\",y"}, b)', { label: 'b', selector: 'up{a="x\\",y"}' }],
  ['promql', 'label_values(up{a="1",b="2"}, c)', { label: 'c', selector: 'up{a="1",b="2"}' }],
  ['promql', `label_values(${long})`, { label: long, selector: '' }],
  ['promql', `label_values(${long}l)`, null],
  ['promql', 'label_values()', null],
  ['promql', 'label_values(, a)', null],
  ['promql', 'label_values(a', null],
  ['promql', 'label_values(a))', null],
  ['promql', 'label_values(a) x', null],
  ['promql', 'label_valuesx(a)', null],
  ['promql', 'label_values(a.b)', null],
  ['promql', '', null],
  ['traceql', 'label_values(a)', null],
];

describe('unit:variable-query', () => {
  for (const [lang, text, want] of CASES) {
    it(JSON.stringify(text).slice(0, 60), () => {
      expect(parseVariableQuery(lang, text)).toEqual(want);
    });
  }
});
