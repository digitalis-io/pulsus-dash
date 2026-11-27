/**
 * The text of a field error (plan #61 Part B §3.5, Appendix B-A §A.3): `message_key` → the
 * catalogue id `field.<key>` (T08-027). Unknown keys fall back to the generic "could not be read".
 * A save's errors read through `saveFieldMessage` (an older server's geomap, tags or units refusal).
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
  if (geomapUnsupported(spec, f)) return t('board.save.geomapUnsupported');
  if (tagsUnsupported(f)) return t('board.save.tagsUnsupported');
  if (unitsUnsupported(f)) return t('board.save.unitsUnsupported');
  return fieldMessage(f.messageKey);
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

/**
 * Whether `f` is an older server's refusal of board tags (plan #216 Part 2b §3.2; T24-029): a
 * server before the tags version answers `board.json.unknownKey` at `/tags`, shown as "This server
 * does not accept board tags yet".
 */
export function tagsUnsupported(f: FieldError): boolean {
  return f.pointer === '/tags' && f.messageKey === 'board.json.unknownKey';
}

const UNIT_POINTER = /^(?:\/sections\/\d+)?\/panels\/\d+\/vis\/unit$/;

/**
 * Whether `f` is an older server's refusal of a panel unit (#290 §4.4): a server before the units
 * version answers `board.json.unknownKey` at a panel's `…/vis/unit`, shown as "This server does not
 * support panel units yet". (A units-version server refuses a unit only on a widget, which the
 * client's own check blocks before the save.)
 */
export function unitsUnsupported(f: FieldError): boolean {
  return f.messageKey === 'board.json.unknownKey' && UNIT_POINTER.test(f.pointer);
}
