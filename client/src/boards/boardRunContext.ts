/**
 * The board run context (plan #64 §3.4, A.14): what every panel of one board shares. Its default,
 * outside a board, has no variables, keeps no widths, sees every panel and is time-ready. This
 * module has no run-time imports, so the hooks that read it and the provider that fills it do not
 * import each other.
 */
import { createContext } from 'react';
import type { WidthStore } from './panelWidths';
import type { VisibilityTracker } from './visibility';

export interface BoardRun {
  readonly vars: ReadonlyMap<string, string>;
  readonly widths: WidthStore;
  readonly visibility: VisibilityTracker;
  /** §4.6: false until the board's time is initialised. */
  readonly timeReady: boolean;
}

/** Every target visible at once: no IntersectionObserver. */
export const ALWAYS_VISIBLE_TRACKER: VisibilityTracker = Object.freeze({
  observe(_el: Element, cb: (visible: boolean) => void) {
    cb(true);
    return () => undefined;
  },
  disconnect: () => undefined,
});

/** Keeps nothing: outside a board no panel shares its width. */
const NO_WIDTHS: WidthStore = Object.freeze({
  get: () => null,
  set: () => undefined,
  subscribe: () => () => undefined,
});

export const BoardRunContext = createContext<BoardRun>({
  vars: new Map(),
  widths: NO_WIDTHS,
  visibility: ALWAYS_VISIBLE_TRACKER,
  timeReady: true,
});
