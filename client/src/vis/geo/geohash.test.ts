/** `unit:geo-geohash` (T24 §10.3, T24-083): cell centres and sizes; anything else is null. */
import { describe, expect, it } from 'vitest';
import { decodeGeohash } from './geohash';

describe('unit:geo-geohash (T24-083)', () => {
  it('decodes to the cell centre and size (L18, C8)', () => {
    expect(decodeGeohash('u4pruydqqvj')).toStrictEqual({
      lat: 57.64911063015461,
      lon: 10.407439693808556,
      dLat: 1.341104507446289e-6,
      dLon: 1.341104507446289e-6,
    });
    expect(decodeGeohash('u4pr')).toStrictEqual({
      lat: 57.568359375,
      lon: 10.37109375,
      dLat: 0.17578125,
      dLon: 0.3515625,
    });
  });
  it.each(['', 'u'.repeat(13), 'u4pa'])('%j → null', (h) => {
    expect(decodeGeohash(h)).toBeNull();
  });
});
