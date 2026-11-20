// Stub for the tests-first commit: the implementation follows.
import { type Finding } from './lib/report.ts';

export interface Budgets {
  initialRouteModules: string[];
  required: {
    files: string[];
    lazyModules: string[];
    fonts: string[];
    initialCss: boolean;
  };
  budgets: Record<BudgetClass, number>;
  editorModules: string[];
}

export type BudgetClass =
  'initialJs' | 'initialCss' | 'lazyChunk' | 'editorChunk' | 'fonts' | 'totalExceptEngine';

export interface SizeRow {
  cls: BudgetClass;
  file: string;
  bytes: number;
  budget: number;
}

export function brotliSize(buf: Buffer): number {
  throw new Error('not implemented');
}

export function parseBudgets(v: unknown): Budgets {
  throw new Error('not implemented');
}

export interface BundleResult {
  findings: Finding[];
  rows: SizeRow[];
  /** 2 when dist/ or the manifest is unreadable. */
  exitCode: 0 | 1 | 2;
}

export function checkBundle(dist: string, budgetsJson: unknown): BundleResult {
  throw new Error('not implemented');
}

export function main(argv: readonly string[]): number {
  throw new Error('not implemented');
}
