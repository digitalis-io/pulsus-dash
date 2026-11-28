/**
 * Legend name templates (board spec v10, the legend-name version, #204; T22-001): a panel's
 * `vis.legendFormat` names each series by the template with every `{{label}}` replaced by that
 * series' value of `label` (empty when the series has no such label). Without a template a series
 * is named by its full label set (`seriesName`). Only the shown name changes: keys, isolation,
 * selection and sort tie-breaks stay on the series key, so two series that render one name stay
 * two series.
 */
import { seriesName, type FrameData, type Labels } from '../data/frames';
import type { HoverEvent } from '../engine/api';
import type { ExploreResult } from './autovis';

/** The most code points a template holds (the server's `maxLegendFormatRunes`). */
export const MAX_LEGEND_FORMAT = 256;

/**
 * A placeholder: `{{`, optional spaces, a label name (the PromQL label pattern), optional spaces,
 * `}}`. Any other brace text is literal.
 */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** 1 to 256 code points (the server rule, `board.legendFormat.invalid`). */
export function isLegendFormat(s: string): boolean {
  // Code points, not UTF-16 units: a code point outside the BMP counts once.
  if (s.length === 0 || s.length > 2 * MAX_LEGEND_FORMAT) return false;
  return s.length <= MAX_LEGEND_FORMAT || Array.from(s).length <= MAX_LEGEND_FORMAT;
}

/** `format` with each `{{label}}` replaced by `labels[label]`, or '' when the label is absent. */
export function renderLegendFormat(format: string, labels: Labels): string {
  // A replacer function: a value is inserted as it is (no `$&` patterns, never re-read).
  return format.replace(PLACEHOLDER, (_whole, name: string) =>
    Object.hasOwn(labels, name) ? (labels[name] ?? '') : '',
  );
}

/** The shown name of a series: the template rendered, or `seriesName(labels)` without one. */
export function displayName(labels: Labels, format: string | null): string {
  return format === null ? seriesName(labels) : renderLegendFormat(format, labels);
}

/** Series key → shown name. */
export type SeriesNames = ReadonlyMap<string, string>;

const namesOf = new WeakMap<FrameData, Map<string, SeriesNames>>();

/**
 * The shown names of a series frame's series by key (cached per frame and template); null without
 * a template or for a frame without series (the engines' own names stand).
 */
export function seriesNames(data: FrameData, format: string | null): SeriesNames | null {
  if (format === null || data.kind !== 'series') return null;
  let byFormat = namesOf.get(data);
  if (byFormat === undefined) {
    byFormat = new Map();
    namesOf.set(data, byFormat);
  }
  let names = byFormat.get(format);
  if (names === undefined) {
    names = new Map(data.series.map((s) => [s.key, renderLegendFormat(format, s.labels)]));
    byFormat.set(format, names);
  }
  return names;
}

/**
 * The hover event with each row named by `names` (rows of other keys keep their names): both
 * engines name rows by the full label set, so the tooltip and the crosshair text read the shown
 * names through this. `h` itself when there is nothing to rename.
 */
export function namedHover(h: HoverEvent | null, names: SeriesNames | null): HoverEvent | null {
  if (h === null || names === null || h.tMs === null || h.rows.length === 0) return h;
  return { ...h, rows: h.rows.map((r) => ({ ...r, name: names.get(r.key) ?? r.name })) };
}

const codeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The label names of a result's series, once each, in code unit order (the editor's hint). */
export function resultLabelNames(r: ExploreResult): string[] {
  if (r.kind !== 'series') return [];
  const names = new Set<string>();
  for (const s of r.series) for (const k of Object.keys(s.labels)) names.add(k);
  return [...names].sort(codeUnits);
}
