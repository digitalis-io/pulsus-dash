/**
 * The Inspector sheet (T25-003, T25-008, T25-013, T25-015; plan #192 §4.4).
 */
import type { InspectorModel } from './types';

export interface InspectorProps {
  readonly model: InspectorModel | null;
}

export function Inspector(p: InspectorProps) {
  void p;
  return null;
}
