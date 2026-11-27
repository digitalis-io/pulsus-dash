/**
 * The geomap's colour tokens (plan #234 Part 1 §3.7, T24-091): every series colour keeps at least
 * 3:1 (WCAG 2.x contrast) on `map-land` and `map-water` in both themes.
 */
import { describe, expect, it } from 'vitest';
import { colour, seriesPalette } from './tokens';

/** The relative luminance of `#RRGGBB` (alpha ignored). */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = c.map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe('map tokens', () => {
  it('the §3.7 values', () => {
    expect(
      (['dark', 'light'] as const).map((th) => [
        colour[th]['map-water'],
        colour[th]['map-land'],
        colour[th]['map-coast'],
        colour[th]['map-border'],
      ]),
    ).toEqual([
      ['#0E1620', '#1C232C', '#FFFFFF33', '#FFFFFF1F'],
      ['#E6EDF4', '#F8F9FB', '#0B0D103D', '#0B0D1029'],
    ]);
  });

  it('every series colour keeps ≥ 3:1 on map-land and map-water', () => {
    for (const th of ['dark', 'light'] as const) {
      for (const bg of ['map-land', 'map-water'] as const) {
        for (const c of seriesPalette[th]) {
          expect(contrast(c, colour[th][bg]), `${th} ${c} on ${bg}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});
