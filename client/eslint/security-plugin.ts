// STUB (tests first, plan #198 Part 2a): replaced by the implementation.
import type { ESLint, Rule } from 'eslint';

const none: Rule.RuleModule = {
  meta: { type: 'problem', schema: [] },
  create() {
    return {};
  },
};

const plugin = {
  meta: { name: 'security' },
  rules: { 'no-iframe': none, 'markdown-boundary': none },
} satisfies ESLint.Plugin;

export default plugin;
