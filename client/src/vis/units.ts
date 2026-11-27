/** Stub (tests first, #290). */
import type { VisKind } from '../engine/api';
import type { Unit } from '../i18n/format';
import type { MessageId } from '../i18n/t';

export const UNIT_IDS = [
  'count',
  'none',
  'custom',
  'seconds',
  'milliseconds',
  'microseconds',
  'nanoseconds',
  'bytes',
  'bytesSI',
  'bits',
  'bitsIEC',
  'perSecond',
  'reqPerSecond',
  'bytesPerSecond',
  'bytesSIPerSecond',
  'bitsPerSecond',
  'bitsIECPerSecond',
  'percent',
  'percentUnit',
] as const;
export type UnitId = (typeof UNIT_IDS)[number];
export type UnitGroup = 'general' | 'time' | 'data' | 'rate' | 'percent';
export interface UnitEntry {
  readonly id: UnitId;
  readonly group: UnitGroup;
  readonly label: MessageId;
  readonly example: number | null;
  readonly unit: Unit | null;
}
export const UNIT_CATALOGUE: readonly UnitEntry[] = [];
export type PanelUnit = { readonly id: string; readonly suffix?: string };
export function unitOf(_p: PanelUnit): Unit {
  return { kind: 'none' };
}
export function rated(u: Unit): Unit {
  return u;
}
export interface PanelUnits {
  readonly value: Unit;
  readonly count: Unit;
}
export function panelUnits(
  _vis: { readonly unit?: PanelUnit } | undefined,
  _kind: VisKind,
  _rateApplied: boolean,
): PanelUnits {
  return { value: { kind: 'none' }, count: { kind: 'none' } };
}
