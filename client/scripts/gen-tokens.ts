// Stub for the tests-first commit: the implementation follows.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Finding } from './lib/report.ts';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const TOKENS_TOML = join(CLIENT_ROOT, '..', 'design', 'tokens.toml');

export const TOKENS_CSS = join(CLIENT_ROOT, 'src', 'styles', 'tokens.css');

export const TOKENS_TS = join(CLIENT_ROOT, 'src', 'styles', 'tokens.ts');

type Table = Record<string, unknown>;

export interface Tokens {
  colour: {
    dark: Record<string, string>;
    light: Record<string, string>;
  };
  space: Record<string, number>;
  size: Record<string, number>;
  radius: Record<string, number>;
  border: Record<string, number>;
  font: {
    family: Record<string, string>;
    size: Record<string, number>;
    weight: Record<string, number>;
    lineHeight: Record<string, number>;
  };
  motion: Record<string, number | string>;
}

export function parseTokens(tomlText: string): Tokens {
  throw new Error('not implemented');
}

export function generateCss(tk: Tokens, root: Table): string {
  throw new Error('not implemented');
}

export function generateTs(tk: Tokens): string {
  throw new Error('not implemented');
}

export function generate(tomlText: string): {
  css: string;
  ts: string;
} {
  throw new Error('not implemented');
}

export function checkGenerated(): Finding[] {
  throw new Error('not implemented');
}

export function main(argv: readonly string[]): number {
  throw new Error('not implemented');
}

export {};
