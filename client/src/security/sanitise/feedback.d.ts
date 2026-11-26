/**
 * `parse5-sax-parser/feedback` (plan #198 Part 2a §3.3): the Vite alias of `vite.config.ts` for the
 * package's `dist/parser-feedback-simulator.js`, the tokenizer driver that `SAXParser` wraps. The
 * package entry (`SAXParser`) extends `Transform` from `node:stream`, which browsers lack.
 */
declare module 'parse5-sax-parser/feedback' {
  import type { Tokenizer, TokenizerOptions, TokenHandler } from 'parse5';
  export class ParserFeedbackSimulator {
    constructor(o: TokenizerOptions, h: TokenHandler);
    readonly tokenizer: Tokenizer;
  }
}
