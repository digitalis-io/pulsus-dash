/** Stub (tests first, plan #63 Part C §3.2). */
import type { Diagnostic } from '../editor/lang/types';
import type { Refusal, RunOutcome } from './useExploreRun';

export interface ErrorView {
  readonly text: string;
  readonly narrow: boolean;
}
export function errorView(_error: unknown, _diagnostics: readonly Diagnostic[]): ErrorView | null {
  throw new Error('not implemented');
}
export function outcomeText(_o: RunOutcome): string {
  throw new Error('not implemented');
}
export function refusalText(_r: Refusal): string {
  throw new Error('not implemented');
}
