/** LogQL completion (plan #66 Part A §3.5). Stub: not implemented yet. */
import type { Completion, CompletionContext, CompletionSource } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { CompletionTiming } from '../../view';
import type { LogSource } from '../types';
import type { LogCaretContext } from './context';

export const LOGQL_DURATIONS: readonly string[] = Object.freeze([
  '1m',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
  '6h',
  '12h',
  '24h',
]);
export const REMOTE_DEBOUNCE_MS = 120;
export const LOGQL_COMPLETION: CompletionTiming = { typingDelayMs: 0, slots: 2 };

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export function escapeDoubleQuoted(_v: string): string {
  return notImplemented();
}
export function logqlLocalSource(): CompletionSource {
  return notImplemented();
}
export function logqlRemoteSource(_source: LogSource, _lookups: RemoteLookups): CompletionSource {
  return notImplemented();
}
export function lookupKeyOf(_c: LogCaretContext): string | null {
  return notImplemented();
}
export class RemoteLookups {
  readonly pendingKey: string | null = null;
  signalFor(_key: string): AbortSignal {
    return notImplemented();
  }
  settled(_signal: AbortSignal): void {
    notImplemented();
  }
  retain(_key: string | null): void {
    notImplemented();
  }
  abort(): void {
    notImplemented();
  }
}
export function remoteLookupsPlugin(_lookups: RemoteLookups): Extension {
  return notImplemented();
}
export function afterQuiet(_ctx: CompletionContext, _ms: number): Promise<boolean> {
  return notImplemented();
}
export function replacing(_text: string, _kind: LogCaretContext['kind']): Completion['apply'] {
  return notImplemented();
}
