import type { Finding } from './lib/report.ts';

// Stub (tests first, #130).
export function checkKeyboardCoverage(_parts: readonly unknown[], _project: string): Finding[] {
  return [{ rule: 'not-implemented', file: '', message: 'stub' }];
}

export function checkKeyboardCoverageDir(_dir: string, _project: string): Finding[] {
  return [{ rule: 'not-implemented', file: '', message: 'stub' }];
}
