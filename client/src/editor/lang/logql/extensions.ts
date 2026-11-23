/**
 * The LogQL editor extensions (`logql.editor`, plan #66 Part A §3.7; T09-003): a CodeMirror
 * `StreamLanguage` over `scanAt` (resumable per line through `LexState`), the shared highlight
 * style, and the two completion slots as `autocomplete` language data, which the view's
 * completion guard runs (T09-005, T09-015). Lookups go through `source` only.
 */
import { StreamLanguage, syntaxHighlighting, type StringStream } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { tags, type Tag } from '@lezer/highlight';
import type { LogSource } from '../types';
import { promqlHighlight } from '../../theme';
import {
  logqlLocalSource,
  logqlRemoteSource,
  remoteLookupsPlugin,
  RemoteLookups,
} from './complete';
import { CONVERSIONS, FUNCTIONS, KEYWORDS, STAGES } from './grammar';
import { advance, scanAt, startLex, type LexState, type Token } from './lexer';

const FUNCTION_WORDS = new Set([...FUNCTIONS, ...CONVERSIONS]);
const KEYWORD_WORDS = new Set([...KEYWORDS, ...STAGES]);

/** Appendix A.2.1: the style names a token returns, and their tags. */
const TOKEN_TABLE: Readonly<Record<string, Tag>> = {
  labelName: tags.labelName,
  function: tags.function(tags.variableName),
  keyword: tags.keyword,
  variableName: tags.variableName,
  string: tags.string,
  number: tags.number,
  operator: tags.operator,
  brace: tags.brace,
  paren: tags.paren,
  squareBracket: tags.squareBracket,
  invalid: tags.invalid,
};

function styleOf(t: Token, word: string, st: LexState): string | null {
  switch (t.kind) {
    case 'ident': {
      // The frame is checked first: `json` inside a selector is a label name.
      const top = st.stack.at(-1);
      if (top === 'brace' || top === 'group') return 'labelName';
      if (FUNCTION_WORDS.has(word)) return 'function';
      if (KEYWORD_WORDS.has(word)) return 'keyword';
      return 'variableName';
    }
    case 'string':
    case 'rawString':
      return 'string';
    case 'number':
    case 'duration':
    case 'bytes':
      return 'number';
    case 'pipe':
    case 'lineFilter':
    case 'matchOp':
    case 'cmpOp':
    case 'arith':
    case 'comma':
      return 'operator';
    case 'lbrace':
    case 'rbrace':
      return 'brace';
    case 'lparen':
    case 'rparen':
      return 'paren';
    case 'lbracket':
    case 'rbracket':
      return 'squareBracket';
    case 'error':
      return 'invalid';
    case 'space':
      return null;
  }
}

export const logqlLanguage: StreamLanguage<LexState> = StreamLanguage.define<LexState>({
  name: 'logql',
  startState: startLex,
  copyState: (st) => ({ ...st, stack: [...st.stack] }),
  token(stream: StringStream, st: LexState): string | null {
    const t = scanAt(stream.string, stream.pos, st.inRaw);
    stream.pos = t.to;
    st.inRaw = t.kind === 'rawString' && !t.closed;
    const style = styleOf(t, stream.string.slice(t.from, t.to), st);
    if (t.kind !== 'space') advance(st, t, stream.string);
    return style;
  },
  tokenTable: TOKEN_TABLE,
  languageData: {
    closeBrackets: { brackets: ['(', '[', '{', '"', '`'] },
  },
});

/** One `RemoteLookups` per call: the host calls this once per view. */
export function logqlExtensions(source: LogSource): Extension[] {
  const lookups = new RemoteLookups();
  return [
    logqlLanguage,
    syntaxHighlighting(promqlHighlight),
    remoteLookupsPlugin(lookups),
    EditorState.languageData.of(() => [
      { autocomplete: logqlLocalSource() },
      { autocomplete: logqlRemoteSource(source, lookups) },
    ]),
  ];
}
