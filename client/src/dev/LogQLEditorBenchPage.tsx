/**
 * The LogQL editor harness (development and stub builds only; plan #66 Part A §3.12, A.8.0): the
 * real `LogQLEditor` over an in-memory source that answers at once, so `bench:editor-keystroke`
 * (LogQL case) and `bench:logql-completion-latency` time the client, not a network. The text
 * starts from the `q` search parameter. The editor chunk is loaded by a dynamic import only, so
 * this page's own chunk is not an `editor-*` chunk.
 */
import { lazy, Suspense, useState, type JSX } from 'react';
import type { LogSource } from '../editor/lang/types';
import { t } from '../i18n/t';
import { usePageTitle } from '../shell/PageTitle';
import { readExploreParams } from '../state/exploreParams';
import { useTimeContext } from '../state/useTimeContext';

/** In-memory, resolves at once: the benches time the client, not a network. */
export const BENCH_LOG_SOURCE: LogSource = {
  labelNames: () => Promise.resolve(['app', 'env', 'level', 'pod']),
  labelValues: () => Promise.resolve(['checkout', 'web']),
};

const Editor = lazy(() =>
  import('../editor/logqlEditor').then((m) => ({ default: m.LogQLEditor })),
);

const noop = (): void => undefined;

export function LogQLEditorBenchPage(): JSX.Element {
  usePageTitle(t('logqlBench.title'));
  // `q` through src/state, as the Explore pages read it; only its first value is kept.
  const { rest } = useTimeContext();
  const [value, setValue] = useState(() => readExploreParams(rest).q);
  return (
    <Suspense fallback={null}>
      <Editor
        value={value}
        onChange={setValue}
        onRun={noop}
        onEscape={noop}
        diagnostics={[]}
        label={t('logqlBench.editorLabel')}
        placeholder=""
        source={BENCH_LOG_SOURCE}
      />
    </Suspense>
  );
}
