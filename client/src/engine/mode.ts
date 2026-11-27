/**
 * The page's engine mode (plan #68 C2d2 §3.3, §4.4), apart from the engine so the shell's banner
 * does not pull the engine modules into the initial JS: `engine/index.ts` sets it when the first
 * frame booted (or failed to boot) an engine, and re-exports the readers.
 */
import type { StReason } from './select';

/** The page's engine mode (plan #68 C2d2 §3.3). */
export type EngineMode =
  | { readonly mode: 'mt' }
  | { readonly mode: 'st'; readonly reason: StReason }
  | { readonly mode: 'canvas2d' };

let mode: EngineMode | null = null;
const modeListeners = new Set<(m: EngineMode | null) => void>();

export function setMode(m: EngineMode): void {
  if (mode !== null && mode.mode === m.mode) return;
  mode = m;
  // After the current task's work (a frame may be created inside a render): the listeners re-read.
  queueMicrotask(() => {
    for (const cb of [...modeListeners]) cb(m);
  });
}

/** The page's engine mode; null before the first frame. */
export function engineMode(): EngineMode | null {
  return mode;
}

/** Calls `cb` on each change of `engineMode()`; returns the unsubscription. */
export function onEngineMode(cb: (m: EngineMode | null) => void): () => void {
  modeListeners.add(cb);
  return () => {
    modeListeners.delete(cb);
  };
}
