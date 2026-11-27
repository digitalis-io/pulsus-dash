/**
 * Board variable resolution (plan #289 §4.2, SRF-017): each defined variable's state from its
 * definition, the address and its value list, in spec order; pure. The address is over the saved
 * default, the default over the first listed value; All is sent as its regex and never expanded;
 * a selection over 200 values or 65 536 bytes is sent by no request.
 */
import type { BoardVariable, VariableSort, VarValue } from '../api/types';
import { t } from '../i18n/t';
import { decodeValue } from '../state/boardParams';
import { referencedVariables } from './variableRefs';

/** The values a variable has selected: All, or literals in order. */
export type Selection = { readonly all: true } | { readonly values: readonly string[] };

export type VarState =
  | {
      readonly kind: 'ready';
      readonly value: VarValue;
      readonly display: string;
      readonly selection: Selection;
    }
  | { readonly kind: 'loading' }
  | { readonly kind: 'waiting'; readonly on: string }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'tooMany'; readonly selection: Selection }
  | { readonly kind: 'unset' };

/** A query variable's value list (`useVariableLists`). */
export type VariableList =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'ready'; readonly values: readonly string[]; readonly truncated: boolean };

export const MAX_SELECTION_VALUES = 200;
export const MAX_SELECTION_BYTES = 65_536;

const encoder = new TextEncoder();

/** UTF-8 bytes of `values` as a JSON array (the server's `vars.SelectionBytes`). */
export function selectionBytes(values: readonly string[]): number {
  return encoder.encode(JSON.stringify(values)).length;
}

/** Whether a selection of `values` can be sent (at most 200 values and 65 536 bytes). */
export function fitsSelection(values: readonly string[]): boolean {
  return values.length <= MAX_SELECTION_VALUES && selectionBytes(values) <= MAX_SELECTION_BYTES;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `values` in the variable's order: `alpha*` by UTF-16 code units; `num*` by `Number()`, with
 * the values that are not numbers last in code-unit order; `none` (or absent) as served.
 */
export function sortValues(values: readonly string[], sort: VariableSort | undefined): string[] {
  const out = [...values];
  switch (sort) {
    case 'alphaAsc':
      return out.sort(byCodeUnits);
    case 'alphaDesc':
      return out.sort((a, b) => byCodeUnits(b, a));
    case 'numAsc':
    case 'numDesc': {
      const sign = sort === 'numAsc' ? 1 : -1;
      const num = (s: string): number | null => {
        const n = Number(s);
        return s.trim() === '' || Number.isNaN(n) ? null : n;
      };
      return out.sort((a, b) => {
        const x = num(a);
        const y = num(b);
        if (x !== null && y !== null) return x === y ? byCodeUnits(a, b) : sign * (x - y);
        if (x !== null) return -1;
        if (y !== null) return 1;
        return byCodeUnits(a, b);
      });
    }
    default:
      return out;
  }
}

/** A selection as the chip shows it: the value, `first +N` or "All". */
export function displayOf(s: Selection): string {
  if ('all' in s) return t('variables.all');
  const [first, ...rest] = s.values;
  return rest.length === 0 ? (first ?? '') : `${first ?? ''} +${String(rest.length)}`;
}

/** A variable's All regex: `allValue`, or `.*`. */
export const allValueOf = (def: BoardVariable): string => def.allValue ?? '.*';

/**
 * The selection of `raw` (address or default values, encoded): All when `$__all` is among them and
 * the variable includes All (a token without `includeAll` is dropped), else the literals; null when
 * none is left.
 */
function selectionOf(def: BoardVariable, raw: readonly string[] | undefined): Selection | null {
  if (raw === undefined || raw.length === 0) return null;
  const literals: string[] = [];
  let all = false;
  for (const r of raw) {
    const d = decodeValue(r);
    if ('all' in d) all = all || def.includeAll === true;
    else if (!literals.includes(d.value)) literals.push(d.value);
  }
  if (all) return { all: true };
  if (literals.length === 0) return null;
  return { values: def.multi === true ? literals : literals.slice(0, 1) };
}

/** The list of a custom variable: its values in its order. */
export function customList(def: BoardVariable): VariableList {
  return { status: 'ready', values: sortValues(def.values ?? [], def.sort), truncated: false };
}

/**
 * Step 0 of §4.2: a query variable waits for the first earlier variable its query references that
 * is waiting, failed, too large or unset, and loads while one is loading; null when none blocks.
 */
export function dependencyBlock(
  def: BoardVariable,
  earlier: ReadonlyMap<string, VarState>,
): VarState | null {
  if (def.kind !== 'query') return null;
  let loading = false;
  for (const n of referencedVariables(def.query?.text ?? '')) {
    const s = earlier.get(n);
    if (s === undefined || n === def.name) continue;
    if (s.kind === 'waiting' || s.kind === 'failed' || s.kind === 'tooMany' || s.kind === 'unset') {
      return { kind: 'waiting', on: n };
    }
    if (s.kind === 'loading') loading = true;
  }
  return loading ? { kind: 'loading' } : null;
}

function resolveOne(
  def: BoardVariable,
  earlier: ReadonlyMap<string, VarState>,
  address: ReadonlyMap<string, readonly string[]>,
  list: VariableList | undefined,
): VarState {
  if (def.kind === 'constant') {
    const v = def.values?.[0] ?? '';
    return ready({ values: [v] }, def);
  }
  const blocked = dependencyBlock(def, earlier);
  if (blocked !== null) return blocked;
  // Step 1: the address over the saved default, else the first listed value.
  const chosen = selectionOf(def, address.get(def.name)) ?? selectionOf(def, def.default);
  if (chosen !== null) return ready(chosen, def);
  const l = def.kind === 'custom' ? customList(def) : list;
  if (l === undefined || l.status === 'loading') return { kind: 'loading' };
  if (l.status === 'failed') return { kind: 'failed', error: l.error };
  const first = def.kind === 'custom' ? l.values[0] : sortValues(l.values, def.sort)[0];
  return first === undefined ? { kind: 'unset' } : ready({ values: [first] }, def);
}

/** Steps 2 and 3: All as its regex, the literals as a VarMulti within the cap. */
function ready(s: Selection, def: BoardVariable): VarState {
  if ('all' in s) {
    return { kind: 'ready', value: { all: allValueOf(def) }, display: displayOf(s), selection: s };
  }
  if (!fitsSelection(s.values)) return { kind: 'tooMany', selection: s };
  return { kind: 'ready', value: { values: s.values }, display: displayOf(s), selection: s };
}

/**
 * Every variable's state, in spec order, then each name in `legacy` (referenced, not defined): the
 * first raw address value as a plain string, else unset.
 */
export function resolveVariables(
  defs: readonly BoardVariable[],
  address: ReadonlyMap<string, readonly string[]>,
  lists: ReadonlyMap<string, VariableList>,
  legacy: readonly string[] = [],
): Map<string, VarState> {
  // The names the board does not define first: a variable query may reference them.
  const defined = new Set(defs.map((d) => d.name));
  const out = new Map<string, VarState>();
  for (const name of legacy) {
    if (defined.has(name)) continue;
    const v = address.get(name)?.[0];
    out.set(
      name,
      v === undefined
        ? { kind: 'unset' }
        : { kind: 'ready', value: v, display: v, selection: { values: [v] } },
    );
  }
  for (const def of defs) out.set(def.name, resolveOne(def, out, address, lists.get(def.name)));
  return out;
}
