/**
 * The editor's theme and highlight style (plan #63 Part B, B.2; T09 §4.8): only design tokens
 * (`var(--…)`, `ci:token-lint`). The theme is a constructed stylesheet adopted by the editor's
 * shadow root (ADR-0014 §9); custom properties inherit into it, so it follows `data-theme`.
 */
import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export const promqlHighlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.logicOperator],
    color: 'var(--syn-keyword)',
  },
  { tag: tags.function(tags.variableName), color: 'var(--syn-func)' },
  { tag: tags.string, color: 'var(--syn-string)' },
  { tag: tags.number, color: 'var(--syn-number)' },
  { tag: tags.labelName, color: 'var(--syn-label)' },
  { tag: tags.variableName, color: 'var(--text)' },
  {
    tag: [
      tags.operator,
      tags.arithmeticOperator,
      tags.paren,
      tags.squareBracket,
      tags.brace,
      tags.comment,
    ],
    color: 'var(--text-muted)',
  },
  // No client-side error colour: only PulsusDB decides validity (T09-002).
  { tag: tags.invalid, color: 'var(--text)' },
]);

export const promqlTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontSize: 'var(--font-size-md)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: 'var(--line-height-normal)',
    // Twelve lines, then it scrolls (T09-004).
    maxHeight: 'calc(var(--font-size-md) * var(--line-height-normal) * 12 + 2 * var(--space-2))',
    overflow: 'auto',
  },
  '.cm-content': { padding: 'var(--space-2) 0', caretColor: 'var(--text)' },
  '.cm-line': { padding: '0 var(--space-3)' },
  // The page draws the focus ring on the host with :focus-within.
  '&.cm-focused': { outline: 'none' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  // Accent, not a state colour: a query error is not an entity state (VL-003).
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--accent)',
    textUnderlineOffset: 'var(--space-1)',
  },
  '.cm-tooltip': {
    background: 'var(--surface-2)',
    color: 'var(--text)',
    border: 'var(--border-hairline) solid var(--hairline)',
    borderRadius: 'var(--radius)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--surface-hover)',
    color: 'var(--text)',
  },
  '.cm-completionDetail': { color: 'var(--text-muted)', marginLeft: 'var(--space-2)' },
  '.cm-matchingBracket': { background: 'var(--brush)' },
});
