// Stub for the tests-first commit: the implementation follows.
import type { SidebarState } from './sidebarState';

export interface SidebarProps {
  state: SidebarState;
  onToggle: () => void;
}

export function Sidebar({ state, onToggle }: SidebarProps): import('react').JSX.Element {
  throw new Error('not implemented');
}
