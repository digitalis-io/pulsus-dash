import type { Finding } from './lib/report.ts';

// Stub (tests first, #130).
export function checkE2eComplete(
  _listed: unknown,
  _shards: readonly { name: string; report: unknown }[],
  _project: string,
): Finding[] {
  return [{ rule: 'not-implemented', file: '', message: 'stub' }];
}
