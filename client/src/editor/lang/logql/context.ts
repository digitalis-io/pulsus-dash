/** The LogQL caret context (plan #66 Part A §3.4). Stub: not implemented yet. */
import type { Token } from './lexer';

export type LogCaretContext =
  | {
      readonly kind: 'labelName';
      readonly from: number;
      readonly end: number;
      readonly selector: string | null;
    }
  | {
      readonly kind: 'labelValue';
      readonly from: number;
      readonly end: number;
      readonly label: string;
      readonly quote: '"' | '`' | null;
      readonly selector: string | null;
      readonly closeQuote: boolean;
    }
  | {
      readonly kind: 'grouping';
      readonly from: number;
      readonly end: number;
      readonly selector: string | null;
    }
  | { readonly kind: 'stage'; readonly from: number; readonly end: number }
  | { readonly kind: 'function'; readonly from: number; readonly end: number }
  | { readonly kind: 'duration'; readonly from: number; readonly end: number }
  | { readonly kind: 'none' };

export const VAR_REF = /\$[A-Za-z_{]/;

export function caretContext(_text: string, _pos: number): LogCaretContext {
  throw new Error('not implemented');
}

export function selectorOf(
  _text: string,
  _tokens: readonly Token[],
  _open: number,
  _skip: number | null,
): string | null {
  throw new Error('not implemented');
}

export function firstSelector(_text: string, _tokens: readonly Token[]): string | null {
  throw new Error('not implemented');
}
