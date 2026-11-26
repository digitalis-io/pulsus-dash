// stub (#231 tests first)
import type { Labels } from '../../data/frames';
import type { Gazetteer } from './types';
export { decodeGeohash } from './geohash';

export type GeoSource = 'coords' | 'geohash' | 'country' | 'region' | 'iata' | 'cloud';
export interface GeoPlace {
  readonly lat: number;
  readonly lon: number;
  readonly source: GeoSource;
  readonly key: string;
  readonly code: string | null;
  readonly provider: string | null;
  readonly name: string | null;
  readonly cell: { readonly dLat: number; readonly dLon: number } | null;
}
export type LocationResult =
  | { readonly status: 'placed'; readonly place: GeoPlace }
  | { readonly status: 'noLocation' }
  | { readonly status: 'gazetteerUnavailable' }
  | {
      readonly status: 'invalid';
      readonly reason: 'coords' | 'incompleteCoords' | 'geohash';
      readonly key: string;
    }
  | {
      readonly status: 'unknownCode';
      readonly source: GeoSource;
      readonly key: string;
      readonly value: string;
    }
  | {
      readonly status: 'providerMismatch';
      readonly key: string;
      readonly provider: string;
      readonly candidates: readonly string[];
    }
  | {
      readonly status: 'ambiguous';
      readonly reason:
        'keyCollision' | 'aliasConflict' | 'sharedCode' | 'name' | 'providers' | 'regionOrCloud';
      readonly candidates: readonly string[];
    };
export type LocationOption =
  | { readonly mode: 'auto' }
  | { readonly mode: 'coords'; readonly lat: string; readonly lon: string }
  | { readonly mode: 'geohash'; readonly field: string }
  | {
      readonly mode: 'lookup';
      readonly field: string;
      readonly gazetteer: 'country' | 'region' | 'iata' | 'cloud';
      readonly country?: string;
    };

export function locate(labels: Labels, o: LocationOption, g: Gazetteer | null): LocationResult {
  void labels;
  void o;
  void g;
  return { status: 'ambiguous', reason: 'keyCollision', candidates: ['stub'] };
}
