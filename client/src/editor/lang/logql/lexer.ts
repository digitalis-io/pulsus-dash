/** The LogQL scanner (plan #66 Part A §3.3). Stub: not implemented yet. */
export type TokenKind =
  | 'space'
  | 'comment'
  | 'string'
  | 'rawString'
  | 'number'
  | 'duration'
  | 'bytes'
  | 'ident'
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'pipe'
  | 'lineFilter'
  | 'matchOp'
  | 'cmpOp'
  | 'arith'
  | 'error';

export interface Token {
  readonly kind: TokenKind;
  readonly from: number;
  readonly to: number;
  readonly closed: boolean;
}

export type Frame = 'brace' | 'paren' | 'group' | 'bracket';

export interface LexState {
  stack: Frame[];
  depthOver: number;
  inRaw: boolean;
  prev: TokenKind | null;
  prevWord: string | null;
}

export function scanAt(_s: string, _i: number, _inRaw: boolean): Token {
  throw new Error('not implemented');
}

export function lexLogQL(_text: string): Token[] {
  throw new Error('not implemented');
}

export function startLex(): LexState {
  throw new Error('not implemented');
}

export function advance(_st: LexState, _tok: Token, _text: string): void {
  throw new Error('not implemented');
}
