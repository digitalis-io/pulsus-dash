/**
 * The board's URL parameters (plan #61 Part C §3.6, Appendix C-A §A.8; IA-022, ADR-0017; repeated
 * values and the `$` escape by plan #289 §4.1): the values of each
 * variable (`var-<name>`), the `+ Filter` filters (repeated `f=<label>=<value>`) and View-mode
 * overrides of a section's saved collapsed state (repeated `collapse=<id>` / `expand=<id>`). None is
 * saved in the spec. They live in the Context's `rest` pairs; readers ignore invalid pairs (they stay
 * in `rest` until the next write of that kind) and writers emit canonical, sorted pairs.
 *
 * Every in-app write is held to one request-target budget: the board link's path and search stay
 * within `MAX_REQUEST_TARGET` bytes, with room kept for every section override the board could
 * ever add and for Copy link's absolute `from`/`to`.
 */
import { VARIABLE_NAME } from '../boards/variables';
import { contextSearchString, type ContextSearch, type SearchParamPair } from './contextSearch';

export const VAR_PREFIX = 'var-';
export const FILTER_PARAM = 'f';
export const COLLAPSE_PARAM = 'collapse';
export const EXPAND_PARAM = 'expand';
export const MAX_FILTERS = 20;
/** Unicode code points (`[...v].length`). */
export const MAX_PARAM_VALUE = 200;
/** Bytes of pathname + search (ASCII once encoded): half the smallest common proxy limit (8 KiB). */
export const MAX_REQUEST_TARGET = 4096;
/** Copy link's absolute from/to: at most 2 × 27 bytes longer than the shortest relative form. */
export const SHARE_RESERVE = 96;
export const FILTER_LABEL = /^[A-Za-z_][A-Za-z0-9_.]{0,99}$/;
/** `spec.ts` ID_PATTERN. */
export const SECTION_ID = /^[a-z0-9-]{1,40}$/;

export interface BoardFilter {
  readonly key: string;
  readonly value: string;
}
export interface SectionOverrides {
  readonly collapse: ReadonlySet<string>;
  readonly expand: ReadonlySet<string>;
}
export interface BoardParams {
  /**
   * Each variable's valid address values, distinct, in address order: a defined variable's
   * canonically encoded (§4.1), an undefined one's raw.
   */
  readonly vars: ReadonlyMap<string, readonly string[]>;
  readonly filters: readonly BoardFilter[];
  readonly sections: SectionOverrides;
}
/** Each is a message id. */
export type ParamError =
  | 'filter.keyInvalid'
  | 'filter.valueRequired'
  | 'filter.valueTooLong'
  | 'filter.tooMany'
  | 'url.tooLong';

const COLLAPSE_LEN = `&${COLLAPSE_PARAM}=`.length;

function codePoints(v: string): number {
  return Array.from(v).length;
}

function validValue(v: string): boolean {
  const n = codePoints(v);
  return n >= 1 && n <= MAX_PARAM_VALUE;
}

