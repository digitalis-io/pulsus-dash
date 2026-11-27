/**
 * The geomap's table, CSV and summary facts (T24-094, T24 §4.14, §5.16; plan #234 Part 1 §4.3):
 * every row of a row set, by name then key, with the §4.14 columns (raw cells, unguarded), the
 * same rows as RFC 4180 CSV through `csvCell`, and the T22-014 facts of the rows with a usable
 * value (before the cap, any draw status).
 */
import type { Mark, SeriesFrame } from '../../data/frames';
import type { SummaryFacts } from '../../engine/api';
import { formatValue, type Unit } from '../../i18n/format';
import {
  focusOf,
  largestChange,
  mergeDuplicates,
  panelCsv,
  TABLE_COLUMNS,
  type PanelRows,
} from '../reduce';
import type { GeoRow, GeoRowSet } from './frame';
import { geoPlace, locationDetail } from './targets';

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A number as the table holds it: `String(v)` (±Infinity by name); NaN empty. */
const numberCell = (v: number): string => (Number.isNaN(v) ? '' : String(v));

/** The row as a T22 mark (no baseline, no anomaly). */
function markOf(r: GeoRow): Mark {
  return {
    key: r.key,
    labels: r.labels,
    name: r.name,
    value: r.value,
    state: r.state,
    baseline: null,
    anomaly: null,
  };
}

/** The drawn group's label of each row and its own label when it is an aggregate member. */
function groupCells(s: GeoRowSet, r: GeoRow): [group: string, member: string] {
  const g = s.groups[r.group];
  if (g === undefined) return ['', ''];
  if (g.members === null) return [g.label, ''];
  const id = JSON.stringify(r.groupId);
  const i = g.members.findIndex((m) => JSON.stringify(m) === id);
  return [g.label, g.memberLabels?.[i] ?? ''];
}

/**
 * The table view (T24-094): one row per `GeoRow`, ordered by name then key; `mark` is the row,
 * `drawn` whether it is `shown`, `shownAs` its group cell. `unit` is the view's: the cells are raw.
 */
export function geoTable(
  s: GeoRowSet,
  // The view's unit; the cells are raw numbers (T24-094), so the table needs none.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  unit: Unit,
): PanelRows {
  const ordered = [...s.rows].sort(
    (a, b) => codeUnitOrder(a.name, b.name) || codeUnitOrder(a.key, b.key),
  );
  const rows = ordered.map((r) => {
    const [group, member] = groupCells(s, r);
    const place = r.location.status === 'placed' ? r.location.place : null;
    const mark = markOf(r);
    return {
      key: mark.key,
      mark,
      drawn: r.draw === 'shown',
      shownAs: group,
      cells: [
        r.name,
        r.key,
        numberCell(r.value),
        r.valueStatus,
        r.state ?? '',
        r.location.status,
        locationDetail(r.location),
        place?.source ?? '',
        place?.code ?? '',
        place?.provider ?? '',
        geoPlace(r),
        place === null ? '' : String(place.lat),
        place === null ? '' : String(place.lon),
        group,
        member,
        r.draw,
      ],
    };
  });
  return { columns: TABLE_COLUMNS.geomap, rows };
}

/** The CSV of the table (T24-094): the §4.14 header, then every row; CRLF; each cell guarded. */
export function geoCsv(s: GeoRowSet, unit: Unit): string {
  return panelCsv(geoTable(s, unit));
}

/**
 * The summary facts (T22-014, T24-094): over the rows with an `ok` value, the focus mark is the
 * worst state (with thresholds), then the higher value, then the lower key; `current` its value
 * and name; `change` (a range result) the largest step of its merged series; `extent` the min and
 * max; `baselineRatio` null. Null when no row has an `ok` value.
 */
export function geoFacts(
  title: string,
  s: GeoRowSet,
  series: readonly SeriesFrame[],
  instant: boolean,
  unit: Unit,
): SummaryFacts | null {
  const marks = s.rows.filter((r) => r.valueStatus === 'ok').map(markOf);
  const focus = focusOf(marks);
  if (focus === null) return null;
  let change: SummaryFacts['change'] = null;
  if (!instant) {
    const merged = mergeDuplicates(series, 'range').series.find((x) => x.key === focus.key);
    const c = merged === undefined ? null : largestChange(merged);
    if (c !== null) {
      const from = formatValue(c.from, unit);
      change = { series: focus.name, from, to: formatValue(c.to, unit), atMs: c.atMs };
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const m of marks) {
    if (m.value < min) min = m.value;
    if (m.value > max) max = m.value;
  }
  return {
    subject: title,
    current: { text: formatValue(focus.value, unit), series: focus.name },
    change,
    extent: { min, max },
    baselineRatio: null,
  };
}
