// stub (#231 tests first)
import type { Finding } from './lib/report.ts';
export function checkGeoData(root: string): Finding[] {
  void root;
  return [{ rule: 'not-implemented', file: 'tools/geo/manifest.json', message: 'stub' }];
}
export function main(argv: readonly string[]): number {
  void argv;
  return -1;
}
