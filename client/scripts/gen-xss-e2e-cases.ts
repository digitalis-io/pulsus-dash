/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation (tests first) */
/** Writes `e2e/fixtures/xss-e2e-cases.json` (#198 Part 3b): stub until the implementation. */
import { readFileSync } from 'node:fs';
import type { CorpusCase } from '../src/security/sanitise/xssCorpus.ts';
import type { E2eCase, SkipReason } from '../e2e/xssCases.ts';
import { CORPUS_FILE } from './gen-xss-corpus.ts';

export type CheckParamValue = (value: string) => string | null;

export function loadCheckParamValue(): Promise<CheckParamValue> {
  return Promise.resolve(() => null);
}

export function imagePaths(_c: CorpusCase): string[] {
  return [];
}

export function skipOf(_c: CorpusCase, _checkParamValue: CheckParamValue): SkipReason | null {
  return null;
}

export function corpusInput(file: string = CORPUS_FILE): CorpusCase[] {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { cases: CorpusCase[] };
  return doc.cases.map(({ id, group, src, vars, entity }) => ({ id, group, src, vars, entity }));
}

export function generate(_corpus: readonly CorpusCase[] = corpusInput()): Promise<E2eCase[]> {
  return Promise.resolve([]);
}

export function casesText(cases: readonly E2eCase[]): string {
  return `${JSON.stringify({ version: 1, cases }, null, 1)}\n`;
}

export function check(_committed: string, _fresh: readonly E2eCase[]): number {
  return 1;
}

export function main(_argv: readonly string[]): Promise<number> {
  return Promise.resolve(1);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
