/**
 * The completion lookup cache (plan #63 Part B §3.2, §4.1; D-LRU; T09-007, T09-014): at most
 * `maxKeys` entries, least recently got first out; a settled entry lives `ttlMs` from settle;
 * in-flight promises are shared; the in-flight lookup of each kind is tracked apart from the LRU,
 * so a superseded one is aborted even after eviction, and an evicted one is re-joined by its key.
 * Eviction never aborts. A generation counter, ended by a tenant switch or `clear()`, drops every
 * tracked call at once (callers reject `AbortError`, stuck requests included), and a call with an
 * ended token runs no `load`. Main-thread state only: every mutation is synchronous.
 */

export const SUGGEST_MAX_KEYS = 2_000;
export const SUGGEST_TTL_MS = 60_000;
/** 15 min (T09-007). */
export const WINDOW_BUCKET_MS = 900_000;

/** One per `PromSource` lookup method. */
export type SuggestKind = 'names' | 'labels' | 'values' | 'series';

export interface SuggestKeyParts {
  readonly tenant: string;
  readonly kind: SuggestKind;
  readonly label: string | null;
  readonly selector: string | null;
  readonly bucket: number;
}

/** `JSON.stringify([tenant, 'promql', kind, label, selector, bucket])`. */
export function suggestKey(p: SuggestKeyParts): string {
  return JSON.stringify([p.tenant, 'promql', p.kind, p.label, p.selector, p.bucket]);
}

export function windowBucket(toMs: number): number {
  return Math.floor(toMs / WINDOW_BUCKET_MS);
}

export interface SuggestCacheOptions {
  readonly maxKeys?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/** A generation token: the value of the cache's counter when the generation began. */
export type SuggestGeneration = number;

interface Entry {
  /** `null`, `null`: a `track` call. */
  readonly key: string | null;
  readonly kind: SuggestKind | null;
  /** The shared promise. */
  readonly promise: Promise<unknown>;
  readonly resolve: (v: unknown) => void;
  readonly reject: (x: unknown) => void;
  readonly controller: AbortController;
  settledAt: number | null;
  dropped: boolean;
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError');

function rejected<T>(): Promise<T> {
  const p = Promise.reject<T>(abortError());
  p.catch(() => undefined);
  return p;
}

export class SuggestCache {
  private readonly maxKeys: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Insertion order is recency. */
  private readonly entries = new Map<string, Entry>();
  /** Every unsettled, undropped call: held, evicted or tracked. */
  private readonly pending = new Set<Entry>();
  /** The last lookup started per kind; not pruned by eviction. */
  private readonly current = new Map<SuggestKind, Entry>();
  private retained: string | null = null;
  private gen: SuggestGeneration = 0;

  constructor(o: SuggestCacheOptions = {}) {
    this.maxKeys = o.maxKeys ?? SUGGEST_MAX_KEYS;
    this.ttlMs = o.ttlMs ?? SUGGEST_TTL_MS;
    this.now = o.now ?? Date.now;
  }

  /**
   * The cached or in-flight promise for `p`, else `load(signal)`. Rejects as `load` does, or
   * `AbortError` at once when the entry is dropped (superseded, generation ended), or at once
   * without calling `load` when `g` is not the current generation or `p.tenant` not its tenant.
   */
  get<T>(
    g: SuggestGeneration,
    p: SuggestKeyParts,
    load: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (g !== this.gen || p.tenant !== this.retained) return rejected<T>();
    const k = suggestKey(p);
    const t = this.now();
    const c = this.current.get(p.kind);
    if (c !== undefined && this.pending.has(c)) {
      if (c.key !== k) this.drop(c);
      else {
        if (this.entries.get(k) !== c) {
          this.entries.set(k, c);
          this.evict();
        }
        return c.promise as Promise<T>;
      }
    }
    const e = this.entries.get(k);
    if (e !== undefined) {
      if (this.pending.has(e) || (e.settledAt !== null && t - e.settledAt < this.ttlMs)) {
        this.entries.delete(k);
        this.entries.set(k, e);
        return e.promise as Promise<T>;
      }
      this.entries.delete(k);
    }
    const en = this.start(k, p.kind, load);
    this.entries.set(k, en);
    this.current.set(p.kind, en);
    this.evict();
    return en.promise as Promise<T>;
  }

  /** An uncached call tracked like an in-flight entry: never shared or evicted; dropped when its generation ends. */
  track<T>(g: SuggestGeneration, load: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (g !== this.gen) return rejected<T>();
    return this.start(null, null, load).promise as Promise<T>;
  }

  /**
   * The same tenant joins the current generation; another ends it (every call is aborted and its
   * callers reject `AbortError` at once, T09-014) and starts a new one, whose token it returns.
   */
  retainTenant(tenant: string): SuggestGeneration {
    if (tenant === this.retained) return this.gen;
    this.end();
    this.retained = tenant;
    return this.gen;
  }

  /** Ends the generation; the retained tenant is kept. */
  clear(): void {
    this.end();
  }

  /** Entries held, expired ones included until swept. */
  get size(): number {
    return this.entries.size;
  }

  /** Held, without touching. */
  has(p: SuggestKeyParts): boolean {
    return this.entries.has(suggestKey(p));
  }

  private start<T>(
    key: string | null,
    kind: SuggestKind | null,
    load: (signal: AbortSignal) => Promise<T>,
  ): Entry {
    let resolve: (v: unknown) => void = () => undefined;
    let reject: (x: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A drop with no caller attached reports no unhandled rejection; callers still see it.
    promise.catch(() => undefined);
    const en: Entry = {
      key,
      kind,
      promise,
      resolve,
      reject,
      controller: new AbortController(),
      settledAt: null,
      dropped: false,
    };
    this.pending.add(en);
    let raw: Promise<T>;
    try {
      raw = load(en.controller.signal);
    } catch (x) {
      raw = Promise.reject(x instanceof Error ? x : new Error(String(x)));
    }
    raw.then(
      (v) => {
        if (en.dropped) return;
        this.pending.delete(en);
        if (key !== null && this.entries.get(key) === en) en.settledAt = this.now();
        en.resolve(v);
      },
      (x: unknown) => {
        if (en.dropped) return;
        this.pending.delete(en);
        if (key !== null && this.entries.get(key) === en) this.entries.delete(key);
        en.reject(x);
      },
    );
    return en;
  }

  /** Least recent out of `entries` only: never aborted, never dropped, `current` untouched. */
  private evict(): void {
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      this.entries.delete(oldest.value);
    }
  }

  private drop(en: Entry): void {
    if (en.dropped) return;
    en.dropped = true;
    this.pending.delete(en);
    if (en.key !== null && this.entries.get(en.key) === en) this.entries.delete(en.key);
    en.reject(abortError());
    en.controller.abort();
  }

  private end(): void {
    this.gen += 1;
    for (const en of [...this.pending]) this.drop(en);
    this.entries.clear();
    this.current.clear();
  }
}

/** The module-level instance (T09 §0 row "Editor-worker suggest cache"). */
export const suggestCache = new SuggestCache();
