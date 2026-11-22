/**
 * The board's shared viewport tracker (plan #64 §3.4, A.14; T07-012 v1): one IntersectionObserver
 * for every panel of the board (root the viewport, since the document scrolls; `rootMargin` 0, so
 * nothing is prefetched). Where the browser has no IntersectionObserver every panel is visible.
 */
import { useContext, useEffect, useState } from 'react';
import { ALWAYS_VISIBLE_TRACKER, BoardRunContext } from './boardRunContext';

export interface VisibilityTracker {
  /** Calls `cb` on every change; `true` at once when IntersectionObserver is absent. */
  observe(el: Element, cb: (visible: boolean) => void): () => void;
  disconnect(): void;
}

/** Every target visible at once: no IntersectionObserver. */
export const ALWAYS_VISIBLE: VisibilityTracker = ALWAYS_VISIBLE_TRACKER;

/** One IntersectionObserver: root null (the viewport), rootMargin '0px', threshold 0. */
export function createVisibilityTracker(): VisibilityTracker {
  const IO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver;
  if (typeof IO !== 'function') return ALWAYS_VISIBLE;
  const targets = new Map<Element, (visible: boolean) => void>();
  const io = new IO(
    (entries) => {
      for (const e of entries) targets.get(e.target)?.(e.isIntersecting);
    },
    { root: null, rootMargin: '0px', threshold: 0 },
  );
  return {
    observe(el, cb) {
      targets.set(el, cb);
      io.observe(el);
      return () => {
        if (targets.get(el) === cb) targets.delete(el);
        io.unobserve(el);
      };
    },
    disconnect() {
      targets.clear();
      io.disconnect();
    },
  };
}

/** false until the first report; true when the observer is absent. */
export function useInViewport(el: Element | null): boolean {
  const { visibility } = useContext(BoardRunContext);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (el === null) return;
    return visibility.observe(el, setVisible);
  }, [el, visibility]);
  return visible;
}
