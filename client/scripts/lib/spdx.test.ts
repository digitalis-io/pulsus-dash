import { describe, expect, it } from 'vitest';
import { satisfies } from './spdx.ts';

const licences = new Set(['MIT', 'Apache-2.0']);
const none = new Set<string>();
const llvm = new Set(['Apache-2.0 WITH LLVM-exception']);

describe('spdx', () => {
  it.each([
    ['MIT', true],
    ['MIT+', true],
    ['(MIT OR GPL-3.0-only)', true],
    ['MIT AND GPL-2.0-only', false],
    ['(MIT AND (Apache-2.0 OR GPL-2.0-only))', true],
    ['MIT WITH Unapproved-exception', false],
    ['Apache-2.0 WITH LLVM-exception', false],
    ['GPL-2.0-only WITH Classpath-exception-2.0', false],
    ['mit or isc', false],
    ['MIT OR', false],
    ['LicenseRef-x', false],
    ['SEE LICENSE IN x', false],
    ['', false],
  ])('%s → %s (no exceptions)', (expr, want) => {
    expect(satisfies(expr, licences, none)).toBe(want);
  });

  it('WITH needs the exact pair in the exception allowlist', () => {
    expect(satisfies('Apache-2.0 WITH LLVM-exception', licences, llvm)).toBe(true);
    expect(satisfies('MIT WITH Unapproved-exception', licences, llvm)).toBe(false);
  });
});
