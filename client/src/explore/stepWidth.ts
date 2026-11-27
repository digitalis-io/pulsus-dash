/**
 * The width sent with a log run, held per grid step (plan #66 Part C §3.6): a resize within one
 * step keeps the value, so it changes no request key; a resize to another step replaces it.
 */
import { useState } from 'react';
import { logGrid } from '../data/step';

export interface StepWidth {
  readonly stepMs: number;
  /** Sent as `width_px`: the width last seen when the step changed. */
  readonly widthPx: number;
}

/**
 * `widthPx` null → `prev`. `logGrid(w.fromMs, w.toMs, widthPx)` null → null. The same `stepMs` as
 * `prev` → `prev` (the same object). Otherwise `{ stepMs, widthPx }`.
 */
export function stepWidth(
  prev: StepWidth | null,
  w: { readonly fromMs: number; readonly toMs: number },
  widthPx: number | null,
): StepWidth | null {
  if (widthPx === null) return prev;
  const g = logGrid(w.fromMs, w.toMs, widthPx);
  if (g === null) return null;
  if (prev?.stepMs === g.stepMs) return prev;
  return { stepMs: g.stepMs, widthPx };
}

/** `stepWidth` over the previous render's value (state updated during render, as `useExploreRun`'s `last`). */
export function useStepWidth(
  w: { readonly fromMs: number; readonly toMs: number },
  widthPx: number | null,
): StepWidth | null {
  const [prev, setPrev] = useState<StepWidth | null>(null);
  const next = stepWidth(prev, w, widthPx);
  if (next !== prev) setPrev(next);
  return next;
}
