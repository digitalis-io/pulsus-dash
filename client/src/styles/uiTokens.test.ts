/**
 * `unit:ui-token-contrast` (#282; VL-009 thresholds, VL-017): the chrome colour pairs of the visual
 * refresh meet WCAG 2.x contrast in both themes. Translucent colours are composited over the
 * surface beneath them first.
 */
import { describe, expect, it } from 'vitest';
import { colour } from './tokens';

type Theme = 'dark' | 'light';
type Rgb = readonly [number, number, number];

/** A token's hex, or a literal `#RRGGBB`; fails the test (an assertion) when the key is absent. */
function hexOf(theme: Theme, key: string): string {
  if (key.startsWith('#')) return key;
  const v = (colour[theme] as Record<string, string | undefined>)[key];
  expect(v, `${theme}.${key}`).toBeDefined();
  return v ?? '#000000';
}

function rgba(hex: string): [number, number, number, number] {
  const byte = (i: number): number => parseInt(hex.slice(i, i + 2), 16);
  return [byte(1), byte(3), byte(5), hex.length === 9 ? byte(7) / 255 : 1];
}

/** `top` composited over the opaque `base` (sRGB, as browsers blend). */
function over(top: string, base: Rgb): Rgb {
  const [r, g, b, a] = rgba(top);
  return [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
}

/** A colour stack, bottom first: each later colour is composited over the result so far. */
function stack(theme: Theme, ...keys: string[]): Rgb {
  let out: Rgb = [0, 0, 0];
  for (const k of keys) out = over(hexOf(theme, k), out);
  return out;
}

function luminance(c: Rgb): number {
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES: readonly Theme[] = ['dark', 'light'];
/** The opaque surfaces content sits on. */
const B = ['canvas', 'surface-1', 'surface-2', 'surface-hover', 'sidebar'] as const;

/** Asserts `fg` (a stack) against each background stack at `min`. */
function atLeast(theme: Theme, fg: string[], bgs: string[][], min: number): void {
  for (const bg of bgs) {
    const r = ratio(stack(theme, ...bg, ...fg), stack(theme, ...bg));
    expect(r, `${theme}: ${fg.join('/')} on ${bg.join('/')}`).toBeGreaterThanOrEqual(min);
  }
}

/** Asserts two opaque-or-composited stacks differ by `min`. */
function pair(theme: Theme, a: string[], b: string[], min: number): void {
  const r = ratio(stack(theme, ...a), stack(theme, ...b));
  expect(r, `${theme}: ${a.join('/')} vs ${b.join('/')}`).toBeGreaterThanOrEqual(min);
}

describe('unit:ui-token-contrast', () => {
  for (const theme of THEMES) {
    it(`${theme}: field boundaries are at least 3:1 from the fill and every surface beneath`, () => {
      for (const bg of ['field', 'canvas', 'surface-1', 'surface-2', 'sidebar']) {
        pair(theme, ['border-field'], [bg], 3);
      }
      for (const base of ['canvas', 'surface-1']) {
        pair(theme, ['border-field'], [base, 'material-menu'], 3);
      }
    });

    it(`${theme}: surface-1 is opaque (the material fallback)`, () => {
      expect(rgba(hexOf(theme, 'surface-1'))[3]).toBe(1);
    });

    it(`${theme}: text, accent and focus contrast on the surfaces and controls`, () => {
      const bgs = [...B, 'control', 'field'].map((k) => [k]);
      for (const fg of ['text', 'text-muted']) atLeast(theme, [fg], bgs, 4.5);
      atLeast(
        theme,
        ['accent'],
        B.map((k) => [k]),
        4.5,
      );
      atLeast(theme, ['focus'], bgs, 3);
      for (const fill of ['accent-fill', 'accent-pressed'])
        pair(theme, ['text-on-accent'], [fill], 4.5);
    });

    it(`${theme}: text on the materials over any backdrop`, () => {
      for (const material of ['material-bar', 'material-menu']) {
        for (const base of ['canvas', 'surface-1', '#FFFFFF', '#000000']) {
          for (const fg of ['text', 'text-muted']) {
            pair(theme, [base, material, fg], [base, material], 4.5);
          }
        }
      }
    });

    it(`${theme}: the accent-filled menu row, sidebar row and segmented thumb stand out`, () => {
      for (const base of ['canvas', 'surface-1']) {
        pair(theme, ['accent-fill'], [base, 'material-menu'], 3);
      }
      pair(theme, ['accent-fill'], ['sidebar'], 3);
      pair(theme, ['text-on-accent'], ['accent-fill'], 4.5);
      pair(theme, ['accent-fill'], ['field'], 3);
    });
  }
});
