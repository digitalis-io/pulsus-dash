import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lintCss, lintTokens } from './token-lint.ts';

const fixtures = fileURLToPath(new URL('./__fixtures__/token-lint/', import.meta.url));
const clientRoot = fileURLToPath(new URL('..', import.meta.url));

async function findings(root: string): Promise<string[]> {
  const list = await lintTokens(root);
  return [...new Set(list.map((f) => `${f.rule} ${f.file}:${String(f.line ?? 0)}`))].sort();
}

function at(rule: string, file: string, lines: number[]): string[] {
  return lines.map((l) => `${rule} ${file}:${String(l)}`);
}

const bad = await findings(`${fixtures}bad`);
function only(file: string): string[] {
  return bad.filter((f) => f.split(' ')[1]?.startsWith(`${file}:`));
}

describe('token-lint colour (T05-002)', () => {
  it('reports hex, rgb() and named colours in CSS and TS', () => {
    expect(only('src/shell/Hex.module.css')).toEqual(
      at('colour-literal', 'src/shell/Hex.module.css', [1, 2, 3, 4]),
    );
    expect(only('src/shell/rgb.tsx')).toEqual(at('colour-literal', 'src/shell/rgb.tsx', [1]));
    expect(only('src/state/hex.ts')).toEqual(at('colour-literal', 'src/state/hex.ts', [1]));
    expect(only('src/shell/Named.module.css')).toEqual(
      at('colour-literal', 'src/shell/Named.module.css', [1]),
    );
  });
});

describe('token-lint size and duration (T05-002)', () => {
  it('reports sizes and durations in CSS and UI TS', () => {
    expect(only('src/shell/Size.module.css')).toEqual(
      at('size-literal', 'src/shell/Size.module.css', [1, 2]),
    );
    expect(only('src/kit/size.tsx')).toEqual(at('size-literal', 'src/kit/size.tsx', [1, 2, 3]));
    expect(only('src/shell/Duration.module.css')).toEqual(
      at('duration-literal', 'src/shell/Duration.module.css', [1, 2]),
    );
    expect(only('src/pages/duration.ts')).toEqual(
      at('duration-literal', 'src/pages/duration.ts', [1, 2]),
    );
  });
});

describe('token-lint state tokens (T05-002)', () => {
  it('reports every form of state-token use, computed names and suppressions', () => {
    expect(only('src/shell/Badge.module.css')).toEqual(
      [
        ...at('state-token', 'src/shell/Badge.module.css', [1, 2, 3, 4, 5, 6, 7, 8]),
        ...at('colour-literal', 'src/shell/Badge.module.css', [2]),
      ].sort(),
    );
    expect(only('src/pages/state.ts')).toEqual(
      [
        ...at('state-token', 'src/pages/state.ts', [1, 2, 3, 4]),
        ...at('colour-literal', 'src/pages/state.ts', [4]),
        ...at('computed-token-name', 'src/pages/state.ts', [5]),
      ].sort(),
    );
    expect(only('src/pages/suppressed.ts')).toEqual(
      at('suppressed-token-rule', 'src/pages/suppressed.ts', [1]),
    );
  });
});

describe('token-lint allowed', () => {
  it('reports nothing for the allowed forms', async () => {
    expect(await findings(`${fixtures}good`)).toEqual([]);
  });
});

describe('token-lint real tree', () => {
  // Lints the whole tree (about 4 s alone): the default 5 s is too tight beside the other files.
  it('reports nothing for src/', async () => {
    expect(await findings(clientRoot)).toEqual([]);
  }, 30_000);
});

describe('unit:shadow-token (VL-004)', () => {
  const shadows = (value: string): number =>
    lintCss('src/kit/X.module.css', `.x {\n  box-shadow: ${value};\n}\n`).filter(
      (f) => f.rule === 'shadow-token',
    ).length;

  it('reports a drop shadow that is not an elevation token', () => {
    expect(shadows('0 2px 6px var(--backdrop)')).toBe(1);
    expect(shadows('var(--elevation-1), 0 1px 2px var(--x)')).toBe(1);
  });

  it('allows the elevation tokens, none, inset bars and spread-only rings', () => {
    expect(shadows('var(--elevation-2)')).toBe(0);
    expect(shadows('none')).toBe(0);
    expect(shadows('inset 2px 0 0 var(--accent)')).toBe(0);
    expect(shadows('0 0 0 var(--size-focus-ring) var(--selection)')).toBe(0);
  });

  it('names the rule in its message', () => {
    const [f] = lintCss(
      'src/kit/X.module.css',
      '.x { box-shadow: 0 2px 6px var(--backdrop); }',
    ).filter((x) => x.rule === 'shadow-token');
    expect(f?.message).toBe('drop shadows come only from the elevation tokens (VL-004)');
  });
});
