/**
 * `unit:ui-token-contrast` (#282; VL-009 thresholds, VL-017): the chrome colour pairs of the visual
 * refresh meet WCAG 2.x contrast in both themes. Translucent colours are composited over the
 * surface beneath them first.
 */
import { describe, expect, it } from 'vitest';
import { colour, opacity } from './tokens';

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

/** A token opacity; fails the test (an assertion) when the key is absent. */
function alphaOf(key: string): number {
  const v = (opacity as Record<string, number | undefined>)[key];
  expect(v, `opacity.${key}`).toBeDefined();
  return v ?? 0;
}

/** `c` at alpha `a` over the opaque `bg` (the tint pattern's pseudo-element, #282 Part 2a). */
function tint(theme: Theme, bg: string, c: string, a: number): Rgb {
  const base = stack(theme, bg);
  const [r, g, b] = rgba(hexOf(theme, c));
  return [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
}

/** An opaque token `fg` on a tinted composite. */
function onTint(theme: Theme, fg: string, under: Rgb): number {
  return ratio(over(hexOf(theme, fg), under), under);
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

  // State colours as text (glyph and label, VL-003) on surface-1 and surface-2. Pairs that met
  // 4.5:1 before the refresh must still; the others (below 4.5:1 before #282) may not fall more
  // than 0.15 below their origin/main ratio. The strict 4.5:1 for every pair needs new state
  // colours and is tracked in #284.
  const STATES = ['ok', 'watch', 'degraded', 'failing', 'unknown'] as const;
  /** The ratios at origin/main before #282 (surface-1, surface-2). */
  const BEFORE: Record<Theme, Record<(typeof STATES)[number], readonly [number, number]>> = {
    dark: {
      ok: [7.14, 6.6],
      watch: [10.72, 9.91],
      degraded: [7.5, 6.92],
      failing: [4.62, 4.27],
      unknown: [3.78, 3.5],
    },
    light: {
      ok: [4.85, 4.17],
      watch: [4.31, 3.71],
      degraded: [5.08, 4.37],
      failing: [6.01, 5.17],
      unknown: [3.93, 3.38],
    },
  };
  for (const theme of THEMES) {
    it(`${theme}: state text keeps 4.5:1 where it had it, and never falls more than 0.15 (#284)`, () => {
      for (const st of STATES) {
        (['surface-1', 'surface-2'] as const).forEach((bg, i) => {
          const before = BEFORE[theme][st][i] ?? 0;
          const r = ratio(stack(theme, bg, st), stack(theme, bg));
          const min = before >= 4.5 ? 4.5 : before - 0.15;
          expect(r, `${theme}: ${st} on ${bg} (was ${String(before)})`).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  // #282 Part 2a: tinted tags and chips (VL-009; labels in `text`, never state colour on a tint).
  const STATE_KEYS = ['ok', 'watch', 'degraded', 'failing', 'unknown'] as const;
  const LEVELS = ['critical', 'error', 'warn', 'info', 'debug', 'trace', 'unknown'] as const;
  for (const theme of THEMES) {
    it(`${theme}: a state tag's glyph and label on its tint`, () => {
      for (const st of STATE_KEYS) {
        const under = tint(theme, 'surface-1', st, alphaOf('tag'));
        expect(onTint(theme, st, under), `${theme}: ${st} glyph on its tag`).toBeGreaterThanOrEqual(
          3,
        );
        expect(
          onTint(theme, 'text', under),
          `${theme}: text on the ${st} tag`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: a log level tag's text on its tint`, () => {
      for (const lv of LEVELS) {
        const under = tint(theme, 'surface-1', `level-${lv}`, alphaOf('tag'));
        expect(
          onTint(theme, 'text', under),
          `${theme}: text on level-${lv}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${theme}: legend chips keep their text and state glyphs on every series tint`, () => {
      for (let n = 1; n <= 8; n++) {
        const under = tint(theme, 'surface-1', `series-${String(n)}`, alphaOf('chip'));
        for (const fg of ['text', 'text-muted']) {
          expect(
            onTint(theme, fg, under),
            `${theme}: ${fg} on series-${String(n)}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        for (const st of ['watch', 'degraded', 'failing']) {
          expect(
            onTint(theme, st, under),
            `${theme}: ${st} on series-${String(n)}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it(`${theme}: the board status glyph (failing) on the canvas`, () => {
      pair(theme, ['canvas', 'failing'], ['canvas'], 3);
    });
  }

  // #282 Part 2b (VL-009): the line area stacks 1–4 series tints at chart-area ÷ n over surface-1;
  // every series stroke and every threshold state colour stays at least 3:1 on any such stack.
  for (const theme of THEMES) {
    it(`${theme}: strokes and thresholds keep 3:1 over 1–4 stacked area tints`, () => {
      const series = Array.from({ length: 8 }, (_, k) => `series-${String(k + 1)}`);
      const a = alphaOf('chart-area');
      const subsets = (n: number, from = 0): string[][] =>
        n === 0
          ? [[]]
          : series
              .slice(from)
              .flatMap((c, k) => subsets(n - 1, from + k + 1).map((rest) => [c, ...rest]));
      for (let n = 1; n <= 4; n++) {
        for (const set of subsets(n)) {
          let under = stack(theme, 'surface-1');
          for (const c of set) {
            const [r, g, b] = rgba(hexOf(theme, c));
            const t = a / n;
            under = [r * t + under[0] * (1 - t), g * t + under[1] * (1 - t), b * t + under[2] * (1 - t)];
          }
          for (const fg of [...series, 'watch', 'degraded', 'failing']) {
            expect(onTint(theme, fg, under), `${theme}: ${fg} over ${set.join('+')}`).toBeGreaterThanOrEqual(3);
          }
        }
      }
    });
  }
});
