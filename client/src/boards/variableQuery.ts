/**
 * A board variable's query on the client (plan #289 §3.3): `label_values(label)` or
 * `label_values(selector, label)`, read as the server's `varquery.Parse` reads it. The server
 * plans the selector; the client reads the label and the references.
 */
import type { QueryLang } from '../api/types';

export interface VariableQuery {
  readonly label: string;
  /** '' for the no-selector form. */
  readonly selector: string;
}

/** The query, or null when `text` is not a variable query of `lang`. */
export function parseVariableQuery(_lang: QueryLang | string, _text: string): VariableQuery | null {
  return null;
}
