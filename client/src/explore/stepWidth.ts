/**
 * The width sent with a log run, held per grid step (plan #66 Part C §3.6): a resize within one
 * step keeps the value, so it changes no request key; a resize to another step replaces it.
 */
export interface StepWidth {
  readonly stepMs: number;
  /** Sent as `width_px`: the width last seen when the step changed. */
  readonly widthPx: number;
}

/**
 * `widthPx` null → `prev`. `promGrid(w.fromMs, w.toMs, widthPx)` null → null. The same `stepMs` as
 * `prev` → `prev` (the same object). Otherwise `{ stepMs, widthPx }`.
 */
export function stepWidth(
  _prev: StepWidth | null,
  _w: { readonly fromMs: number; readonly toMs: number },
  _widthPx: number | null,
): StepWidth | null {
  throw new Error('not implemented');
}

/** `stepWidth` over the previous render's value (state updated during render, as `useExploreRun`'s `last`). */
export function useStepWidth(
  _w: { readonly fromMs: number; readonly toMs: number },
  _widthPx: number | null,
): StepWidth | null {
  throw new Error('not implemented');
}
