// Stub for the tests-first commit: the implementation follows.
/** The sidebar's expanded/collapsed state, kept in `localStorage` (guarded; expanded by default). */
export type SidebarState = 'expanded' | 'collapsed';

export const SIDEBAR_KEY = 'pulsus-dash.sidebar';

export function readSidebarState(storage: Storage | null): SidebarState {
  throw new Error('not implemented');
}

export function writeSidebarState(storage: Storage | null, s: SidebarState): void {
  throw new Error('not implemented');
}
