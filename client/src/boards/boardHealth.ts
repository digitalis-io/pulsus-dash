/**
 * The board's health (#282 Part 2a §4.9): how many mounted board panels are failing. Stub.
 */
import { createContext } from 'react';

export interface BoardHealth {
  report(panelId: string, failing: boolean): void;
  forget(panelId: string): void;
}

export const BoardHealthContext = createContext<BoardHealth | null>(null);

const NONE: BoardHealth = {
  report: () => undefined,
  forget: () => undefined,
};

/** BoardPage: the store and the number of panels reported failing. */
export function useBoardHealthStore(): { readonly health: BoardHealth; readonly failing: number } {
  return { health: NONE, failing: 0 };
}

/** PanelFrame: reports on change, forgets on unmount; a no-op without a provider. */
export function useReportHealth(_panelId: string, _failing: boolean): void {
  // Stub.
}
