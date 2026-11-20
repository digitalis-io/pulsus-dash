// Stub for the tests-first commit: the implementation follows.
import type { ESLint } from 'eslint';

const plugin = { meta: { name: 'tokens' }, rules: {} } satisfies ESLint.Plugin;

export const TOKEN_RULE_IDS: string[] = [];

export default plugin;
