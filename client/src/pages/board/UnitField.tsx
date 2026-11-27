/** Stub (tests first, #290). */
import type { DataPanelSpec } from '../../api/types';

export interface UnitFieldProps {
  readonly vis: DataPanelSpec['vis'];
  readonly rateApplied: boolean;
  readonly errorAt: (suffix: string) => string | null;
  readonly readOnly: boolean;
  readonly onVis: (next: DataPanelSpec['vis']) => void;
}

export function UnitField(_p: UnitFieldProps) {
  return null;
}
