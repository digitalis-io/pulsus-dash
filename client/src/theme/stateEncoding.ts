// Stub for the tests-first commit: the implementation follows.
/**
 * The only TypeScript path to the state colours (T02-004). Each state has a glyph and a label as well
 * as a colour (T02 §4), so state is never shown by colour alone. Unused by pages until state views
 * arrive.
 */
import type { MessageId } from '../i18n/t';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export type State = 'ok' | 'watch' | 'degraded' | 'failing' | 'unknown';

export interface StateStyle {
  readonly className: string;
  readonly glyph: '●' | '◐' | '◉' | '■' | '○';
  readonly label: MessageId;
}

export const StateEncoding: Readonly<Record<State, StateStyle>> = notImplemented();
