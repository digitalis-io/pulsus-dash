// Stub for the tests-first commit: the implementation follows.
/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export const RECENT_KEY: (tenant: string) => string = notImplemented();

export const RECENT_MAX = 5;

export function readRecent(storage: Storage | null, tenant: string): string[] {
  throw new Error('not implemented');
}

export function subscribeRecent(cb: () => void): () => void {
  throw new Error('not implemented');
}

export function pushRecent(storage: Storage | null, tenant: string, uid: string): string[] {
  throw new Error('not implemented');
}
