// Stub for the tests-first commit: the implementation follows.
import { type MessageId } from './messages.en-GB';

export type { MessageId };

export function t(id: MessageId, values?: Readonly<Record<string, string | number>>): string {
  throw new Error('not implemented');
}
