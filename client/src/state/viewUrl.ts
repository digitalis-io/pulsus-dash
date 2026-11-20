// Stub for the tests-first commit: the implementation follows.
/**
 * View URLs: route plus time Context (02 §4 patterns, time subset; T08-005, IA-023).
 */
import { type ContextSearch } from './contextSearch';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export type AppRoute =
  | {
      page: 'boards' | 'exploreMetrics' | 'exploreLogs' | 'admin';
      tenant: string;
    }
  | {
      page: 'board';
      tenant: string;
      uid: string;
    };

export interface ViewUrl {
  route: AppRoute;
  context: ContextSearch;
}

export const TENANT_PATTERN: RegExp = notImplemented();

export const UID_PATTERN: RegExp = notImplemented();

export function routePath(route: AppRoute): string {
  throw new Error('not implemented');
}

export function printViewUrl(v: ViewUrl): string {
  throw new Error('not implemented');
}

export function parseViewUrl(pathAndSearch: string, nowMs: number, tz: string): ViewUrl | null {
  throw new Error('not implemented');
}

export function buildShareUrl(
  origin: string,
  v: ViewUrl,
  o: {
    keepRelative: boolean;
    anchorMs: number;
    timeZone: string;
  },
): string {
  throw new Error('not implemented');
}
