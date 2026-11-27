/**
 * The text of a field error (plan #61 Part B §3.5, Appendix B-A §A.3): `message_key` → the
 * catalogue id `field.<key>` (T08-027). Unknown keys fall back to the generic "could not be read".
 * A save's errors read through `saveFieldMessage` (the old server's geomap refusal).
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

const KIND_POINTER = /^(?:\/sections\/(\d+))?\/panels\/(\d+)\/vis\/kind$/;

/**
 * The text of a save's field error on `spec` (plan #234 Part 1 §4.5): a server older than board spec
 * v7 refuses a geomap panel with `board.vis.kind.invalid` at its `/vis/kind`, shown as "This server
 * does not support map panels yet"; every other error keeps its own text (a v7 server never reports
 * the geomap as an invalid kind).
 */
export function saveFieldMessage(spec: BoardSpec, f: FieldError): string {
  return geomapUnsupported(spec, f)
    ? t('board.save.geomapUnsupported')
    : fieldMessage(f.messageKey);
}

/**
 * The text of the panel editor's `…/vis/kind` error for a panel of `kind` (§4.5): an older
 * server's `board.vis.kind.invalid` on a geomap reads as the unsupported-kind text, as on the board.
 */
export function kindFieldMessage(kind: string, messageKey: string): string {
  return kind === 'geomap' && messageKey === 'board.vis.kind.invalid'
    ? t('board.save.geomapUnsupported')
    : fieldMessage(messageKey);
}

/** Whether `f` is an older server's refusal of a geomap panel of `spec` (§4.5). */
export function geomapUnsupported(spec: BoardSpec, f: FieldError): boolean {
  const m = f.messageKey === 'board.vis.kind.invalid' ? KIND_POINTER.exec(f.pointer) : null;
  if (m === null) return false;
  const panels = m[1] === undefined ? spec.panels : spec.sections[Number(m[1])]?.panels;
  return panels?.[Number(m[2])]?.vis.kind === 'geomap';
}

/** Stub (tests first, plan #216 Part 2b §3.2). */
export function tagsUnsupported(_f: FieldError): boolean {
  return false;
}
