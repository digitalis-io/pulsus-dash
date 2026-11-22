/**
 * The PromQL editor extensions (`promql.editor`, T09 §5.1): the Lezer PromQL language with the
 * package's completion and linter off (T09-002, T09-003), the syntax highlight, and the completion
 * source as `autocomplete` language data, which the view's completion guard runs (T09-005,
 * T09-015). Lookups go through `source` only.
 */
import type { CompletionContext } from '@codemirror/autocomplete';
import { syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { PromQLExtension } from '@prometheus-io/codemirror-promql';
import { promqlHighlight } from '../../theme';
import type { PromSource } from '../types';
import { promqlCompleteStrategy } from './promClient';

export function promqlExtensions(source: PromSource): Extension[] {
  const strategy = promqlCompleteStrategy(source);
  return [
    new PromQLExtension().activateLinter(false).activateCompletion(false).asExtension(),
    syntaxHighlighting(promqlHighlight),
    EditorState.languageData.of(() => [
      { autocomplete: (c: CompletionContext) => strategy.promQL(c) },
    ]),
  ];
}
