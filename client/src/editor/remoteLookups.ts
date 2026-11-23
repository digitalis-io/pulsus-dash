/**
 * The remote lookups of one editor view (plan #66 Part A §3.5, plan #107 §3.1; T09-007), shared by
 * the LogQL and PromQL completion slots. A remote slot waits 120 ms itself (`afterQuiet`, restarted
 * by every document change), and the fetch it starts belongs to the view's `RemoteLookups`: at
 * most one key and one `AbortController`. `remoteLookupsPlugin` releases the view's interest when
 * the caret's lookup key changes (LogQL keeps a same-key lookup; PromQL's `RELEASE_ON_CHANGE`
 * releases on every document or selection change), and on destroy. Releasing aborts only this
 * view's signal: the suggest cache aborts the request when no other holder remains. Main thread
 * only; every step is synchronous.
 */
import type { CompletionContext } from '@codemirror/autocomplete';
import type { EditorState, Extension } from '@codemirror/state';
import { ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** T09-007: a lookup starts 120 ms after the last keystroke. */
export const REMOTE_DEBOUNCE_MS = 120;

/** Over this many code units no lookup is kept (the guard's 128 KB of UTF-8 holds fewer). */
export const MAX_LOOKUP_DOC = 131_072;

/** The in-flight remote lookup of one view: at most one key, one AbortController. Main thread only. */
export class RemoteLookups {
  private key: string | null = null;
  private controller: AbortController | null = null;
  private users = 0;
  private gen = 0;
  private isClosed = false;

  get pendingKey(): string | null {
    return this.key;
  }

  /**
   * Aborts and forgets a pending lookup of another key; returns the pending controller's signal
   * for `key` (users + 1), or a new controller's (users = 1).
   */
  signalFor(key: string): AbortSignal {
    if (this.controller !== null && this.key === key) {
      this.users += 1;
      return this.controller.signal;
    }
    this.abort();
    const c = new AbortController();
    this.controller = c;
    this.key = key;
    this.users = 1;
    return c.signal;
  }

  /** users − 1 when `signal` is the pending one; at 0 the lookup is forgotten (not aborted). */
  settled(signal: AbortSignal): void {
    if (this.controller?.signal !== signal) return;
    this.users -= 1;
    if (this.users <= 0) this.forget();
  }

  /** Aborts and forgets the pending lookup unless its key is `key`. */
  retain(key: string | null): void {
    if (this.key !== null && this.key !== key) this.abort();
  }

  /** Aborts and forgets the pending lookup. */
  abort(): void {
    const c = this.controller;
    this.forget();
    c?.abort();
  }

  /** +1 on every document or selection change of the view, and on `close()`; starts at 0. */
  get epoch(): number {
    return this.gen;
  }

  /** `epoch + 1`. Called by the plugin on each document or selection change. */
  bump(): void {
    this.gen += 1;
  }

  /** `abort()`, `bump()`, and `closed = true`: the view is destroyed. */
  close(): void {
    this.abort();
    this.bump();
    this.isClosed = true;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** True while `epoch === e` and the view is not closed. */
  current(e: number): boolean {
    return !this.isClosed && this.gen === e;
  }

  private forget(): void {
    this.key = null;
    this.controller = null;
    this.users = 0;
  }
}

/**
 * Resolves true after `ms`, or at once when `ctx.explicit`; resolves false (timer cleared) when
 * CodeMirror aborts `ctx`, which it does on any document change (`onDocChange`).
 */
export function afterQuiet(ctx: CompletionContext, ms: number): Promise<boolean> {
  if (ctx.explicit) return Promise.resolve(true);
  if (ctx.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(true);
    }, ms);
    ctx.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { onDocChange: true },
    );
  });
}

/** The lookup key at `pos`, synchronously; null releases any pending lookup. */
export type LookupKeyAt = (state: EditorState, pos: number) => string | null;

/** PromQL's rule (#107): every document or selection change releases the view's interest. */
export const RELEASE_ON_CHANGE: LookupKeyAt = () => null;

/**
 * On every document or selection change: `bump()`; then, while a lookup is pending, above
 * `MAX_LOOKUP_DOC` code units it is aborted, else it is kept only while `keyAt` at the caret gives
 * its key. Destroy closes `lookups`.
 */
export function remoteLookupsPlugin(lookups: RemoteLookups, keyAt: LookupKeyAt): Extension {
  return ViewPlugin.define(() => ({
    update(u: ViewUpdate) {
      if (!(u.docChanged || u.selectionSet)) return;
      lookups.bump();
      if (lookups.pendingKey === null) return;
      if (u.state.doc.length > MAX_LOOKUP_DOC) {
        lookups.abort();
        return;
      }
      lookups.retain(keyAt(u.state, u.state.selection.main.head));
    },
    destroy() {
      lookups.close();
    },
  }));
}
