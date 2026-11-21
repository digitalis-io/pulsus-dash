export const SUGGEST_MAX_KEYS = 2_000;
export const SUGGEST_TTL_MS = 60_000;
export const WINDOW_BUCKET_MS = 900_000;
export type SuggestKind = 'names' | 'labels' | 'values' | 'series';
export interface SuggestKeyParts {
  readonly tenant: string;
  readonly kind: SuggestKind;
  readonly label: string | null;
  readonly selector: string | null;
  readonly bucket: number;
}
export interface SuggestCacheOptions {
  readonly maxKeys?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}
export type SuggestGeneration = number;
const ni = (): never => {
  throw new Error('not implemented');
};
export function suggestKey(_p: SuggestKeyParts): string {
  return ni();
}
export function windowBucket(_toMs: number): number {
  return ni();
}
export class SuggestCache {
  constructor(_o?: SuggestCacheOptions) {}
  get<T>(
    _g: SuggestGeneration,
    _p: SuggestKeyParts,
    _load: (s: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return ni();
  }
  track<T>(_g: SuggestGeneration, _load: (s: AbortSignal) => Promise<T>): Promise<T> {
    return ni();
  }
  retainTenant(_t: string): SuggestGeneration {
    return ni();
  }
  clear(): void {
    ni();
  }
  get size(): number {
    return ni();
  }
  has(_p: SuggestKeyParts): boolean {
    return ni();
  }
}
export const suggestCache = new SuggestCache();
