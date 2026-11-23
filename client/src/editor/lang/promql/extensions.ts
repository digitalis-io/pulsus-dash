/**
 * The PromQL editor extensions (`promql.editor`, T09 §5.1; plan #107 §3.5): the Lezer PromQL
 * language with the package's completion and linter off (T09-002, T09-003), the syntax highlight,
 * and the two completion slots as `autocomplete` language data, which the view's completion guard
 * runs (T09-005, T09-015). Every document or selection change releases the view's interest in an
 * in-flight lookup (`RELEASE_ON_CHANGE`). Lookups go through `source` only.
 */
import { syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { PromQLExtension } from '@prometheus-io/codemirror-promql';
import { completionProbe } from '../../probe';
import { RELEASE_ON_CHANGE, RemoteLookups, remoteLookupsPlugin } from '../../remoteLookups';
import { promqlHighlight } from '../../theme';
import type { PromSource } from '../types';
import { promqlLocalSource, promqlRemoteSource } from './complete';

/** One `RemoteLookups` per call: the host calls this once per view. */
export function promqlExtensions(source: PromSource): Extension[] {
  const lookups = new RemoteLookups();
  const probe = completionProbe();
  return [
    new PromQLExtension().activateLinter(false).activateCompletion(false).asExtension(),
    syntaxHighlighting(promqlHighlight),
    remoteLookupsPlugin(lookups, RELEASE_ON_CHANGE),
    EditorState.languageData.of(() => [
      { autocomplete: promqlLocalSource(probe) },
      { autocomplete: promqlRemoteSource(source, lookups, probe) },
    ]),
  ];
}
