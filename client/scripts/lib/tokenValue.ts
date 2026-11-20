// Stub for the tests-first commit: the implementation follows.
/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export type TokenRule = 'state-token' | 'colour-literal' | 'size-literal' | 'duration-literal';

export const TOKEN_RULES: readonly TokenRule[] = notImplemented();

export const STATE_TOKENS: ReadonlySet<string> = notImplemented();

export const STATE_NAMES: ReadonlySet<string> = notImplemented();

export function classifyValue(value: string): Set<TokenRule> {
  throw new Error('not implemented');
}

export const TOKEN_MESSAGES: Readonly<Record<TokenRule, string>> = notImplemented();
