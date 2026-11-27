/**
 * Explore › Metrics (plan #63 Part C §3.3, §4.1; SRF-027, SRF-030, SRF-031, VIZ-065, IA-020,
 * IA-022): the Query card (picker, Run, the PromQL editor from the lazy chunk, the status line) and
 * the Result card (vis, rate chip, notices, chart, series table). The page owns the draft, the Run
 * order and refusals (T09-015, B.8 #12), the sort and the isolated series (D-ISO); the run itself
 * is `useExploreRun`. The language is reached only through `LANGUAGES` (ADR-0018). Auto-vis offers
 * `EXPLORE_VIS`, so row 11 can choose the bar chart, which the page plans as a `barchartModel`
 * (plan #173 Part 3b §4.4).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../app/providers';
import type { PromMetadata } from '../../data/decode';
import { promGrid } from '../../data/step';
import type { PromQLEditorHandle } from '../../editor/PromQLEditor';
import type { Diagnostic } from '../../editor/lang/types';
import { promMetadataQuery } from '../../explore/promMetadata';
import { overQueryLimit } from '../../explore/querySize';
import {
  nextSort,
  seriesRows,
  sortRows,
  toggleIsolation,
  type SortColumn,
  type SortState,
} from '../../explore/seriesRows';
import { useEditorModules } from '../../explore/useEditorModules';
import { useElementWidth } from '../../explore/useElementWidth';
import {
  runnable,
  STRING_PLAN,
  useExploreRun,
  type Refusal,
  type RunInputs,
} from '../../explore/useExploreRun';
import { t } from '../../i18n/t';
import { InspectorHost } from '../../inspector/host';
import { cx } from '../../kit/cx';
import { ContextSummary } from '../../shell/ContextSummary';
import { usePageTitle } from '../../shell/PageTitle';
import { useShellRoute } from '../../shell/useShellRoute';
import { useExploreParams } from '../../state/useExploreParams';
import { useTimeContext } from '../../state/useTimeContext';
import { autoVis, chooseVis, EXPLORE_VIS, type VisParam } from '../../vis/autovis';
import { barchartModel } from '../../vis/barchart';
import { canIsolate, framePlan } from '../../vis/framePlan';
import { panelUnits } from '../../vis/units';
import styles from '../pages.module.css';
import { QueryCard } from './QueryCard';
import { QueryStatus, statusView } from './QueryStatus';
import { ResultCard } from './ResultCard';

const NO_META: PromMetadata['metrics'] = Object.freeze({});
const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);
/** Explore applies no board filters (T25-010, until I3). */
const NO_FILTERS = Object.freeze([]);

