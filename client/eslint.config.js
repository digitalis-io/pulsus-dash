// ESLint flat config (ADR-0014 §6, `ci:lint-ts`).
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { stubPlanBoundary } from './eslint/stub-plan-boundary.ts';
import security from './eslint/security-plugin.ts';
import tokens from './eslint/tokens-plugin.ts';

const LAYOUT_PROPS = ['offset', 'crossOffset', 'containerPadding', 'delay', 'closeDelay'];

const URL_SEARCH_IMPORTS = {
  name: 'react-router',
  importNames: ['useSearchParams', 'createSearchParams'],
  message: 'Read and write the URL search only through src/state/ (contextSearch.ts).',
};

// The query languages of T09 §5.1: no `src/editor/lang/<id>/` imports another (ADR-0018).
const LANG_IDS = ['promql', 'logql', 'traceql', 'profile'];

const languageIsolation = LANG_IDS.map((lang) => {
  const others = LANG_IDS.filter((o) => o !== lang).join('|');
  return {
    files: [`src/editor/lang/${lang}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [URL_SEARCH_IMPORTS],
          patterns: [
            {
              regex: `^(\\.\\./)+(${others})(/|$)|(^|/)lang/(${others})(/|$)`,
              message: `lang/${lang} imports no other language directory (ADR-0018, T09-001).`,
            },
          ],
        },
      ],
    },
  };
});

const bannedSyntax = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is banned (T18-004).',
  },
  {
    selector: "JSXAttribute[name.name='style']",
    message: 'No inline styles: use a CSS module and tokens (T01-010, CSP style-src).',
  },
  ...LAYOUT_PROPS.map((name) => ({
    selector: `JSXAttribute[name.name='${name}'] > JSXExpressionContainer > Literal[value=/./]`,
    message: `Use a token from styles/tokens.ts for ${name} (T01-010).`,
  })),
  ...LAYOUT_PROPS.map((name) => ({
    selector: `JSXAttribute[name.name='${name}'] > JSXExpressionContainer > UnaryExpression > Literal`,
    message: `Use a token from styles/tokens.ts for ${name} (T01-010).`,
  })),
  {
    selector:
      'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
    message: 'innerHTML/outerHTML assignment is banned (Trusted Types, T18-004).',
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'insertAdjacentHTML is banned (Trusted Types, T18-004).',
  },
  {
    selector: "CallExpression[callee.property.name='setAttribute'][arguments.0.value='style']",
    message: "setAttribute('style', …) is banned (CSP style-src).",
  },
  { selector: "NewExpression[callee.name='Function']", message: 'new Function is banned.' },
  { selector: "CallExpression[callee.name='eval']", message: 'eval is banned.' },
  {
    selector:
      "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: 'document.write is banned.',
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist',
      'dist-http',
      'node_modules',
      'scripts/__fixtures__',
      'src/api/gen',
      'src/engine/wasm/gen',
      'src/engine/wasm/gen-probe',
      'src/engine/wasm/gen-st',
      'src/engine/wasm/gen-st-probe',
      'src/engine/wasm/dash_core_mt.d.ts',
      'src/engine/wasm/dash_core_st.d.ts',
      'src/engine/wasm/layout.gen.ts',
      'dist-release',
      'dist-release-stub',
      'dist-release-http',
      'dist-probe',
      'src/styles/tokens.ts',
      'test-results',
      'test-results-*',
      'playwright-report',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: { globals: globals.browser },
  },
  { files: ['src/**/*.tsx'], ...jsxA11y.flatConfigs.strict },
  {
    files: ['src/**/*.tsx'],
    // React Aria components (ListBox, Dialog) manage focus on open; DOM elements may not autofocus.
    rules: { 'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }] },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    plugins: { tokens },
    rules: Object.fromEntries(Object.keys(tokens.rules).map((r) => [`tokens/${r}`, 'error'])),
  },
  // ci:no-iframe and the ADR-0024 import boundary (plan #198 Part 2a §3.5): own rule names, so no
  // `no-restricted-*` block below overrides them.
  {
    files: ['src/**/*.{ts,tsx}', 'e2e/**/*.{ts,tsx}'],
    plugins: { security },
    rules: { 'security/no-iframe': 'error', 'security/no-html-sink': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { security },
    rules: { 'security/markdown-boundary': 'error' },
  },
  {
    files: ['scripts/**/*.ts', 'eslint/**/*.ts', 'config/**/*.ts', 'e2e/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...bannedSyntax],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // React Router loaders throw `replace()` responses and `data()` error responses.
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'lib', name: 'Response' },
            { from: 'package', package: 'react-router', name: 'DataWithResponseInit' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/state/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [URL_SEARCH_IMPORTS],
        },
      ],
    },
  },
  ...languageIsolation,
  // T03-001 (plan #68 C1 §2): the engine adapter imports only the seam, its own modules and the
  // generated glue.
  {
    files: ['src/engine/wasm/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [URL_SEARCH_IMPORTS],
          patterns: [
            {
              regex: '^(?!\\.\\./api$|\\./[^/]+$|virtual:dash-engine(?:-st)?$)',
              message:
                'src/engine/wasm/ imports only ../api, its own modules and virtual:dash-engine(-st) (T03-001).',
            },
          ],
        },
      ],
    },
  },
  // ADR-0026: the `pulsus-engine` Trusted Types policy is created in src/engine/wasm/workers.ts only.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/engine/wasm/workers.ts', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...bannedSyntax,
        {
          selector: "CallExpression[callee.property.name='createPolicy']",
          message:
            'Trusted Types policies are created in src/engine/wasm/workers.ts only (ADR-0026).',
        },
      ],
    },
  },
  stubPlanBoundary,
  {
    files: ['e2e/keyboard.spec.ts', 'e2e/keyboardScript.ts', 'e2e/keyboardBoards.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...bannedSyntax,
        {
          selector: 'CallExpression[callee.property.name=/^(press|click|fill|type)$/]',
          message: 'Keyboard script: input only through keyboardCoverage.ts (press, type).',
        },
        {
          selector: "MemberExpression[object.name='page'][property.name='mouse']",
          message: 'Keyboard script: no mouse input.',
        },
      ],
    },
  },
);
