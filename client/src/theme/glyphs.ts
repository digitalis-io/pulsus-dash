/** The event-kind glyphs of the chart event labels (T02-008, ADR-0023): a note has none. */
import type { EventKind } from '../engine/api';

export const EventGlyph: Readonly<Record<EventKind, string | null>> = Object.freeze({
  deploy: '◆',
  config: '⚙',
  flag: '⚑',
  annotation: null,
});
