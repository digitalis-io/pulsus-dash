/**
 * A board variable's chip and picker (plan #289 §4.4, SRF-017, T08-007): the chip shows the
 * variable's state; its popover lists the values with a search, single or multiple selection,
 * All, custom values and Reset.
 */
import type { BoardVariable } from '../../api/types';
import type { VariableList, VarState } from '../../boards/resolveVariables';
import type { ParamError } from '../../state/boardParams';

export interface VariablePickerProps {
  readonly def: BoardVariable;
  readonly state: VarState;
  /** The variable's value list, sorted; undefined until a query variable can fetch it. */
  readonly list: VariableList | undefined;
  /** The label of a variable by name (the waiting chip names the one it waits for). */
  readonly labelOf: (name: string) => string;
  /** Writes the encoded address values; null removes them (Reset to default). */
  readonly onCommit: (encoded: readonly string[] | null) => ParamError | null;
  readonly onRetry: () => void;
}

export function VariablePicker(_p: VariablePickerProps) {
  return null;
}
