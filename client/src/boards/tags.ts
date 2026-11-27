/** Stub (tests first, plan #216 Part 2b §3.2). */
import type { FieldError } from '../api/types';

export type TagProblem = 'invalid' | 'duplicate' | 'full';

export function addTags(
  tags: readonly string[],
  input: string,
): { tags: readonly string[]; rest: string; problem: TagProblem | null } {
  return { tags, rest: input, problem: null };
}

export function tagError(_fields: readonly FieldError[]): FieldError | null {
  return null;
}
