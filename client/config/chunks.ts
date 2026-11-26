import type { Rolldown } from 'vite';

/** The geo-assets entry (vite.config.ts `input`): its own lazy entry, never in the initial group. */
export const GEO_ENTRY = /[\\/]src[\\/]vis[\\/]geo[\\/]urls\.ts$/;

/** Stub (#263 tests first). */
export const INITIAL_GROUP: Rolldown.CodeSplittingGroup = {
  name: 'shell',
  test: () => false,
};
