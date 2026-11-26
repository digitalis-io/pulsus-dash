/** The active row of a list after a refresh (plan #216 Part 1 §4.3; T24-025). */

/**
 * The row to make active after the keys changed: the previous key at its new index; with no
 * previous key, the first row; else the row at the old index, clamped (`gone`: the previous row
 * left). An empty list has none (`index` −1; `gone` when there was a previous key).
 */
export function repairActive(
  prevKey: string | null,
  prevIndex: number,
  keys: readonly string[],
): { readonly key: string | null; readonly index: number; readonly gone: boolean } {
  if (keys.length === 0) return { key: null, index: -1, gone: prevKey !== null };
  if (prevKey === null) return { key: keys[0] ?? null, index: 0, gone: false };
  const at = keys.indexOf(prevKey);
  if (at >= 0) return { key: prevKey, index: at, gone: false };
  const index = Math.min(Math.max(prevIndex, 0), keys.length - 1);
  return { key: keys[index] ?? null, index, gone: true };
}
