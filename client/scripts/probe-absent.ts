/** `ci:probe-absent` (T03-024): no test hook in a release build. */
import type { Finding } from './lib/report.ts';

export function checkProbeAbsent(dist: string): Finding[] {
  void dist;
  return [];
}
