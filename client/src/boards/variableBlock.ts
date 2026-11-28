/**
 * What the variables of one panel text block (plan #289 §4.4): the hooks of the data panels read
 * it; a module of its own, so the text widget's chunk does not carry it.
 */
import { referencedVariables } from './variableRefs';

/** The block of one panel text. */
export interface VariableBlock {
  /** Referenced names with no value: waiting, failed, unset or unknown ("Set a value"). */
  readonly missing: readonly string[];
  /** The label of the first referenced variable whose selection is too large, or null. */
  readonly tooMany: string | null;
  /** A referenced variable's list is loading: the panel holds its idle key. */
  readonly loading: boolean;
}

/** The state kinds of `resolveVariables` this module reads (no import: no cycle). */
interface StateLike {
  readonly kind: string;
}

/**
 * The block of `text`'s references: a name without a state is missing unless `vars` holds it (a
 * run outside a board has values and no states).
 */
export function variableBlock(
  text: string,
  vars: ReadonlyMap<string, unknown>,
  states: ReadonlyMap<string, StateLike>,
  labels: ReadonlyMap<string, string>,
): VariableBlock {
  const missing: string[] = [];
  let tooMany: string | null = null;
  let loading = false;
  for (const name of referencedVariables(text)) {
    const s = states.get(name);
    const kind = s?.kind ?? (vars.has(name) ? 'ready' : 'unset');
    if (kind === 'ready') continue;
    if (kind === 'loading') loading = true;
    else if (kind === 'tooMany') tooMany ??= labels.get(name) ?? name;
    else missing.push(name);
  }
  return { missing, tooMany, loading };
}
