/** The run diagnostics shared by the languages (plan #66 Part A §3.8). Stub: not moved yet. */
import type { Diagnostic } from './types';

export function utf8ToIndex(_s: string, _byte: number): number | null {
  throw new Error('not implemented');
}

export function positionDiagnostics(
  _text: string,
  _error: unknown,
  _toSource: (sentIndex: number) => number | null,
  _sent: string,
): Diagnostic[] {
  throw new Error('not implemented');
}
