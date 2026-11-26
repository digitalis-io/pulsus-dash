import type { Rolldown } from 'vite';

/** The geo-assets entry (vite.config.ts `input`): its own lazy entry, never in the initial group. */
export const GEO_ENTRY = /[\\/]src[\\/]vis[\\/]geo[\\/]urls\.ts$/;

/**
 * Plan #263: every module in the static closure of a user entry (`$initial`) is kept in one chunk,
 * which Rolldown folds into the `index` entry chunk. Without this group, Rolldown splits that
 * closure by importer set into about ten shared chunks, and each one is compressed on its own.
 * The `geo-assets` entry stays out: captured, it would take `index.html`'s place as the entry
 * (`missing-artefact:index.html`) and stop being the separate lazy entry `ci:bundle-size` requires.
 */
export const INITIAL_GROUP: Rolldown.CodeSplittingGroup = {
  name: 'shell',
  tags: ['$initial'],
  test: (id: string) => !GEO_ENTRY.test(id),
};
