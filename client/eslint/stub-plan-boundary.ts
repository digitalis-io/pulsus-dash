// The StubApi planner mirror's boundary (plan #112 §3.7, ADR-0021 §4): src/api/stub/{plan,
// promShape,promFunctions} mirror the server's planner for StubApi only, so nothing else may
// import them; in http mode every planning fact comes from the server's `planned`. A separate
// rule name from `no-restricted-imports`, so no other block overrides it.
import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

export const stubPlanBoundary: Linter.Config = {
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/api/StubApi.ts', 'src/api/stub/**'],
  plugins: { '@typescript-eslint': tseslint.plugin },
  rules: {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            regex: '(^|/)stub/(plan|promShape|promFunctions)(\\.ts)?$',
            message:
              'api/stub/plan is the StubApi planner mirror: only StubApi imports it (ADR-0021 §4).',
          },
        ],
      },
    ],
  },
};
