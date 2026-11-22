/** The LogQL editor extensions (plan #66 Part A §3.7). Stub: not implemented yet. */
import { StreamLanguage } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { LogSource } from '../types';
import type { LexState } from './lexer';

export const logqlLanguage: StreamLanguage<LexState> = StreamLanguage.define<LexState>({
  name: 'logql',
  startState: () => {
    throw new Error('not implemented');
  },
  token: () => {
    throw new Error('not implemented');
  },
});

export function logqlExtensions(_source: LogSource): Extension[] {
  throw new Error('not implemented');
}
