/**
 * The board's mode for the panels' Edit-only chrome (#111): the drag handle on the header and the
 * Move or resize tool. Only those small components read it, so entering or leaving Edit mode
 * renders no `PanelFrame` (its body and chart frame stay as they are).
 */
import { createContext } from 'react';

export type BoardMode = 'view' | 'edit';

export const BoardModeContext = createContext<BoardMode>('view');
