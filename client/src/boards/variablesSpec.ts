/**
 * Board spec v9's variables on the client (plan #289 §3.1, §3.2): the rules of the server's
 * `spec/variables.go`, in its order and pointer format (`unit:board-spec`, TS = Go).
 */
import type { BoardVariable } from '../api/types';
import { MAX_SELECTION_BYTES, selectionBytes } from './resolveVariables';
import { parseVariableQuery } from './variableQuery';
import { referencedVariables, VARIABLE_NAME } from './variableRefs';

export const MAX_VARIABLES = 32;
const MAX_LABEL = 100;
const MAX_VALUES = 200;
const MAX_VALUE = 200;
const MAX_QUERY_BYTES = 4096;
const MAX_ALL_BYTES = 4096;
const ALL = '$__all';
const KINDS = ['query', 'custom', 'constant'];
const SORTS = ['none', 'alphaAsc', 'alphaDesc', 'numAsc', 'numDesc'];
const REFRESH = ['load', 'timeChange'];
const LANGS = ['promql', 'logql'];

const encoder = new TextEncoder();
const runes = (s: string): number => Array.from(s).length;
const bytes = (s: string): number => encoder.encode(s).length;
const nul = (s: string): boolean => s.includes('\u0000');

/** 1 to 200 entries, each 1 to 200 code points, no NUL. */
function listValid(es: readonly string[]): boolean {
  return (
    es.length >= 1 &&
    es.length <= MAX_VALUES &&
    es.every((e) => runes(e) >= 1 && runes(e) <= MAX_VALUE && !nul(e))
  );
}

type Add = (pointer: string, key: string) => void;
type Str = (pointer: string, s: string, rule: (s: string) => string | null) => void;

type OptionalKey =
  'query' | 'values' | 'multi' | 'includeAll' | 'allValue' | 'default' | 'sort' | 'refresh';

const RULES: Readonly<
  Record<
    string,
    { readonly required: readonly OptionalKey[]; readonly forbidden: readonly OptionalKey[] }
  >
> = {
  query: { required: ['query', 'multi', 'includeAll', 'sort', 'refresh'], forbidden: ['values'] },
  custom: { required: ['values', 'multi', 'includeAll', 'sort'], forbidden: ['query', 'refresh'] },
  constant: {
    required: ['values'],
    forbidden: ['query', 'multi', 'includeAll', 'allValue', 'default', 'sort', 'refresh'],
  },
};

function checkDefault(add: Add, p: string, x: BoardVariable): void {
  const invalid = (): void => {
    add(`${p}/default`, 'board.variable.default.invalid');
  };
  const d = x.default ?? [];
  if (!listValid(d)) {
    invalid();
    return;
  }
  const decoded: string[] = [];
  let all = false;
  for (const e of d) {
    if (e === ALL) {
      if (all || x.includeAll !== true) {
        invalid();
        return;
      }
      all = true;
      continue;
    }
    const v = e.startsWith('$') ? e.slice(1) : e;
    if (v === '' || decoded.includes(v) || (x.kind === 'custom' && !(x.values ?? []).includes(v))) {
      invalid();
      return;
    }
    decoded.push(v);
  }
  if ((all && decoded.length > 0) || (x.multi !== true && d.length > 1)) {
    invalid();
    return;
  }
  if (x.multi === true && selectionBytes(decoded) > MAX_SELECTION_BYTES) {
    add(`${p}/default`, 'board.variable.default.tooLarge');
  }
}

function checkVariable(
  add: Add,
  str: Str,
  p: string,
  x: BoardVariable,
  earlier: readonly BoardVariable[],
  later: readonly BoardVariable[],
): void {
  if (!VARIABLE_NAME.test(x.name) || x.name.startsWith('__')) {
    add(`${p}/name`, 'board.variable.name.invalid');
  } else if (earlier.some((e) => e.name === x.name)) {
    add(`${p}/name`, 'board.variable.name.duplicate');
  }
  str(`${p}/label`, x.label, (s) => (runes(s) > MAX_LABEL ? 'board.variable.label.tooLong' : null));
  const rules = RULES[x.kind];
  if (!KINDS.includes(x.kind) || rules === undefined) {
    add(`${p}/kind`, 'board.variable.kind.invalid');
    return;
  }
  const present = (k: OptionalKey): boolean => x[k] !== undefined;
  for (const k of rules.required) if (!present(k)) add(p, `board.variable.${k}.required`);
  for (const k of rules.forbidden)
    if (present(k)) add(`${p}/${k}`, `board.variable.${k}.forbidden`);
  const constant = x.kind === 'constant';
  if (x.allValue !== undefined && !constant) {
    if (x.includeAll !== true) add(`${p}/allValue`, 'board.variable.allValue.forbidden');
    else if (x.allValue === '' || bytes(x.allValue) > MAX_ALL_BYTES || nul(x.allValue)) {
      add(`${p}/allValue`, 'board.variable.allValue.invalid');
    }
  }
  if (x.values !== undefined && x.kind !== 'query') {
    const vs = x.values;
    const dup = vs.some((e, i) => vs.slice(0, i).includes(e));
    if (!listValid(vs) || dup || (constant && vs.length !== 1)) {
      add(`${p}/values`, 'board.variable.values.invalid');
    }
  }
  if (x.query !== undefined && x.kind === 'query') {
    const q = x.query;
    if (
      !LANGS.includes(q.lang) ||
      bytes(q.text) > MAX_QUERY_BYTES ||
      nul(q.text) ||
      parseVariableQuery(q.lang, q.text) === null
    ) {
      add(`${p}/query`, 'board.variable.query.invalid');
    } else if (
      referencedVariables(q.text).some((n) => n === x.name || later.some((l) => l.name === n))
    ) {
      add(`${p}/query`, 'board.variable.query.order');
    }
  }
  if (x.sort !== undefined && !constant && !SORTS.includes(x.sort)) {
    add(`${p}/sort`, 'board.variable.sort.invalid');
  }
  if (x.refresh !== undefined && x.kind === 'query' && !REFRESH.includes(x.refresh)) {
    add(`${p}/refresh`, 'board.variable.refresh.invalid');
  }
  if (x.default !== undefined && !constant) checkDefault(add, p, x);
}

/** The variables' rules (`validate.go` `variables`): the count, then each variable in order. */
export function checkVariables(add: Add, str: Str, vs: readonly BoardVariable[]): void {
  if (vs.length > MAX_VARIABLES) {
    add('/variables', 'board.variables.tooMany');
    return;
  }
  vs.forEach((x, i) => {
    checkVariable(add, str, `/variables/${String(i)}`, x, vs.slice(0, i), vs.slice(i + 1));
  });
}
