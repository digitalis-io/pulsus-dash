/** Stub (tests first, #304). */
import type { Api } from '../api/Api';
import type { TimeWindow } from '../engine/api';
import type { Run } from './buckets';
import type { RangeResult } from './decode';
import type { RangeClass, Scheduler } from './rangeScheduler';
import type { Grid } from './step';

export type { RangeClass };

export interface RangeIdentity {
  readonly tenant: string;
  readonly scope: string;
  readonly text: string;
  readonly vars: string;
  readonly rate: boolean;
  readonly rangeMs: number | null;
  readonly stepMs: number;
}

export interface RangeView {
  readonly id: RangeIdentity;
  readonly idKey: string;
  readonly grid: Grid;
  readonly visible: Run;
  readonly flanks: readonly Run[];
  readonly windowMs: number;
  readonly epoch: number;
  readonly anchorMs: number;
  readonly widthPx: number;
  readonly line: boolean;
}

export interface Assembled {
  readonly held: RangeResult;
  readonly visible: RangeResult;
  readonly fit: TimeWindow;
  readonly stale: readonly TimeWindow[];
  readonly rank: 0 | 1;
}

export class StoreBypass extends Error {
  constructor(message = 'range store: admission refused') {
    super(message);
    this.name = 'StoreBypass';
  }
}

export interface ScopeObservation {
  readonly epoch: string;
  readonly seq: number;
}

export interface RangeStore {
  load(owner: string, v: RangeView, signal?: AbortSignal): Promise<Assembled>;
  retain(owner: string, v: RangeView): void;
  release(owner: string): void;
  peek(v: RangeView): Assembled | null;
  peekFilled(v: RangeView): Assembled | null;
  staleSpans(v: RangeView): string;
  bypassed(idKey: string): boolean;
  scopeOf(tenant: string): string;
  leaseValid(tenant: string): boolean;
  observeScope(tenant: string, sc: ScopeObservation, atMs: number): void;
  dropTenant(tenant: string): void;
  tick(): void;
  subscribe(key: string, cb: () => void): () => void;
  stats(): {
    readonly bytes: number;
    readonly pinnedBytes: number;
    readonly assemblyBytes: number;
    readonly inFlight: number;
  };
  readonly scheduler: Scheduler;
}

export const STORE_BYTES = 128 << 20;
export const ASSEMBLY_BYTES = 64 << 20;
export const HELD_CELLS = 1 << 21;
export const LEASE_MS = 300_000;
export const SETTLED_MS = 300_000;
export const FADE_MS = 150;
export const COARSE_DEBOUNCE_MS = 120;

export interface StoreDeps {
  readonly api: Pick<Api, 'queryRange'>;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  readonly timers?: {
    set(f: () => void, ms: number): unknown;
    clear(h: unknown): void;
  };
}

export function identityKey(id: RangeIdentity): string {
  return JSON.stringify([id.tenant, id.scope, id.text, id.vars, id.rate, id.rangeMs, id.stepMs]);
}

export function familyKey(_id: RangeIdentity): string {
  return '';
}

/** A segment's part of a stitched span. */
export interface Part {
  readonly k0: number;
  readonly k1: number;
  readonly result: RangeResult;
}

export function stitch(_parts: readonly Part[], _k0: number, _k1: number, _stepMs: number): RangeResult {
  throw new Error('stub');
}

export function createRangeStore(d: StoreDeps): RangeStore {
  const scheduler = d.scheduler;
  return {
    load: () => Promise.reject(new Error('stub')),
    retain: () => undefined,
    release: () => undefined,
    peek: () => null,
    peekFilled: () => null,
    staleSpans: () => '[]',
    bypassed: () => false,
    scopeOf: () => '',
    leaseValid: () => true,
    observeScope: () => undefined,
    dropTenant: () => undefined,
    tick: () => undefined,
    subscribe: () => () => undefined,
    stats: () => ({ bytes: 0, pinnedBytes: 0, assemblyBytes: 0, inFlight: 0 }),
    get scheduler(): Scheduler {
      if (scheduler === undefined) throw new Error('stub');
      return scheduler;
    },
  };
}
