/**
 * The geomap's table, CSV and summary facts (T24-094, T24 §4.14, §5.16; plan #234 Part 1 §4.3).
 */
import type { SeriesFrame } from '../../data/frames';
import type { SummaryFacts } from '../../engine/api';
import type { Unit } from '../../i18n/format';
import type { PanelRows } from '../reduce';
import type { GeoRowSet } from './frame';

export function geoTable(s: GeoRowSet, unit: Unit): PanelRows {
  void [s, unit];
  return { columns: [], rows: [] };
}

export function geoCsv(s: GeoRowSet, unit: Unit): string {
  void [s, unit];
  return '';
}

export function geoFacts(
  title: string,
  s: GeoRowSet,
  series: readonly SeriesFrame[],
  instant: boolean,
  unit: Unit,
): SummaryFacts | null {
  void [title, s, series, instant, unit];
  return null;
}
