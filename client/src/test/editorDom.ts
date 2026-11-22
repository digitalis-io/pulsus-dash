/**
 * What jsdom lacks for a CodeMirror view (imported by the editor tests): text ranges have no
 * layout, and CodeMirror measures them when it scrolls the caret into view; and there is no
 * `execCommand`, which CodeMirror's selection read in a shadow root falls back to on focus.
 * Browsers have all three; Part C's e2e runs the editor in them.
 */
const emptyRects = (): DOMRectList => {
  const list: DOMRect[] = [];
  return Object.assign(list, { item: () => null });
};

if (!('getClientRects' in Range.prototype)) {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    value: emptyRects,
    configurable: true,
  });
}
if (!('getBoundingClientRect' in Range.prototype)) {
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    value: () => new DOMRect(),
    configurable: true,
  });
}
if (!('execCommand' in document)) {
  Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
}

export {};
