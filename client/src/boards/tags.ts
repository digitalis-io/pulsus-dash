/**
 * Board tags as the tag field adds them (plan #216 Part 2b §3.2; T24-029): pure. `addTags` splits
 * the input on commas and white space, lower-cases each piece (the rule is lower-case only, so a
 * typed capital never means another tag) and adds the pieces in order, stopping at the first that
 * cannot be added. `tagError` picks a save's first error at `/tags` or one of its items.
 */
import type { FieldError } from '../api/types';
import { MAX_BOARD_TAGS, TAG_PATTERN } from './spec';

export type TagProblem = 'invalid' | 'duplicate' | 'full';

const SEPARATORS = /[\s,]+/u;
const TAGS_POINTER = /^\/tags(?:\/\d+)?$/;

/**
 * `tags` with the pieces of `input` added. Empty pieces are skipped; a piece that fails stops the
 * run with its problem (`invalid` against `TAG_PATTERN`, `duplicate` when present, `full` at
 * `MAX_BOARD_TAGS`), and `rest` holds it and every later piece, joined by `, `.
 */
export function addTags(
  tags: readonly string[],
  input: string,
): { tags: readonly string[]; rest: string; problem: TagProblem | null } {
  const pieces = input
    .split(SEPARATORS)
    .filter((p) => p !== '')
    .map((p) => p.toLowerCase());
  const out = [...tags];
  for (const [i, piece] of pieces.entries()) {
    const problem: TagProblem | null = !TAG_PATTERN.test(piece)
      ? 'invalid'
      : out.includes(piece)
        ? 'duplicate'
        : out.length >= MAX_BOARD_TAGS
          ? 'full'
          : null;
    if (problem !== null) {
      return {
        tags: out.length === tags.length ? tags : out,
        rest: pieces.slice(i).join(', '),
        problem,
      };
    }
    out.push(piece);
  }
  return { tags: out.length === tags.length ? tags : out, rest: '', problem: null };
}

/** The first of `fields` at `/tags` or `/tags/<i>`, else null. */
export function tagError(fields: readonly FieldError[]): FieldError | null {
  return fields.find((f) => TAGS_POINTER.test(f.pointer)) ?? null;
}
