// Stub for the tests-first commit: the implementation follows.
import { type Finding } from './lib/report.ts';

export interface OriginContext {
  allow: ReadonlySet<string>;
  used: Set<string>;
}

export function urlTokens(text: string): {
  token: string;
  index: number;
  end: number;
}[] {
  throw new Error('not implemented');
}

export function checkJs(
  file: string,
  text: string,
  ctx: OriginContext | null,
  lineOffset?: number,
): Finding[] {
  throw new Error('not implemented');
}

export function checkCss(file: string, text: string, lineOffset?: number): Finding[] {
  throw new Error('not implemented');
}

export function checkHtml(file: string, text: string, ctx: OriginContext | null): Finding[] {
  throw new Error('not implemented');
}

export function checkOrigins(
  dist: string,
  allowlist: readonly {
    url: string;
  }[],
  warnUnused?: boolean,
): Finding[] {
  throw new Error('not implemented');
}
