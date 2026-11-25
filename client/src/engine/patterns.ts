/**
 * The one shared list of fill patterns and line dashes (T21-003, T21-014; T21 §5). Health states use
 * `solid` with the state glyph; categories take `CATEGORY_PATTERNS[j]` and `LINE_DASHES[j]` in order,
 * never repeated; the merged "other (n)" category takes `grid` and `OTHER_DASH`.
 */

/** Health states (with the state glyph). */
export const HEALTH_PATTERN = 'solid';
/** 7 category patterns, never repeated. */
export const CATEGORY_PATTERNS = [
  'backDiagonal',
  'horizontal',
  'vertical',
  'dots',
  'crossHatch',
  'checker',
  'dashes',
] as const;
/** The merged "other (n)" category. */
export const OTHER_PATTERN = 'grid';
/** Diagonal: Unknown and no data. */
export const NO_DATA_PATTERN = 'hatch';

/** Line dashes in CSS px, one per category (`[]` is solid). */
export const LINE_DASHES = [
  [],
  [6, 3],
  [2, 2],
  [8, 3, 2, 3],
  [1, 3],
  [10, 4],
  [4, 2, 1, 2, 1, 2],
] as const;
/** The dash of "other (n)". */
export const OTHER_DASH = [12, 3, 2, 3] as const;
