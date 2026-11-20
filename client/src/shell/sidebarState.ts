/** The sidebar's expanded/collapsed state, kept in `localStorage` (guarded; expanded by default). */
export type SidebarState = 'expanded' | 'collapsed';

export const SIDEBAR_KEY = 'pulsus-dash.sidebar';

export function readSidebarState(storage: Storage | null): SidebarState {
  try {
    return storage?.getItem(SIDEBAR_KEY) === 'collapsed' ? 'collapsed' : 'expanded';
  } catch {
    return 'expanded';
  }
}

export function writeSidebarState(storage: Storage | null, s: SidebarState): void {
  try {
    storage?.setItem(SIDEBAR_KEY, s);
  } catch {
    // Storage unavailable: the state lives for this page only.
  }
}
