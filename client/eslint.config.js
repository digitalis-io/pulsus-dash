// ESLint flat config (ADR-0014 §6, `ci:lint-ts`).
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import tokens from './eslint/tokens-plugin.ts';

const LAYOUT_PROPS = ['offset', 'crossOffset', 'containerPadding', 'delay', 'closeDelay'];

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
      'src/styles/tokens.ts',
      'test-results',
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
          paths: [
            {
              name: 'react-router',
              importNames: ['useSearchParams', 'createSearchParams'],
              message: 'Read and write the URL search only through src/state/ (contextSearch.ts).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['e2e/keyboard.spec.ts'],
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