/** Stable sort by key, UTF-16 code units (as `readContextSearch` sorts `rest`). */
function sorted(pairs: SearchParamPair[]): SearchParamPair[] {
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** `f`'s value split at the first `=`. */
function splitFilter(v: string): BoardFilter | null {
  const i = v.indexOf('=');
  return i === -1 ? null : { key: v.slice(0, i), value: v.slice(i + 1) };
}

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * The board's parameters. `defined` names the board's defined variables (spec v9, plan #289
 * §4.1): their values are read with the `$` escape and kept canonically encoded; any other
 * variable's values are read raw, as before.
 */
export function readBoardParams(
  rest: readonly SearchParamPair[],
  defined: ReadonlySet<string> = NO_NAMES,
): BoardParams {
  const vars = new Map<string, string[]>();
  const filters: BoardFilter[] = [];
  const collapse = new Set<string>();
  const expand = new Set<string>();
  for (const [k, v] of rest) {
    if (k.startsWith(VAR_PREFIX)) {
      const name = k.slice(VAR_PREFIX.length);
      if (!VARIABLE_NAME.test(name)) continue;
      const value = defined.has(name) ? canonical(v) : validValue(v) ? v : null;
      if (value === null) continue;
      const list = vars.get(name);
      if (list === undefined) vars.set(name, [value]);
      else if (!list.includes(value)) list.push(value);
    } else if (k === FILTER_PARAM) {
      const f = splitFilter(v);
      if (
        f !== null &&
        FILTER_LABEL.test(f.key) &&
        validValue(f.value) &&
        filters.length < MAX_FILTERS &&
        !filters.some((x) => x.key === f.key)
      ) {
        filters.push(f);
      }
    } else if ((k === COLLAPSE_PARAM || k === EXPAND_PARAM) && SECTION_ID.test(v)) {
      (k === COLLAPSE_PARAM ? collapse : expand).add(v);
    }
  }
  // An id in both sets says nothing: the saved state applies.
  for (const id of [...collapse]) {
    if (expand.has(id)) {
      collapse.delete(id);
      expand.delete(id);
    }
  }
  return { vars, filters, sections: { collapse, expand } };
}

/** The address value of All (plan #289 §4.1). */
export const ALL_TOKEN = '$__all';

/** A decoded address or default value of a defined variable: All or a literal. */
export type DecodedValue = { readonly all: true } | { readonly value: string };

/**
 * A defined variable's value as the address writes it (§4.1): `$__all` is All; any other value
 * starting with `$` has one leading `$` stripped.
 */
export function decodeValue(raw: string): DecodedValue {
  if (raw === ALL_TOKEN) return { all: true };
  return { value: raw.startsWith('$') ? raw.slice(1) : raw };
}

/** A literal as the address writes it: one more `$` when it starts with `$`. */
export function encodeValue(literal: string): string {
  return literal.startsWith('$') ? '$' + literal : literal;
}

/** The canonical address form of a defined variable's raw value, or null when it is not valid. */
function canonical(raw: string): string | null {
  const d = decodeValue(raw);
  if ('all' in d) return ALL_TOKEN;
  return validValue(d.value) ? encodeValue(d.value) : null;
}

/** `rest` with `values` (encoded) as the `var-<name>` pairs, in order; null removes them. */
export function withVarValues(
  rest: readonly SearchParamPair[],
  name: string,
  values: readonly string[] | null,
): SearchParamPair[] {
  const key = VAR_PREFIX + name;
  const out: SearchParamPair[] = rest.filter(([k]) => k !== key);
  for (const v of values ?? []) out.push([key, v]);
  return sorted(out);
}

export function withVar(
  rest: readonly SearchParamPair[],
  name: string,
  value: string | null,
): SearchParamPair[] {
  const key = VAR_PREFIX + name;
  const out: SearchParamPair[] = rest.filter(([k]) => k !== key);
  if (value !== null) out.push([key, value]);
  return sorted(out);
}

export function withFilter(
  rest: readonly SearchParamPair[],
  key: string,
  value: string | null,
): SearchParamPair[] {
  const filters = [...readBoardParams(rest).filters];
  const i = filters.findIndex((f) => f.key === key);
  if (value === null) {
    if (i !== -1) filters.splice(i, 1);
  } else if (i === -1) {
    filters.push({ key, value });
  } else {
    filters[i] = { key, value };
  }
  return sorted([
    ...rest.filter(([k]) => k !== FILTER_PARAM),
    ...filters.map((f): SearchParamPair => [FILTER_PARAM, `${f.key}=${f.value}`]),
  ]);
}

/** `collapsed` null removes the override; overrides for ids not in `sectionIds` are dropped. */
export function withSectionOverride(
  rest: readonly SearchParamPair[],
  id: string,
  collapsed: boolean | null,
  sectionIds: readonly string[],
): SearchParamPair[] {
  const { collapse: c, expand: e } = readBoardParams(rest).sections;
  const collapse = new Set(c);
  const expand = new Set(e);
  collapse.delete(id);
  expand.delete(id);
  if (collapsed === true) collapse.add(id);
  if (collapsed === false) expand.add(id);
  const out = withoutSectionOverrides(rest);
  for (const sid of sectionIds) {
    if (collapse.has(sid)) out.push([COLLAPSE_PARAM, sid]);
    else if (expand.has(sid)) out.push([EXPAND_PARAM, sid]);
  }
  return sorted(out);
}

export function withoutSectionOverrides(rest: readonly SearchParamPair[]): SearchParamPair[] {
  return rest.filter(([k]) => k !== COLLAPSE_PARAM && k !== EXPAND_PARAM);
}

export function checkFilterKey(key: string): ParamError | null {
  return FILTER_LABEL.test(key) ? null : 'filter.keyInvalid';
}

/** The trimmed value: empty → `filter.valueRequired`; over 200 code points → `filter.valueTooLong`. */
export function checkParamValue(value: string): ParamError | null {
  const v = value.trim();
  if (v === '') return 'filter.valueRequired';
  return codePoints(v) > MAX_PARAM_VALUE ? 'filter.valueTooLong' : null;
}

const encoder = new TextEncoder();

/** UTF-8 bytes of `pathname + search`. */
export function requestTargetBytes(pathname: string, search: string): number {
  return encoder.encode(pathname + search).length;
}

/** Σ over ids of `'&collapse='.length + id.length`: the most the overrides can ever add. */
export function overrideReserve(sectionIds: readonly string[]): number {
  return sectionIds.reduce((n, id) => n + COLLAPSE_LEN + id.length, 0);
}

/**
 * `requestTargetBytes(pathname, contextSearchString(context, withoutSectionOverrides(rest)))
 * + overrideReserve(sectionIds) + SHARE_RESERVE ≤ MAX_REQUEST_TARGET`.
 */
export function fitsUrlBudget(
  pathname: string,
  context: ContextSearch,
  rest: readonly SearchParamPair[],
  sectionIds: readonly string[],
): boolean {
  const search = contextSearchString(context, withoutSectionOverrides(rest));
  return (
    requestTargetBytes(pathname, search) + overrideReserve(sectionIds) + SHARE_RESERVE <=
    MAX_REQUEST_TARGET
  );
}
