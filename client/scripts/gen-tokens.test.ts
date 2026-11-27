import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkGenerated,
  generate,
  parseTokens,
  TOKENS_CSS,
  TOKENS_RS,
  TOKENS_TOML,
  TOKENS_TS,
} from './gen-tokens.ts';

const toml = readFileSync(TOKENS_TOML, 'utf8');

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

describe('tokens generate', () => {
  it('emits the dark canvas and surfaces and the sidebar width', () => {
    const { css } = generate(toml);
    const dark = /:root,\n:root\[data-theme="dark"\] \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(dark).toContain('--canvas: #0E1014;');
    expect(dark).toContain('--surface-1: #15171C;');
    expect(dark).toContain('--surface-2: #1D2026;');
    expect(css).toContain('--size-sidebar-expanded: 240px;');
  });

  // #282: the half step, the radius scale, tracking, elevation, material and the 28 px control.
  it('emits the #282 scales, the string tables and the reduced-motion quick duration', () => {
    const { css, ts, rs } = generate(toml);
    const common = /\n:root \{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const decl of [
      '--space-0-5: 2px;',
      '--radius-pill: 9999px;',
      '--radius-lg: 14px;',
      '--tracking-xl: -0.017em;',
      '--elevation-2: inset 0 1px 0 var(--highlight), 0 2px 6px var(--shadow-ambient), 0 12px 32px var(--shadow-key);',
      '--material-filter: blur(24px) saturate(180%);',
      '--size-control: 28px;',
    ]) {
      expect(common, decl).toContain(decl);
    }
    expect(css).not.toContain('--radius-float');
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([^]*)\}\s*$/.exec(css)?.[1] ?? '';
    expect(reduced).toContain('--motion-quick: 0ms;');
    expect(ts).toMatch(/"tracking": \{[^}]*"lg": -0\.011/);
    expect(ts).toMatch(/export const elevation = \{[^}]*"1": "inset 0 1px 0 var\(--highlight\)/);
    expect(rs).toContain('pub const LG: f32 = -0.011;');
    expect(rs).toContain('pub const S_0_5: f32 = 2.0;');
    expect(rs).toMatch(
      /pub mod elevation \{[^}]*pub const E_1: &str = "inset 0 1px 0 var\(--highlight\)/,
    );
    expect(rs).toContain(
      'pub mod material { pub const FILTER: &str = "blur(24px) saturate(180%)"; }',
    );
  });

  it('rejects a tracking value outside ±0.05 and an unsafe string, naming the key', () => {
    expect(() => generate(toml.replace('lg = -0.011', 'lg = 0.2'))).toThrow(/font\.tracking\.lg/);
    expect(() =>
      generate(
        toml.replace(
          '1 = "inset 0 1px 0 var(--highlight), 0 1px 2px var(--shadow-ambient)"',
          '1 = "a;b"',
        ),
      ),
    ).toThrow(/elevation\.1/);
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
    const bad = toml.replace('canvas = "#0E1014"', 'canvas = "blue"');
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

describe('ci:token-lint Rust output', () => {
  const bytes = (hex: string): string => {
    const b = [1, 3, 5, 7].map((i) => (i < hex.length ? hex.slice(i, i + 2) : 'FF'));
    return `Rgba8([${b.map((x) => `0x${x.toUpperCase()}`).join(', ')}])`;
  };
  const rustName = (k: string): string => {
    const n = k.toUpperCase().replace(/-/g, '_');
    return /^\d/.test(n) ? `S_${n}` : n;
  };

  it('emits every colour as sRGB-encoded Rgba8 bytes equal to its CSS hex', () => {
    const { rs } = generate(toml);
    expect(rs).toContain('pub const SURFACE_1: Rgba8 = Rgba8([0x15, 0x17, 0x1C, 0xFF]);');
    expect(rs).toContain('pub mod advance { pub const MONO: f32 = 0.6; }');
    const tk = parseTokens(toml);
    for (const theme of ['dark', 'light'] as const) {
      const body = new RegExp(`pub mod ${theme} \\{([^}]*)\\}`).exec(rs)?.[1] ?? '';
      expect(body, theme).not.toBe('');
      for (const [k, hex] of Object.entries(tk.colour[theme])) {
        expect(body, `${theme}.${k}`).toContain(`pub const ${rustName(k)}: Rgba8 = ${bytes(hex)};`);
      }
    }
    const dark = /pub mod dark \{([^}]*)\}/.exec(rs)?.[1] ?? '';
    expect(dark).toContain('pub const HAIRLINE: Rgba8 = Rgba8([0xFF, 0xFF, 0xFF, 0x14]);');
    expect(rs).not.toContain('Lin(');
    expect(rs).not.toMatch(/\[f32; 4\]/);
    for (const line of rs.split('\n').filter((l) => l.includes('Rgba8('))) {
      expect(line).not.toContain('f32');
    }
  });

  it('checkGenerated reports a stale tokens.rs', () => {
    const { css, ts } = generate(toml);
    const files: Record<string, string> = {
      [TOKENS_CSS]: css,
      [TOKENS_TS]: ts,
      [TOKENS_RS]: '// stale\n',
    };
    const findings = checkGenerated((p) => files[p] ?? '');
    expect(findings.map((f) => f.rule)).toEqual([
      'stale-generated:engine/crates/dash-tokens/src/tokens.rs',
    ]);
  });
});
