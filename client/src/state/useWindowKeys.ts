// Stub for the tests-first commit: the implementation follows.
import type { ContextAction } from './contextReducer';

export function isWindowKeyTargetExcluded(target: EventTarget | null): boolean {
  throw new Error('not implemented');
}

export function windowKeyAction(e: KeyboardEvent): ContextAction | null {
  throw new Error('not implemented');
}

export function useWindowKeys(dispatch: (a: ContextAction) => void): void {
  throw new Error('not implemented');
}
