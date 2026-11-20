// Stub for the tests-first commit: the implementation follows.
import { type Finding } from './lib/report.ts';

export function sourceFiles(root: string): string[] {
  throw new Error('not implemented');
}

export function lintCss(file: string, text: string): Finding[] {
  throw new Error('not implemented');
}

export function lintTs(root: string, files: readonly string[]): Promise<Finding[]> {
  throw new Error('not implemented');
}

export function lintTokens(rootDir: string): Promise<Finding[]> {
  throw new Error('not implemented');
}
