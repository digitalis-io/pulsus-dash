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
