/**
 * The geomap panel body (T24-088, T24-092 to T24-095; plan #234 Part 3 §4.1). Stub (tests first).
 */
import type { JSX } from 'react';
import type { GeoMapFrameProps } from '../vis/geo/plan';
import type { GeoData } from '../vis/geo/types';

export type { GeoMapFrameProps } from '../vis/geo/plan';

export interface GeoMapFrameHostProps extends Omit<GeoMapFrameProps, 'geoData'> {
  /** Absent: the shared `loadGeoData()`. */
  readonly geoData?: GeoData | 'loading';
  /** False in the editor preview: no member registration, inspect or select (§4.1). */
  readonly inspectorSource?: boolean;
  /** The map renderer could not load (§4.4a). */
  readonly onLoadFailed?: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function GeoMapFrame(p: GeoMapFrameHostProps): JSX.Element | null {
  return null;
}
