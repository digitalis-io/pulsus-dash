/**
 * `InspectorHost` (T25-001, T25-006, T25-007, T25-012; plan #192 §4.1, §4.2): one per page. It owns
 * the selection, the Inspector sheet and the page's one Esc ladder; kinds reach it only through
 * `useInspector()` (null without a host: kinds then neither inspect nor select).
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { BoardFilter } from '../state/boardParams';
import type { MemberList } from './members';
import type { InspectOrigin, InspectRequest, Selection, SelectionSource } from './types';

/** A kind's own Esc steps: the next step, or null when none applies. */
export interface EscapeProvider {
  pre(): (() => void) | null;
  post(): (() => void) | null;
}

export interface InspectorHostApi {
  inspect(r: InspectRequest): void;
  select(s: Selection | null, src: SelectionSource): void;
  /** Last wins; the disposer removes only its own entry. */
  registerMembers(panelId: string, r: (runId: string) => MemberList | null): () => void;
  resolveMembers(panelId: string, runId: string): MemberList | null;
  registerEscape(panelId: string, p: EscapeProvider): () => void;
}

export interface InspectorHostProps {
  readonly surface: 'board' | 'explore';
  /** Board `f=` in URL order; [] on Explore. */
  readonly filters: readonly BoardFilter[];
  /** Board: JSON of the panel's [query, vis], or null when it is gone; Explore: `q`. */
  readonly originKey: (panelId: string | null) => string | null;
  readonly onEditQuery: (o: InspectOrigin) => void;
  readonly children: ReactNode;
}

/** The host API; null without a host. Exported for kinds' tests. */
export const InspectorApiContext = createContext<InspectorHostApi | null>(null);
/** The page selection. Exported for kinds' tests. */
export const SelectionContext = createContext<Selection | null>(null);
const OriginContext = createContext<string | null>(null);

export function useInspector(): InspectorHostApi | null {
  return useContext(InspectorApiContext);
}

export function useSelection(): Selection | null {
  return useContext(SelectionContext);
}

/** The board panel the Inspector was opened from, for its outline (T25-014). */
export function useInspectedPanelId(): string | null {
  return useContext(OriginContext);
}

export function InspectorHost({ children }: InspectorHostProps) {
  return <>{children}</>;
}
