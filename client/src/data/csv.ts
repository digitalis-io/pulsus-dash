/**
 * One CSV cell (T24-026 amended, T22-013; plan #173 Part 1 §4.4): the formula guard, then RFC 4180
 * quoting. Every CSV the client writes (panel tables, list widgets) sends each cell through it.
 */

/** A number, as the whole cell (no `m` flag: `$` is the end of the string). */
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|Infinity)$/;
/** A spreadsheet reads a cell starting with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;
/** LF, CR, U+0085, U+2028, U+2029: a number with one of these is not exempt. */
const LINE_TERMINATOR = /[\n\r\u0085\u2028\u2029]/;
const NEEDS_QUOTES = /[",\r\n]/;

/**
 * `v` with a leading `'` when it starts with `=`, `+`, `-`, `@`, TAB or CR, unless the whole of `v`
 * is a number without a line terminator (`-6.25`, `+1`, `1e5` and `-Infinity` stay as they are);
 * then quoted per RFC 4180 when it holds `"`, `,`, CR or LF.
 */
export function csvCell(v: string): string {
  const number = NUMBER.test(v) && !LINE_TERMINATOR.test(v);
  const guarded = FORMULA_START.test(v) && !number ? `'${v}` : v;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}
