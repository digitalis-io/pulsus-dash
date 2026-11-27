/**
 * The geomap's mark list (T24-093, T24 §5.16; plan #234 Part 3 §3.4, §4.3). Stub (tests first).
 */
import type { JSX } from 'react';
import type { ChartFrame as EngineFrame, GeoMarksEvent, Unit } from '../../engine/api';
import type { Selection } from '../../inspector/types';
import type { GeoRow, GeoRowSet } from '../../vis/geo/frame';
import type { GeoInspectorTarget } from '../../vis/geo/targets';

export interface GeoMarkListProps {
  readonly title: string;
  readonly marks: GeoMarksEvent['marks'];
  readonly rows: ReadonlyMap<string, GeoRow>;
  readonly unit: Unit;
  /** The meter reads `100 %`. */
  readonly complete: boolean;
  readonly selection: Selection | null;
  readonly frame: EngineFrame | null;
  readonly seq: number;
  readonly rowSet: GeoRowSet;
  onInspect(t: GeoInspectorTarget, f: HTMLElement): void;
  onActive(id: string | null): void;
  announce(text: string): void;
}

export function geoMarkName(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  m: GeoMarksEvent['marks'][number],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  rows: GeoMarkListProps['rows'],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  unit: Unit,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sel: Selection | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  thresholds: boolean,
): string {
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function GeoMarkList(p: GeoMarkListProps): JSX.Element | null {
  return null;
}
