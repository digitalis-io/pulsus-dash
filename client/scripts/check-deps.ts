// Stub for the tests-first commit: the implementation follows.
import { type Finding } from './lib/report.ts';

export interface DependencyPolicy {
  forbiddenCategories: string[];
  runtimeAllowlist: string[];
  runtimeClosure: Record<string, string[]>;
  licenceAllowlist: string[];
  licenceExceptionAllowlist: string[];
  buildUrlAllowlist: {
    url: string;
    reason: string;
  }[];
  installScripts: string[];
}

export function parsePolicy(v: unknown): DependencyPolicy {
  throw new Error('not implemented');
}

export function runtimeClosure(lockJson: unknown): Map<string, unknown> {
  throw new Error('not implemented');
}

export function checkDeps(pkgJson: unknown, lockJson: unknown, policyJson: unknown): Finding[] {
  throw new Error('not implemented');
}

export function checkDepsDir(dir: string): Finding[] {
  throw new Error('not implemented');
}
