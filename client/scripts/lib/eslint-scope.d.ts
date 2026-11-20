// Minimal types for eslint-scope 8 (the package ships none); the shapes are ESLint's own.
declare module 'eslint-scope' {
  import type { Scope } from 'eslint';

  export interface AnalyzeOptions {
    ecmaVersion?: number;
    sourceType?: 'script' | 'module';
    fallback?: 'iteration';
  }

  export function analyze(ast: object, options?: AnalyzeOptions): Scope.ScopeManager;
}
