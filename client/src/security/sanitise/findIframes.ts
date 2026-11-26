/**
 * `findIframes` (T24 §5.2, T24-006; plan #198 Part 2a §3.3, §4.1): the `iframe` start tags in an
 * HTML fragment, for the import conversion (T24 §5.4) and the renderer's removal kinds (Part 2b).
 *
 * The result is the **union**, de-duplicated by start offset and sorted, of
 * - A. the `iframe` start-tag tokens of the spec tokenizer, driven by `parse5-sax-parser`'s
 *   `ParserFeedbackSimulator` (the part of `SAXParser` that browsers can load: `SAXParser` itself
 *   extends `Transform` from `node:stream`), through the Vite alias `parse5-sax-parser/feedback`;
 * - B. the `iframe` elements of the `parse5.parse` tree, template contents included.
 *
 * Each covers the other's gap (the tree drops `<select><iframe>`; the tokenizer misses
 * `<select><title><select><iframe>`), and both keep the spec's raw text, RCDATA, comment, CDATA and
 * processing-instruction handling. Attributes are decoded by the spec, and the first of duplicate
 * `src` attributes wins. Over-counting only adds a link.
 */
import { parse, type DefaultTreeAdapterTypes, type Token, type TokenHandler } from 'parse5';
import { ParserFeedbackSimulator } from 'parse5-sax-parser/feedback';

export interface IframeHit {
  /** UTF-16 index of the start tag in `html`. */
  readonly offset: number;
  /** 1-based line of the start tag in `html`. */
  readonly line: number;
  /** The first `src` attribute, decoded; `null` without one. */
  readonly src: string | null;
}

type Location = Token.Location | null | undefined;

function src(attrs: readonly Token.Attribute[]): string | null {
  return attrs.find((a) => a.name === 'src')?.value ?? null;
}

function noop(): void {
  // Every token other than a start tag is ignored.
}

function walk(
  node: DefaultTreeAdapterTypes.ParentNode,
  hit: (loc: Location, attrs: readonly Token.Attribute[]) => void,
): void {
  // An explicit stack: the tree of a hostile fragment may be deep.
  const stack: DefaultTreeAdapterTypes.ParentNode[] = [node];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    const children: DefaultTreeAdapterTypes.ChildNode[] = [...n.childNodes];
    if (n.nodeName === 'template' && 'content' in n) stack.push(n.content);
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i];
      if (c === undefined || !('childNodes' in c)) continue;
      if (c.nodeName === 'iframe' && 'attrs' in c) hit(c.sourceCodeLocation, c.attrs);
      stack.push(c);
    }
  }
}

/** The `iframe` start tags of `html` (T24 §5.2), sorted by offset. */
export function findIframes(html: string): readonly IframeHit[] {
  const hits = new Map<number, IframeHit>();
  const hit = (loc: Location, attrs: readonly Token.Attribute[]): void => {
    if (loc === null || loc === undefined || hits.has(loc.startOffset)) return;
    hits.set(loc.startOffset, { offset: loc.startOffset, line: loc.startLine, src: src(attrs) });
  };
  const handler: TokenHandler = {
    onCharacter: noop,
    onNullCharacter: noop,
    onWhitespaceCharacter: noop,
    onComment: noop,
    onDoctype: noop,
    onEndTag: noop,
    onEof: noop,
    onStartTag(t) {
      if (t.tagName === 'iframe') hit(t.location, t.attrs);
    },
  };
  new ParserFeedbackSimulator({ sourceCodeLocationInfo: true }, handler).tokenizer.write(
    html,
    true,
  );
  walk(parse(html, { sourceCodeLocationInfo: true }), hit);
  return [...hits.values()].sort((a, b) => a.offset - b.offset);
}
