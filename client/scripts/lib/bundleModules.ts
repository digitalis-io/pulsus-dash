// STUB (tests first, plan #198 Part 2a): replaced by the implementation.
import type { Finding } from './report.ts';

export interface ModuleFinding extends Finding {
  chunk: string;
  module: string;
}
export const FORBIDDEN_MODULES: readonly RegExp[] = [];
export function forbiddenModules(
  _chunks: Readonly<Record<string, readonly string[]>>,
): ModuleFinding[] {
  return [];
}
