/**
 * Explore › Logs (plan #66 Part C §3.9, §4; SRF-033, SRF-036, PRF-030, PRF-031, IA-022): the
 * Query card (the LogQL editor from the lazy chunk, Run, the status line), then one results column
 * whose width is the run's: the Volume and Log lines cards for a stream answer, or the Result card
 * for a metric answer. One Run makes two requests from the URL text, the Context window and the
 * width held per step: the pager (`useLogPager`) and the volume query (`useLogsVolume`). A new
 * window, text, direction or tenant is a new key (the old requests abort); a Run with unchanged
 * text, drift's Run again and the shell's refresh under a fixed window are a new pager generation.
 * The language is reached only through `LANGUAGES` (ADR-0018 §5); nothing is planned here
 * (ADR-0021 §2).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../app/providers';
import type { Diagnostic } from '../../editor/lang/types';
import type { QueryEditorHandle } from '../../editor/QueryEditorHost';
import {
  firstPageError,
  layoutOf,
  logsStatusView,
  nextLast,
  pagerInput,
  type LastLogsResult,
} from '../../explore/logsRun';
import { overQueryLimit } from '../../explore/querySize';
import { useStepWidth } from '../../explore/stepWidth';
import { useElementWidth } from '../../explore/useElementWidth';
import type { Refusal } from '../../explore/useExploreRun';
import { useLogqlModules } from '../../explore/useLogqlModules';
import { useLogsVolume } from '../../explore/useLogsVolume';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { useLogPager, useLogPagerState } from '../../logs/useLogPager';
import { ContextSummary } from '../../shell/ContextSummary';
import { usePageTitle } from '../../shell/PageTitle';
import { useShellRoute } from '../../shell/useShellRoute';
import { useLogsParams } from '../../state/useLogsParams';
import { useTimeContext } from '../../state/useTimeContext';
import pageStyles from '../pages.module.css';
import styles from './Explore.module.css';
import { LogsMetricCard } from './LogsMetricCard';
import { LogsQueryCard } from './LogsQueryCard';
import { LogsStreamCard } from './LogsStreamCard';
import { LogsVolumeCard } from './LogsVolumeCard';
import { QueryStatus } from './QueryStatus';

const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);

export function LogsPage() {
  usePageTitle(t('explore.logs.title'));
  const api = useApi();
  const queryClient = useQueryClient();
  const { tenant } = useShellRoute();
  const { window: win, dispatch, refreshEpoch } = useTimeContext();
  const { params, set } = useLogsParams();
  const { q, dir, wrap } = params;

  const modules = useLogqlModules();
  const [resultsRef, widthPx] = useElementWidth<HTMLDivElement>();
  const step = useStepWidth(win, widthPx);
  // Nothing runs before the field is final (the editor, or the fallback text area when it failed)
  // and the language has loaded or an import failed (LP20–LP22, #147), as on Explore › Metrics.
  const editorReady = modules.editor !== null || modules.editorFailed;
  const loaded = editorReady && (modules.lang !== null || modules.failed);
  const runStep = loaded ? step : null;
  const runReady = runStep !== null;
  const urlRefusal = useMemo(() => (overQueryLimit(q) ? ('queryTooLarge' as const) : null), [q]);

  const [runSeq, setRunSeq] = useState(0);
  const input = useMemo(
    () => pagerInput({ tenant, q, window: win, step: runStep, dir }),
    [tenant, q, win, runStep, dir],
  );
  const pager = useLogPager(input, api, `${String(refreshEpoch)}.${String(runSeq)}`);
  const state = useLogPagerState(pager);
  const volume = useLogsVolume({
    tenant,
    q,
    window: win,
    step: runStep,
    enabled: q.trim() !== '' && urlRefusal === null && runStep !== null,
  });

  // The last first-page answer of this tenant (§4.2), kept while rendering: a tenant switch never
  // shows the old tenant's layout or series, even for one frame.
  const [last, setLast] = useState<LastLogsResult | null>(null);
  const cur = nextLast(last, tenant, state);
  if (cur !== last) setLast(cur);
  const layout = layoutOf(state?.phase ?? null, cur?.layout ?? null);

  // The draft lives in a ref: typing re-renders nothing unless one of the flags below flips.
  const draftRef = useRef(q);
  const qRef = useRef(q);
  // `differs` of the draft against `q` when it was typed: a new `q` makes the draft clean again.
  const [draft, setDraft] = useState({ q, differs: false });
  const dirty = draft.differs && draft.q === q;
  const [draftOver, setDraftOver] = useState(false);
  const [runRefusal, setRunRefusal] = useState<Refusal | null>(null);
  const editorRef = useRef<QueryEditorHandle>(null);
  const runButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    qRef.current = q;
    draftRef.current = q;
  }, [q]);

  // The window the completion lookups read, kept current. The source reads it on each lookup,
  // never while rendering, so a new window needs no new source (T09-014: one per tenant).
  const winRef = useRef(win);
  useEffect(() => {
    winRef.current = win;
  }, [win]);
  const editor = modules.editor;
  const source = useMemo(() => {
    if (editor === null) return null;
    const window = () => winRef.current;
    // eslint-disable-next-line react-hooks/refs -- `window` runs on lookups, not during render
    return editor.createLogSource({ api, queryClient, tenant, window });
  }, [editor, api, queryClient, tenant]);

  const onDraft = useCallback((text: string) => {
    draftRef.current = text;
    const at = qRef.current;
    const differs = text !== at;
    setDraft((d) => (d.q === at && d.differs === differs ? d : { q: at, differs }));
    setDraftOver(overQueryLimit(text));
    setRunRefusal(null);
  }, []);

  const onRun = useCallback(() => {
    const d = draftRef.current;
    if (d.trim() === '') {
      setRunRefusal(null);
      set({ q: '' }, { replace: false });
      return;
    }
    if (overQueryLimit(d)) {
      setRunRefusal('queryTooLarge');
      return;
    }
    // Only a key can reach this while not ready (the button is disabled): the status says why.
    if (!runReady) return;
    setRunRefusal(null);
    if (d !== q) {
      set({ q: d }, { replace: false });
      return;
    }
    setRunSeq((n) => n + 1);
    volume.rerun();
  }, [set, runReady, q, volume]);

  const onEscape = useCallback(() => {
    runButtonRef.current?.focus();
  }, []);
  const onNarrow = useCallback(() => {
    dispatch({ type: 'zoom', dir: 'in' });
  }, [dispatch]);
  // Drift's Run again: a new pager for the same run; the volume is unchanged.
  const onRerun = useCallback(() => {
    setRunSeq((n) => n + 1);
  }, []);
  const onDirectionChange = useCallback(
    (d: 'backward' | 'forward') => {
      set({ dir: d }, { replace: true });
    },
    [set],
  );
  const onWrapChange = useCallback(
    (w: boolean) => {
      set({ wrap: w }, { replace: true });
    },
    [set],
  );

  const lang = modules.lang;
  const runError = firstPageError(state);
  // The server maps PulsusDB's position to the raw text (ADR-0021 §3): the mapping is the identity.
  const diagnostics = useMemo(
    () =>
      !dirty && runError !== null && lang !== null
        ? lang.diagnosticsOf(q, runError, (i) => i, q)
        : NO_DIAGNOSTICS,
    [dirty, runError, lang, q],
  );
  const view = logsStatusView({
    runRefusal,
    draftOver,
    urlRefusal,
    runReady,
    editorLoaded: editorReady,
    state,
    dir,
    diagnostics,
  });

  return (
    <div className={cx(pageStyles['page'])}>
      <ContextSummary />
      <LogsQueryCard
        modules={modules}
        q={q}
        source={source}
        diagnostics={diagnostics}
        onDraft={onDraft}
        onRun={onRun}
        onEscape={onEscape}
        status={<QueryStatus view={view} onNarrow={onNarrow} />}
        runReady={runReady}
        editorRef={editorRef}
        runButtonRef={runButtonRef}
      />
      <div ref={resultsRef} className={cx(styles['results'])} data-logs-results="">
        {q === '' ? (
          <EmptyState title={t('explore.logs.empty')}>
            <p className={cx(pageStyles['muted'])}>{t('explore.logs.emptyDetail')}</p>
          </EmptyState>
        ) : layout === 'series' ? (
          <LogsMetricCard
            series={cur?.series ?? null}
            fetching={state === null || state.phase === 'pending'}
            onNarrow={onNarrow}
          />
        ) : (
          <>
            <LogsVolumeCard
              volume={volume}
              showError={state?.phase === 'streams'}
              onNarrow={onNarrow}
            />
            <LogsStreamCard
              pager={pager}
              state={state}
              wrap={wrap}
              onWrapChange={onWrapChange}
              onDirectionChange={onDirectionChange}
              onRerun={onRerun}
              onNarrow={onNarrow}
            />
          </>
        )}
      </div>
    </div>
  );
}
