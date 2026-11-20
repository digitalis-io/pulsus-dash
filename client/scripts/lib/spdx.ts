/**
 * SPDX licence expressions (ADR-0014 §7):
 *   expr := and ('OR' and)*      and := term ('AND' term)*
 *   term := lic ['WITH' exc] | '(' expr ')'      lic := id ['+']
 * Operators are upper-case only. `OR` holds if any side holds, `AND` if every side does. `lic`
 * holds iff its id is in `licences` (`X+` may be used as `X`). `lic WITH exc` holds iff the exact
 * string "<id> WITH <exc>" is in `exceptions`; the base licence alone never suffices.
 * `LicenseRef-*`, `DocumentRef-*`, `SEE LICENSE IN …`, empty input and parse errors are false.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/;

class ParseError extends Error {}

function tokenize(expr: string): string[] {
  return expr
    .replace(/\(/g, ' ( ')
    .replace(/\)/g, ' ) ')
    .trim()
    .split(/\s+/)
    .filter((x) => x !== '');
}

export function satisfies(
  expr: string,
  licences: ReadonlySet<string>,
  exceptions: ReadonlySet<string>,
): boolean {
  const tokens = tokenize(expr);
  if (tokens.length === 0) return false;
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const next = (): string => {
    const tok = tokens[i++];
    if (tok === undefined) throw new ParseError('unexpected end');
    return tok;
  };

  const lic = (id: string): boolean => {
    if (!ID.test(id) || id === 'AND' || id === 'OR' || id === 'WITH') throw new ParseError(id);
    if (id.startsWith('LicenseRef-') || id.startsWith('DocumentRef-')) return false;
    const base = id.endsWith('+') ? id.slice(0, -1) : id;
    return licences.has(base);
  };

  const term = (): boolean => {
    const tok = next();
    if (tok === '(') {
      const v = parseExpr();
      if (next() !== ')') throw new ParseError('expected )');
      return v;
    }
    if (tok === ')') throw new ParseError('unexpected )');
    const holds = lic(tok);
    if (peek() === 'WITH') {
      next();
      const exc = next();
      if (!ID.test(exc) || exc.endsWith('+')) throw new ParseError(exc);
      return exceptions.has(`${tok} WITH ${exc}`);
    }
    return holds;
  };

  const and = (): boolean => {
    let v = term();
    while (peek() === 'AND') {
      next();
      const r = term();
      v = v && r;
    }
    return v;
  };

  function parseExpr(): boolean {
    let v = and();
    while (peek() === 'OR') {
      next();
      const r = and();
      v = v || r;
    }
    return v;
  }

  try {
    const v = parseExpr();
    if (i !== tokens.length) return false;
    return v;
  } catch (e) {
    if (e instanceof ParseError) return false;
    throw e;
  }
}
