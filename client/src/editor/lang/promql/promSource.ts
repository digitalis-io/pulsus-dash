import type { LanguageDeps, PromSource } from '../types';

export const PROM_NAMES_LIMIT = 10_000;
export const PROM_LOOKUP_LIMIT = 1_000;
export type PromSourceDeps = LanguageDeps;
export function createPromSource(_d: PromSourceDeps): PromSource {
  throw new Error('not implemented');
}