export function MetricsPage() {
  usePageTitle(t('explore.metrics.title'));
  const api = useApi();
  const queryClient = useQueryClient();
  const { tenant } = useShellRoute();
  const { window: win, dispatch, anchorMs, refreshEpoch } = useTimeContext();
  const { params, set } = useExploreParams();
  const q = params.q;

  const modules = useEditorModules();
  // The picker's and completion's metadata only: the server reads metric types itself (ADR-0021).
  const metaQ = useQuery(promMetadataQuery(api, tenant));
  const meta = metaQ.data?.metrics ?? NO_META;
  const [chartRef, widthPx] = useElementWidth<HTMLDivElement>();
  const stepMs =
    widthPx === null ? null : (promGrid(win.fromMs, win.toMs, widthPx)?.stepMs ?? null);
  const rate = params.rate !== 'off';
  // The field is final: the editor, or the fallback text area when the editor failed.
  const editorReady = modules.editor !== null || modules.editorFailed;
  // An import failed (#147): the run is degraded, so it needs no language. Not before the field is
  // final: the URL query does not run while a later editor may still mount (M2).
  const degraded = modules.failed && editorReady;
  const inputs = useMemo<RunInputs>(
    () => ({ lang: modules.lang, degraded, stepMs, rate }),
    [modules.lang, degraded, stepMs, rate],
  );
  const runReady = editorReady && runnable(inputs);
  const run = useExploreRun({
    tenant,
    q,
    inputs,
    widthPx,
    window: win,
    anchorMs,
    epoch: refreshEpoch,
  });

  // The draft lives in a ref: typing re-renders nothing unless one of the flags below flips.
  const draftRef = useRef(q);
  const qRef = useRef(q);
  // `differs` of the draft against `q` when it was typed: a new `q` makes the draft clean again.
  const [draft, setDraft] = useState({ q, differs: false });
  const dirty = draft.differs && draft.q === q;
  const [draftOver, setDraftOver] = useState(false);
  const [runRefusal, setRunRefusal] = useState<Refusal | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);
  const [isolatedKey, setIsolatedKey] = useState<string | null>(null);
  const editorRef = useRef<PromQLEditorHandle>(null);
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
    return editor.createPromSource({ api, queryClient, tenant, window });
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
    if (d !== q) set({ q: d }, { replace: false });
    else run.rerun();
  }, [set, runReady, q, run]);

  const onEscape = useCallback(() => {
    runButtonRef.current?.focus();
  }, []);
  // The Inspector closes when Explore runs another query (T25-012); ✎ focuses the editor (T25-015).
  const originKey = useCallback(() => q, [q]);
  const onEditQuery = useCallback(() => {
    editorRef.current?.focus();
  }, []);
  const onPick = useCallback((name: string) => {
    editorRef.current?.insert(name);
    editorRef.current?.focus();
  }, []);
  const onNarrow = useCallback(() => {
    dispatch({ type: 'zoom', dir: 'in' });
  }, [dispatch]);
  const onVis = useCallback(
    (vis: VisParam) => {
      set({ vis }, { replace: true });
    },
    [set],
  );
  const onRate = useCallback(() => {
    set({ rate: params.rate === 'off' ? 'auto' : 'off' }, { replace: true });
  }, [set, params.rate]);
  const onSort = useCallback((column: SortColumn) => {
    setSort((s) => nextSort(s, column));
  }, []);

  const shown = run.shown;
  const auto = useMemo(
    () =>
      shown === null
        ? null
        : autoVis({
            histogram: shown.planned.histogram,
            rateApplied: shown.planned.rateApplied,
            result: shown.result,
            // Row 11 can fire here: Explore stores nothing (#173 Part 3b §4.4).
            available: EXPLORE_VIS,
          }),
    [shown],
  );
  // Null only for a string result: autoVis gives a null vis only then.
  const vis = auto === null ? null : chooseVis(params.vis, auto);
  const plan = useMemo(() => {
    if (shown === null) return null;
    if (shown.result.kind === 'string') return STRING_PLAN;
    if (vis === null) return null;
    return framePlan(vis, shown.result, {
      isolatedKey,
      title: t('explore.result.title'),
      units: panelUnits(undefined, vis, shown.planned.rateApplied),
    });
  }, [shown, vis, isolatedKey]);
  // The bar chart's model (#173 Part 3b §4.4): Explore has no options, thresholds or baseline.
  const model = useMemo(() => {
    if (vis !== 'barchart' || shown === null || shown.result.kind === 'string') return null;
    return barchartModel(shown.result, {
      title: t('explore.result.title'),
      unit: panelUnits(undefined, 'barchart', shown.planned.rateApplied).value,
      options: undefined,
      thresholds: null,
    });
  }, [vis, shown]);
  const rows = useMemo(
    () => (shown === null ? [] : sortRows(seriesRows(shown.result), sort)),
    [shown, sort],
  );
  const isolatable = shown !== null && canIsolate(vis, shown.result);
  const onIsolate = useMemo(
    () =>
      isolatable
        ? (key: string) => {
            setIsolatedKey((k) => toggleIsolation(k, key));
          }
        : null,
    [isolatable],
  );

  const lang = modules.lang;
  const runError = run.error;
  // The server maps PulsusDB's position to the raw text (ADR-0021 §3): the mapping is the identity.
  const diagnostics = useMemo(
    () =>
      !dirty && runError !== null && lang !== null
        ? lang.diagnosticsOf(q, runError, (i) => i, q)
        : NO_DIAGNOSTICS,
    [dirty, runError, lang, q],
  );
  const view = statusView({
    runRefusal,
    draftOver,
    runReady,
    editorLoaded: editorReady,
    run,
    diagnostics,
  });

  return (
    <InspectorHost
      surface="explore"
      filters={NO_FILTERS}
      originKey={originKey}
      onEditQuery={onEditQuery}
    >
      <div className={cx(styles['page'])}>
        <ContextSummary />
        <QueryCard
          modules={modules}
          tenant={tenant}
          q={q}
          source={source}
          meta={meta}
          diagnostics={diagnostics}
          onDraft={onDraft}
          onRun={onRun}
          onEscape={onEscape}
          onPick={onPick}
          status={<QueryStatus view={view} onNarrow={onNarrow} />}
          runReady={runReady}
          editorRef={editorRef}
          runButtonRef={runButtonRef}
        />
        {/* Keyed by tenant (T25 §8): a tenant change on this route gets a new chart, canvas and
            engine frame, so no mark or selection of the last tenant is ever drawn in this one. */}
        <ResultCard
          key={tenant}
          q={q}
          params={params}
          run={run}
          auto={auto}
          vis={vis}
          plan={plan}
          model={model}
          rows={rows}
          sort={sort}
          onSort={onSort}
          isolatedKey={isolatedKey}
          onIsolate={onIsolate}
          onVis={onVis}
          onRate={onRate}
          onNarrow={onNarrow}
          chartRef={chartRef}
        />
      </div>
    </InspectorHost>
  );
}
