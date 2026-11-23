/** The replaced range of an accepted PromQL completion (plan #107 §3.4). Stub. */
import type { EditorState } from '@codemirror/state';

export interface ReplaceRange {
  readonly end: number;
  readonly suffix: '' | '"' | "'" | '`';
}

export function replaceRange(_state: EditorState, pos: number): ReplaceRange {
  return { end: pos, suffix: '' };
}
