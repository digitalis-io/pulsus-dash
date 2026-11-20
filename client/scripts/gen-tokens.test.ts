import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generate, parseTokens, TOKENS_CSS, TOKENS_TOML, TOKENS_TS } from './gen-tokens.ts';

const toml = readFileSync(TOKENS_TOML, 'utf8');

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

describe('tokens generate', () => {
  it('emits the dark canvas and surfaces and the sidebar width', () => {
    const { css } = generate(toml);
    const dark = /:root,\n:root\[data-theme="dark"\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(dark).toContain('--canvas: #0B0D10;');
    expect(dark).toContain('--surface-1: #12151A;');
    expect(dark).toContain('--surface-2: #191D24;');
    expect(css).toContain('--size-sidebar-expanded: 240px;');
  });
});

describe('tokens light designed', () => {
  it('has the same keys in both themes; every light colour is designed, not inverted', () => {
    const { dark, light } = parseTokens(toml).colour;
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    for (const [k, d] of Object.entries(dark)) {
      const l = light[k] ?? '';
      expect(l, k).not.toBe(d);
      const inverted = rgb(d).map((c) => 255 - c);
      expect(rgb(l), k).not.toEqual(inverted);
    }
  });
});

describe('tokens committed', () => {
  it('generated files on disk equal the generator output byte for byte', () => {
    const { css, ts } = generate(toml);
    expect(readFileSync(TOKENS_CSS, 'utf8')).toBe(css);
    expect(readFileSync(TOKENS_TS, 'utf8')).toBe(ts);
  });
});

describe('tokens invalid', () => {
  it('names the offending key', () => {
    const bad = toml.replace('canvas = "#0B0D10"', 'canvas = "blue"');
    expect(() => generate(bad)).toThrow(/color\.dark\.canvas/);
  });
});

describe('T-tok-1 ordered palettes', () => {
  it('emits seriesPalette (8 per theme) and sequentialRamp (9 per theme) in key order', () => {
    const { ts } = generate(toml);
    const tk = parseTokens(toml);
    for (const theme of ['dark', 'light'] as const) {
      const c = tk.colour[theme];
      const series = Array.from({ length: 8 }, (_, i) => c[`series-${String(i + 1)}`]);
      const ramp = Array.from({ length: 9 }, (_, i) => c[`ramp-${String(i + 1)}`]);
      expect(series.every((v) => v !== undefined)).toBe(true);
      expect(ramp.every((v) => v !== undefined)).toBe(true);
      const block = (name: string): string =>
        new RegExp(`export const ${name} = \\{[^]*?\\n\\}`).exec(ts)?.[0] ?? '';
      const arr = (name: string): string[] =>
        JSON.parse(
          new RegExp(`"${theme}": (\\[[^\\]]*\\])`)
            .exec(block(name))?.[1]
            ?.replace(/,\s*\]/, ']') ?? 'null',
        ) as string[];
      expect(arr('seriesPalette')).toEqual(series);
      expect(arr('sequentialRamp')).toEqual(ramp);
    }
  });
});

describe('T-tok-2 contiguous numbering', () => {
  it('fails when series-N is not contiguous from 1', () => {
    const gappy = toml
      .split('\n')
      .filter((l) => !/^series-[24-8] = /.test(l))
      .join('\n');
    expect(() => generate(gappy)).toThrow(/series-2/);
  });
});
