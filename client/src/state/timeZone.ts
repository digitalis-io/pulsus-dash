// Stub for the tests-first commit: the implementation follows.
/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export const TimeZoneContext: import('react').Context<string> = notImplemented();

export function useTimeZone(): string {
  throw new Error('not implemented');
}
