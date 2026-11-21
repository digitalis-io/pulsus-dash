import type { CompletionSource } from '@codemirror/autocomplete';
import { StateField, type Extension } from '@codemirror/state';
import type { Command } from '@codemirror/view';

export const overLimitField: StateField<boolean> = StateField.define<boolean>({
  create: () => false,
  update: (v) => v,
});
export interface CompletionGuard {
  readonly extension: Extension;
  source(inner: CompletionSource): CompletionSource;
  whenFree(cmd: Command): Command;
}
export function completionGuard(): CompletionGuard {
  throw new Error('not implemented');
}
