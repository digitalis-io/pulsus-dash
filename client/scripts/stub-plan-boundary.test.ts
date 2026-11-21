/**
 * unit:stub-plan-boundary (plan #112 §3.7): only StubApi imports the planner mirror.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { stubPlanBoundary } from '../eslint/stub-plan-boundary.ts';

const cwd = fileURLToPath(new URL('..', import.meta.url));

function eslint(): ESLint {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [{ languageOptions: { parser: tseslint.parser } }, stubPlanBoundary],
  });
}

describe('unit:stub-plan-boundary', () => {
  it('refuses an import of the mirror outside StubApi', async () => {
    const [r] = await eslint().lintText("import { prepare } from '../api/stub/plan';\n", {
      filePath: 'src/explore/x.ts',
    });
    expect(r?.messages.map((m) => [m.ruleId, m.message])).toEqual([
      [
        '@typescript-eslint/no-restricted-imports',
        'api/stub/plan is the StubApi planner mirror: only StubApi imports it (ADR-0021 §4).',
      ],
    ]);
  });

  it('allows StubApi', async () => {
    const [r] = await eslint().lintText("import { prepare } from './stub/plan';\n", {
      filePath: 'src/api/StubApi.ts',
    });
    expect(r?.messages).toEqual([]);
  });
});
