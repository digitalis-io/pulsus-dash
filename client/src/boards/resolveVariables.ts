/**
 * Board variable resolution (plan #289 §4.2, SRF-017): each defined variable's state from its
 * definition, the address and its value list, in spec order; pure.
 */
import type { BoardVariable, VariableSort, VarValue } from '../api/types';

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

export function selectionBytes(_values: readonly string[]): number {
  return 0;
}

export function sortValues(values: readonly string[], _sort: VariableSort | undefined): string[] {
  return [...values];
}

export function resolveVariables(
  _defs: readonly BoardVariable[],
  _address: ReadonlyMap<string, readonly string[]>,
  _lists: ReadonlyMap<string, VariableList>,
  _legacy: readonly string[] = [],
): Map<string, VarState> {
  return new Map();
}
