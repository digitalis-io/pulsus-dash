/**
 * The query size cap (T09-015; plan #63 Part B §3.5): 128 KB of UTF-8. Above it the editor pauses
 * completion and the page refuses Run with `explore.error.queryTooLarge` (Part C).
 */

export const QUERY_BYTE_LIMIT = 131_072;

export function queryBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * `queryBytes(text) > QUERY_BYTE_LIMIT`. A UTF-16 unit is at least one byte and at most three, so
 * up to a third of the limit in units is under it, and more units than the limit is over it.
 */
export function overQueryLimit(text: string): boolean {
  if (text.length * 3 <= QUERY_BYTE_LIMIT) return false;
  if (text.length > QUERY_BYTE_LIMIT) return true;
  return queryBytes(text) > QUERY_BYTE_LIMIT;
}
