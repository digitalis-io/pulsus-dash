/** Board spec v1 on the client (plan #61 Part B §3.5). Stub. */
import type { BoardSpec, FieldError } from '../api/types';

export const MAX_PANELS = 200;
export const MAX_SECTIONS = 50;
export const MAX_TITLE = 200;
export const MAX_QUERY_BYTES = 16384;

export function checkBoardSpec(_value: unknown): FieldError[] {
  return [];
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

export function nextPanelId(_spec: BoardSpec): string {
  return 'p-1';
}
