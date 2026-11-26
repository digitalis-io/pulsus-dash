/** List tables (stub). */
export interface ListTable {
  readonly columns: readonly string[];
  readonly rows: readonly { readonly key: string; readonly cells: readonly string[] }[];
}

export function listCsv(_t: ListTable): string {
  return '';
}
