/**
 * The panel units (#290; T22-015, T22-016, T22-017): the catalogue of stored unit ids, the runtime
 * `Unit` of each, the rate promotion and the one resolution every panel plan uses. A board panel
 * stores `vis.unit` (board spec v8); `panelUnits` turns it, the drawn kind and the planner's rate
 * rewrite into the value unit and the heatmap's count unit. Pure, main thread.
 */
import type { PanelVis } from '../api/types';
import type { VisKind } from '../engine/api';
import type { Unit } from '../i18n/format';
import type { MessageId } from '../i18n/t';

/** The stored ids, in catalogue order: `api/fixtures/board-spec/unit-ids.json` and Go `unitIDs`. */
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

/** The most code points of a custom suffix (Go `maxUnitSuffixRunes`). */
export const MAX_UNIT_SUFFIX = 16;

export interface UnitEntry {
  readonly id: UnitId;
  readonly group: UnitGroup;
  readonly label: MessageId;
  /** The picker's example value; null for custom. */
  readonly example: number | null;
  /** The runtime unit; null for custom (its suffix is the panel's). */
  readonly unit: Unit | null;
}

const entry = (
  id: UnitId,
  group: UnitGroup,
  example: number | null,
  unit: Unit | null,
): UnitEntry => ({ id, group, label: `unit.id.${id}`, example, unit });

const PER_S: Unit = { kind: 'suffix', suffix: '/s' };
const NONE: Unit = { kind: 'none' };

/** The catalogue (§3.2): every id with its group, label, example and unit. */
export const UNIT_CATALOGUE: readonly UnitEntry[] = [
  entry('count', 'general', 1204, NONE),
  entry('none', 'general', 2026, { kind: 'plain' }),
  entry('custom', 'general', null, null),
  entry('seconds', 'time', 671000, { kind: 'time', base: 's' }),
  entry('milliseconds', 'time', 2843, { kind: 'time', base: 'ms' }),
  entry('microseconds', 'time', 1500, { kind: 'time', base: 'us' }),
  entry('nanoseconds', 'time', 2500, { kind: 'time', base: 'ns' }),
  entry('bytes', 'data', 1572864, { kind: 'bytes' }),
  entry('bytesSI', 'data', 1500000, { kind: 'bytes', prefix: 'si' }),
  entry('bits', 'data', 1.25e9, { kind: 'bits', prefix: 'si' }),
  entry('bitsIEC', 'data', 1048576, { kind: 'bits', prefix: 'iec' }),
  entry('perSecond', 'rate', 12.5, PER_S),
  entry('reqPerSecond', 'rate', 1204, { kind: 'suffix', suffix: 'req/s' }),
  entry('bytesPerSecond', 'rate', 1536, { kind: 'bytes', perSecond: true }),
  entry('bytesSIPerSecond', 'rate', 1500, { kind: 'bytes', prefix: 'si', perSecond: true }),
  entry('bitsPerSecond', 'rate', 1.25e9, { kind: 'bits', prefix: 'si', perSecond: true }),
  entry('bitsIECPerSecond', 'rate', 1048576, { kind: 'bits', prefix: 'iec', perSecond: true }),
  entry('percent', 'percent', 38, { kind: 'percent' }),
  entry('percentUnit', 'percent', 0.38, { kind: 'percentunit' }),
];

const BY_ID: ReadonlyMap<string, UnitEntry> = new Map(UNIT_CATALOGUE.map((e) => [e.id, e]));

const SPACE_OR_CONTROL = /[\p{White_Space}\p{Cc}]/u;

/**
 * Whether `s` is a valid custom suffix (§3.1, Go `validate.go` `unit`): 1 to 16 code points, none
 * of them a Unicode White_Space or Cc code point.
 */
export function isUnitSuffix(s: string): boolean {
  const n = Array.from(s).length;
  return n >= 1 && n <= MAX_UNIT_SUFFIX && !SPACE_OR_CONTROL.test(s);
}

/** A panel's stored unit (`vis.unit`). */
export type PanelUnit = NonNullable<PanelVis['unit']>;

/** The catalogue entry of `id`, if it is one. */
export function unitEntry(id: string): UnitEntry | undefined {
  return BY_ID.get(id);
}

/** The runtime unit of a stored one: custom is its suffix; an unknown id is none. */
export function unitOf(p: PanelUnit): Unit {
  if (p.id === 'custom') return { kind: 'suffix', suffix: p.suffix ?? '' };
  return BY_ID.get(p.id)?.unit ?? NONE;
}

/**
 * T22-017: the unit of a rated query. none is `/s`; a suffix not ending `/s` gains it; bytes and bits
 * are per second; time, percent and plain are kept (a rate of seconds or of a ratio stays one).
 */
export function rated(u: Unit): Unit {
  switch (u.kind) {
    case 'none':
      return PER_S;
    case 'suffix':
      return u.suffix.endsWith('/s') ? u : { kind: 'suffix', suffix: `${u.suffix}/s` };
    case 'bytes':
    case 'bits':
      return u.perSecond === true ? u : { ...u, perSecond: true };
    default:
      return u;
  }
}

/** The units a panel draws in: `value` (line, bars, stat, bar chart, geomap, heatmap bounds) and the heatmap's `count`. */
export interface PanelUnits {
  readonly value: Unit;
  readonly count: Unit;
}

/**
 * T22-015 (§4.1): the panel's units. `kind` is the drawn kind after Auto resolution (`chosen`),
 * never `auto`. Absent: none, or `/s` after the rate rewrite. Set: its unit, rated after the
 * rewrite on every kind but the heatmap, whose bucket bounds are never rated. The heatmap's count
 * is `/s` after the rewrite, else none.
 */
export function panelUnits(
  vis: { readonly unit?: PanelUnit } | undefined,
  kind: VisKind,
  rateApplied: boolean,
): PanelUnits {
  const count = rateApplied ? PER_S : NONE;
  const stored = vis?.unit;
  if (stored === undefined) return { value: kind === 'heatmap' ? NONE : count, count };
  const u = unitOf(stored);
  return { value: rateApplied && kind !== 'heatmap' ? rated(u) : u, count };
}
