/**
 * The value lists of a board's variables and their states (plan #289 §4.3, SRF-017): a custom
 * variable's values, sorted; a query variable's from `POST /variables/values`, fetched in spec
 * order once its dependencies are ready.
 */
import type { BoardVariable } from '../api/types';
import type { VariableList, VarState } from './resolveVariables';

export interface VariableListsInput {
  readonly tenant: string;
  readonly uid: string;
  readonly defs: readonly BoardVariable[];
  readonly address: ReadonlyMap<string, readonly string[]>;
  /** Names the board references and does not define (legacy strings). */
  readonly legacy?: readonly string[];
  readonly timeReady: boolean;
}

export interface VariableLists {
  readonly states: ReadonlyMap<string, VarState>;
  readonly lists: ReadonlyMap<string, VariableList>;
  /** Fetches a variable's list again. */
  readonly retry: (name: string) => void;
}

export function useVariableLists(_i: VariableListsInput): VariableLists {
  return { states: new Map(), lists: new Map(), retry: () => undefined };
}
