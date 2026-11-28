/**
 * The static part of the StubApi mirror of the server's `vars` package (plan #289 §3.4): the
 * value forms, their bounds and the refusal message. The rest of the mirror (`vars.ts`: the
 * contexts, the writing of a structured value and the regex position rules) is loaded only when a
 * request carries a structured value, so a stub build's initial chunk does not carry it.
 */
import type { VarValue } from '../types';
import type * as Mirror from './vars';

export type CtxKind = 'none' | 'eq' | 're' | 'top';

export interface Ctx {
  readonly kind: CtxKind;
  readonly where: string;
}

export const WHERE = {
  topLevel: 'top level',
  functionArgument: 'function argument',
  comment: 'comment',
  orFilter: 'or filter',
  patternFilter: 'pattern filter',
  equality: 'equality match',
  regex: 'regex',
  regexClass: 'regex class',
  regexEscape: 'regex escape',
  regexQuoted: 'regex quoted text',
} as const;

/** The LogQL stages whose strings and references are refused, named by their keyword. */

export const MAX_VALUE_BYTES = 4096;
export const MAX_VALUES = 200;
export const MAX_SELECTION_BYTES = 65_536;

const encoder = new TextEncoder();
const utf8 = (s: string): number => encoder.encode(s).length;

export const isLegacy = (v: VarValue): v is string => typeof v === 'string';

/** UTF-8 bytes of `vs` as `JSON.stringify` writes it (the server's `SelectionBytes`). */
export function selectionBytes(vs: readonly string[]): number {
  return utf8(JSON.stringify(vs));
}

/** Row 5 of a value (`vars.Check`). */
export function checkValue(v: VarValue): boolean {
  if (isLegacy(v)) return utf8(v) <= MAX_VALUE_BYTES;
  if ('all' in v) return v.all.length > 0 && utf8(v.all) <= MAX_VALUE_BYTES;
  return (
    v.values.length >= 1 &&
    v.values.length <= MAX_VALUES &&
    v.values.every((s) => utf8(s) <= MAX_VALUE_BYTES) &&
    selectionBytes(v.values) <= MAX_SELECTION_BYTES
  );
}

/** The message of a refused value (`vars.RangeMessage`). */
export function rangeMessage(v: VarValue): string {
  if (isLegacy(v)) return 'a variable value must be UTF-8 and at most 4096 bytes';
  if ('all' in v) return "a variable's all value must be UTF-8 and 1 to 4096 bytes";
  return 'a variable must have 1 to 200 values, each UTF-8 and at most 4096 bytes, and at most 65536 bytes in all';
}

/** A reference refused for its context (where set) or by row 7b (where ''). */
export interface Refusal {
  readonly name: string;
  readonly at: number;
  readonly where: string;
}

/** The refused names, distinct, by first refused reference, and the first one's place. */
export function unrepresentable(rs: readonly Refusal[]): { names: string[]; where: string } {
  const sorted = [...rs].sort((a, b) => a.at - b.at);
  const names: string[] = [];
  for (const r of sorted) if (!names.includes(r.name)) names.push(r.name);
  return { names, where: sorted[0]?.where ?? '' };
}

/** The refusal message of row 7b and T07-031. */
export function unrepresentableMessage(names: readonly string[], where: string): string {
  return `the value of variable $${names.join(', $')} cannot be written where it is referenced${where === '' ? '' : ` (in ${where})`}`;
}

/** Whether `vars` holds a structured value (the mirror's contexts are needed). */
export function anyStructured(
  vars: Readonly<Record<string, VarValue>> | ReadonlyMap<string, VarValue> | undefined,
): boolean {
  if (vars === undefined) return false;
  const values = vars instanceof Map ? [...vars.values()] : Object.values(vars);
  return values.some((v) => typeof v !== 'string');
}

let loaded: typeof Mirror | null = null;

/** Loads the rest of the mirror (once). */
export async function loadMirror(): Promise<void> {
  loaded ??= await import('./vars');
}

/** The rest of the mirror; a request with a structured value loads it first (`loadMirror`). */
export function mirror(): typeof Mirror {
  if (loaded === null) throw new Error('stub: the variables mirror is not loaded');
  return loaded;
}

/** The token context of a scan without structured values: every string and reference alike. */
export interface TrackerLike {
  byte(c: number): void;
  end(): void;
  string(): Ctx;
  endString(): void;
  ref(): Ctx;
}

const NONE: Ctx = { kind: 'none', where: WHERE.topLevel };

export const NO_TRACKER: TrackerLike = {
  byte: () => undefined,
  end: () => undefined,
  string: () => NONE,
  endString: () => undefined,
  ref: () => NONE,
};

/** Whether the rest of the mirror is loaded. */
export function mirrorLoaded(): boolean {
  return loaded !== null;
}
