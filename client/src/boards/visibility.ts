/** The board's shared viewport tracker (plan #64 §3.4, A.14; T07-012). */

export interface VisibilityTracker {
  /** Calls `cb` on every change; `true` at once when IntersectionObserver is absent. */
  observe(el: Element, cb: (visible: boolean) => void): () => void;
  disconnect(): void;
}

export function createVisibilityTracker(): VisibilityTracker {
  throw new Error('not implemented');
}

/** false until the first report; true when the observer is absent. */
export function useInViewport(_el: Element | null): boolean {
  return true;
}
