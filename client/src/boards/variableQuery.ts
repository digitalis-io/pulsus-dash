/**
 * A board variable's query on the client (plan #289 §3.3): `label_values(label)` or
 * `label_values(selector, label)`, read as the server's `varquery.Parse` reads it (Go = TS,
 * `unit:variable-query`). The server plans the selector; the client reads the label and the
 * references.
 */
export interface VariableQuery {
  readonly label: string;
  /** '' for the no-selector form. */
  readonly selector: string;
}

const MAX_LABEL_BYTES = 256;
const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** ASCII white space, as Go's `strings.Trim(s, " \t\n\r\f\v")`. */
const trim = (s: string): string => s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');

/**
 * The offset of the last `,` of `s` outside strings, braces and parentheses (-1 for none), or null
 * when a string, a brace or a parenthesis is not closed.
 */
function lastTopComma(s: string): number | null {
  let last = -1;
  let braces = 0;
  let parens = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      for (; j < s.length && s[j] !== c; j++) if (s[j] === '\\' && c !== '`') j++;
      if (j >= s.length) return null;
      i = j;
    } else if (c === '{') braces++;
    else if (c === '}') {
      if (braces === 0) return null;
      braces--;
    } else if (c === '(') parens++;
    else if (c === ')') {
      if (parens === 0) return null;
      parens--;
    } else if (c === ',' && braces === 0 && parens === 0) last = i;
  }
  return braces === 0 && parens === 0 ? last : null;
}

/** The query, or null when `text` is not a variable query of `lang`. */
export function parseVariableQuery(lang: string, text: string): VariableQuery | null {
  if (lang !== 'promql' && lang !== 'logql') return null;
  const s = trim(text);
  if (!s.startsWith('label_values')) return null;
  const rest = trim(s.slice('label_values'.length));
  if (rest.length < 2 || !rest.startsWith('(') || !rest.endsWith(')')) return null;
  const inner = rest.slice(1, -1);
  const comma = lastTopComma(inner);
  if (comma === null) return null;
  const q =
    comma < 0
      ? { label: trim(inner), selector: '' }
      : { selector: trim(inner.slice(0, comma)), label: trim(inner.slice(comma + 1)) };
  if (comma >= 0 && q.selector === '') return null;
  if (!LABEL.test(q.label) || new TextEncoder().encode(q.label).length > MAX_LABEL_BYTES) {
    return null;
  }
  return { label: q.label, selector: q.selector };
}
