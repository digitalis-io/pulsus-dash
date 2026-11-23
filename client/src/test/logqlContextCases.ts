/**
 * The caret-context cases of plan #66 Part A, Appendix A.3 (`‸` marks the caret): read by
 * `unit:logql-context` and by `unit:logql-completion` (each context answers in one slot).
 */
import type { LogCaretContext } from '../editor/lang/logql/context';

const name = (from: number, end: number, selector: string | null): LogCaretContext => ({
  kind: 'labelName',
  from,
  end,
  selector,
});
const value = (
  from: number,
  end: number,
  label: string,
  quote: '"' | '`' | null,
  selector: string | null,
  closeQuote = false,
): LogCaretContext => ({ kind: 'labelValue', from, end, label, quote, selector, closeQuote });
const grouping = (from: number, end: number, selector: string | null): LogCaretContext => ({
  kind: 'grouping',
  from,
  end,
  selector,
});
const stage = (from: number, end: number): LogCaretContext => ({ kind: 'stage', from, end });
const fn = (from: number, end: number): LogCaretContext => ({ kind: 'function', from, end });
const duration = (from: number, end: number): LogCaretContext => ({
  kind: 'duration',
  from,
  end,
});
const NONE: LogCaretContext = { kind: 'none' };

export const CONTEXT_ROWS: readonly [string, string, LogCaretContext][] = [
  ['C1', '{‸}', name(1, 1, null)],
  ['C2', '{ap‸}', name(1, 3, null)],
  ['C3', '{app="web", ‸}', name(12, 12, '{app="web"}')],
  ['C4', '{app="‸"}', value(6, 6, 'app', '"', null)],
  ['C5', '{env="prod", app="we‸"}', value(18, 20, 'app', '"', '{env="prod"}')],
  ['C6', '{app=‸}', value(5, 5, 'app', null, null)],
  ['C7', '{app!~"‸', value(7, 7, 'app', '"', null, true)],
  ['C8', '{app=`we‸`}', value(6, 8, 'app', '`', null)],
  ['C9', '{app="web", pod="‸", env="x"}', value(17, 17, 'pod', '"', '{app="web", env="x"}')],
  ['C9b', '{app="web", pod="a‸", env="x"}', value(17, 18, 'pod', '"', '{app="web", env="x"}')],
  ['C10', '{app="web"} | js‸', stage(14, 16)],
  ['C11', '{app="web"} |‸', stage(13, 13)],
  ['C12', '{app="web"} |= "er‸"', NONE],
  ['C13', 'cou‸', fn(0, 3)],
  ['C14', '‸', fn(0, 0)],
  ['C15', 'sum(‸', fn(4, 4)],
  ['C16', 'rate({a="b"}[‸', duration(13, 13)],
  ['C17', 'rate({a="b"}[5‸', duration(13, 14)],
  ['C18', 'sum by (‸) (count_over_time({a="b"}[1m]))', grouping(8, 8, '{a="b"}')],
  ['C19', 'sum by (pod, ‸)', grouping(13, 13, null)],
  ['C20', '{app="web"} # co‸', NONE],
  // LogQL has no comments (#121): the text after a `#` is LogQL.
  ['C20b', '# {ap‸', name(3, 5, null)],
  ['C21', '{app="web"}‸', NONE],
  ['C22', 'count_over_time({app="web"}[5m]) > ‸', fn(35, 35)],
  ['C23', '{app="web"} | json | sta‸', stage(21, 24)],
  ['C24', 'sum(count_over_time({a="b"}[1m])) or ‸', fn(37, 37)],
  ['C25', '{app="web", po‸', name(12, 14, '{app="web"}')],
  ['C26', '{app="w‸rong"}', value(6, 11, 'app', '"', null)],
  ['C27', '{ap‸xx="v"}', name(1, 5, null)],
  ['C28', '{app=w‸x}', value(5, 7, 'app', null, null)],
  ['C29', '{app="web"} | js‸xx', stage(14, 18)],
  ['C30', 'rate({a="b"}[1‸0m])', duration(13, 16)],
  ['C31', 'sum by (po‸x) (count_over_time({a="b"}[1m]))', grouping(8, 11, '{a="b"}')],
  ['C32', 'cou‸nt_x({a="b"}[1m])', fn(0, 7)],
  ['C33', '{app="w‸', value(6, 7, 'app', '"', null, true)],
  ['C34', '{‸app="v"}', name(1, 1, '{app="v"}')],
  ['C35', '{app="w‸rong", pod="x"}', value(6, 11, 'app', '"', '{pod="x"}')],
  ['C36', 'rate({a="b"}[5x‸])', duration(13, 15)],
  ['C37', '{app="w‸rong', value(6, 11, 'app', '"', null, true)],
  ['C38', '{app="w‸rong}', value(6, 11, 'app', '"', null, true)],
  ['C39', '{app="w‸rong, x="1"}', value(6, 11, 'app', '"', null, true)],
  ['C40', '{app="w‸rong" | json', value(6, 11, 'app', '"', null)],
  ['C41', '{app=`w‸rong}', value(6, 11, 'app', '`', null, true)],
  ['C42', '{msg="a b‸c d"}', value(6, 12, 'msg', '"', null)],
  ['C43', '{app="w‸rong, x="', value(6, 11, 'app', '"', null, true)],
  ['C44', '{app="w‸x, y"}', value(6, 11, 'app', '"', null)],
  ['C45', '{app="w‸rong"', value(6, 11, 'app', '"', null)],
  ['C46', '{app="$app", ‸}', name(13, 13, null)],
  ['C47', '{env="prod", app="$a", ‸}', name(23, 23, '{env="prod"}')],
  ['C48', '{app="${x}", pod="‸"}', value(18, 18, 'pod', '"', null)],
  ['C49', '{p="5$", ‸}', name(9, 9, '{p="5$"}')],
];

/** The text without the caret mark, and the caret. */
export function caretOf(marked: string): { text: string; pos: number } {
  const pos = marked.indexOf('‸');
  if (pos < 0) throw new Error(`no caret in ${marked}`);
  return { text: marked.slice(0, pos) + marked.slice(pos + 1), pos };
}
