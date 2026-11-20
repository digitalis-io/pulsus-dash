// Stub for the tests-first commit: the implementation follows.
import { type Finding } from './lib/report.ts';

export function checkLockfile(pkgJson: unknown, lockJson: unknown): Finding[] {
  throw new Error('not implemented');
}

export function checkLockfileDir(dir: string): Finding[] {
  throw new Error('not implemented');
}
