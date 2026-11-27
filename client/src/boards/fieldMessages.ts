/**
 * The text of a field error (plan #61 Part B §3.5, Appendix B-A §A.3): `message_key` → the
 * catalogue id `field.<key>` (T08-027). Unknown keys fall back to the generic "could not be read".
 */
import type { BoardSpec, FieldError } from '../api/types';
import { messages } from '../i18n/messages.en-GB';
import { t, type MessageId } from '../i18n/t';

function isMessageId(id: string): id is MessageId {
  return Object.hasOwn(messages, id);
}

export function fieldMessage(key: string): string {
  const id = `field.${key}`;
  return t(isMessageId(id) ? id : 'field.board.json.invalid');
}

/** Stub (#234 Part 1, tests first). */
export function saveFieldMessage(spec: BoardSpec, f: FieldError): string {
  void spec;
  return fieldMessage(f.messageKey);
}
