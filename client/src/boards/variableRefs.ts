/**
 * The variables one panel text references (plan #64 §3.3): the client's hint for the "Set a value"
 * state and the values it sends. The server substitutes them and is the authority (ADR-0021, #112).
 */

/** Distinct names matching VARIABLE_REF that pass VARIABLE_NAME and do not start with `__`,
 *  first-reference order (the rule of #61's `boardVariables`, applied to one text). */
export function referencedVariables(_text: string): string[] {
  throw new Error('not implemented');
}

/** The [name, value] pairs of `referencedVariables(text)` that `vars` holds, sorted by name. */
export function panelVars(
  _text: string,
  _vars: ReadonlyMap<string, string>,
): (readonly [string, string])[] {
  throw new Error('not implemented');
}
