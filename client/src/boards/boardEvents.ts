/** The board's event markers (plan #64 Part C §3.8). Stub until implemented. */
import { createContext } from 'react';
import type { EventMarker } from '../engine/api';

export interface BoardEvents {
  readonly markers: readonly EventMarker[];
  readonly truncated: boolean;
  readonly failed: boolean;
}

export const NO_EVENTS: BoardEvents = Object.freeze({
  markers: Object.freeze([]) as readonly EventMarker[],
  truncated: false,
  failed: false,
});

export const BoardEventsContext = createContext<BoardEvents>(NO_EVENTS);

export function useBoardEvents(_tenant: string, _enabled: boolean): BoardEvents {
  return NO_EVENTS;
}
