/** A list widget's table and CSV (plan #216 Part 1 §3.6; T24-026, T22-013). */
import { csvCell } from '../../data/csv';

export interface ListTable {
  readonly columns: readonly string[];
  readonly rows: readonly { readonly key: string; readonly cells: readonly string[] }[];
}

/** RFC 4180: the header, then one line per row, each cell through `csvCell`, CRLF (as `panelCsv`). */
export function listCsv(t: ListTable): string {
  const line = (cells: readonly string[]): string => `${cells.map(csvCell).join(',')}\r\n`;
  return line(t.columns) + t.rows.map((r) => line(r.cells)).join('');
}
