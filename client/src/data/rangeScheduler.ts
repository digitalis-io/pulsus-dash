/** Stub (tests first, #304). */
export type RangeClass = 'interactive' | 'refine' | 'prefetch' | 'background';
export type FetchPriority = 'high' | 'auto' | 'low';
export const MAX_IN_FLIGHT = 6;
export const MAX_LOW_IN_FLIGHT = 4;
export interface Job {
  readonly key: string;
  cls: RangeClass;
  readonly run: (signal: AbortSignal, priority: FetchPriority) => Promise<void>;
}
export interface Scheduler {
  submit(job: Job): void;
  upgrade(key: string, cls: RangeClass): void;
  cancel(key: string): void;
  has(key: string): boolean;
  exec<T>(signal: AbortSignal | undefined, f: (s: AbortSignal, p: 'high') => Promise<T>): Promise<T>;
  stats(): { readonly inFlight: number; readonly lowInFlight: number; readonly queued: number };
}
export function createScheduler(): Scheduler {
  return {
    submit: () => undefined,
    upgrade: () => undefined,
    cancel: () => undefined,
    has: () => false,
    exec: (_s, f) => f(new AbortController().signal, 'high'),
    stats: () => ({ inFlight: 0, lowInFlight: 0, queued: 0 }),
  };
}
