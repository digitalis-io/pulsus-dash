/**
 * The single decoder of query responses (ADR-0014 §5, T04-010): JSON frames from the BFF into
 * `SeriesFrame`s. Stub until #62 lands.
 */
import type { ScalarFrame, SeriesFrame } from './frames';

export interface Completeness {
  readonly truncated: boolean;
  readonly warnings: readonly string[];
  readonly infos: readonly string[];
  readonly queryId: string | null;
  readonly dataAgeMs: number | null;
  readonly readCache: 'hit' | 'miss' | 'bypass' | 'other' | null;
  readonly readCacheThroughMs: number | null;
}

export interface RangeResult {
  readonly startMs: number;
  readonly endMs: number;
  readonly stepMs: number;
  readonly series: readonly SeriesFrame[];
  readonly completeness: Completeness;
}

export type InstantResult = { readonly atMs: number; readonly completeness: Completeness } & (
  | {
      readonly kind: 'series';
      readonly resultType: 'vector' | 'matrix';
      readonly series: readonly SeriesFrame[];
    }
  | { readonly kind: 'scalar'; readonly scalar: ScalarFrame }
  | { readonly kind: 'string'; readonly value: string; readonly timestampMs: number }
);

export class DecodeError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'DecodeError';
    this.path = path;
  }
}

export function decodeValue(_v: unknown, path: string): number {
  throw new DecodeError(path, 'not implemented');
}

export function decodeRange(_body: unknown): RangeResult {
  throw new DecodeError('', 'not implemented');
}

export function decodeInstant(_body: unknown): InstantResult {
  throw new DecodeError('', 'not implemented');
}
