/**
 * The geomap panel body (T24-088, T24-092 to T24-095; plan #234 Part 3 §4.1–§4.5, §4.4a): a lazy
 * chunk that the board route's `GeoMapBody` imports. It plans with `planGeo` and renders
 * `<ChartFrame surface="geo">` for `empty`, `noneShown` and `ok`, and owns the rest of the panel:
 *
 * - **View** (T24-088): `lastView` (the latest `geoCommit`) and `applied` (the last applied
 *   `options.view`); a new `options.view` by value wins once, else the last commit holds, so an
 *   engine swap starts where the user left the map.
 * - **Events**: exactly `geoCommit`, `geoBrush` and `geoMarks` of each engine frame (`onFrame`),
 *   disposed with it; `ChartFrame` keeps `select` and `hover`.
 * - **Selection** (T24-092): a brush selects its keys; an empty click clears; the legend selects a
 *   group (`member`) or inspects the aggregate; the table toggles one row (`tableRow`) and inspects
 *   any row. The editor preview (`inspectorSource` false) neither inspects nor selects.
 * - **The mark list, legend, meter and table** (T24-093, T24-094): Tab surface → list → legend →
 *   meter; Shift+T toggles the table; Show table focuses its first toggle.
 * - **States** (T24-095, §4.12): a status region from the first render of every state but `ok`,
 *   busy while loading with "Loading…" after 300 ms; on a state change focus moves to the new
 *   state's target only when it was inside this panel, then one polite announcement (T08-018).
 * - **Load failure** (§4.4a): a geomap summary with no geo part calls `onLoadFailed`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  ChartFrame as EngineFrame,
  FrameSummary,
  GeoMarksEvent,
  GeoView,
} from '../engine/api';
import { t } from '../i18n/t';
import { useInspector, useSelection } from '../inspector/host';
import type { InspectorTarget } from '../inspector/types';
import { usePoliteAnnouncer } from '../kit/announce';
import { Button } from '../kit/Button';
import { cx } from '../kit/cx';
import { useTimeZone } from '../state/timeZone';
import { loadGeoData } from '../vis/geo/assets';
import type { GeoRow } from '../vis/geo/frame';
import {
  MIN_MAP_H,
  MIN_MAP_W,
  planGeo,
  type GeoMapFrameProps,
  type GeoPlan,
} from '../vis/geo/plan';
import { geoTable } from '../vis/geo/rows';
import { geoTarget } from '../vis/geo/targets';
import type { GeoData } from '../vis/geo/types';
import { coverageText } from '../vis/reduce';
import { ChartFrame, type FrameSize } from './ChartFrame';
import { CoverageMeter } from './CoverageMeter';
import { GeoLegend } from './geo/GeoLegend';
import { GeoMarkList } from './geo/GeoMarkList';
import { drawStatusText, invalidText } from './geo/geoText';
import styles from './GeoMapFrame.module.css';
import { PanelTable } from './PanelTable';

export type { GeoMapFrameProps } from '../vis/geo/plan';

export interface GeoMapFrameHostProps extends Omit<GeoMapFrameProps, 'geoData'> {
  /** Absent: the shared `loadGeoData()` (`'loading'` until it resolves). */
  readonly geoData?: GeoData | 'loading';
  /** False in the editor preview: no member registration, inspect or select (§4.1). */
  readonly inspectorSource?: boolean;
  /** The map renderer could not load (§4.4a). */
  readonly onLoadFailed?: () => void;
}

/** "Loading…" shows this long after a load starts (VL-015, T24-095). */
const LOADING_TEXT_MS = 300;

/** Views equal by value (null included). */
function sameView(a: GeoView | null, b: GeoView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.lat === b.lat && a.lon === b.lon && a.zoom === b.zoom;
}

/** Reduced motion, read once per mount (VL-016): `cut` every ease and fade. */
function motionOf(): 'ease' | 'cut' {
  try {
    return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'cut' : 'ease';
  } catch {
    return 'ease';
  }
}

/** True for a key typed into a text field, where Shift+T is a capital T. */
function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select') !== null) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** The shared assets, or the caller's. */
function useGeoData(given: GeoData | 'loading' | undefined): GeoData | 'loading' {
  const [loaded, setLoaded] = useState<GeoData | 'loading'>('loading');
  useEffect(() => {
    if (given !== undefined) return;
    let live = true;
    void loadGeoData().then((d) => {
      if (live) setLoaded(d);
    });
    return () => {
      live = false;
    };
  }, [given]);
  return given ?? loaded;
}

/** The view hand-off of T24-088: `lastView` and `applied`, adjusted during render. */
function useView(optionView: GeoView | null): {
  view: GeoView | null;
  commit: (v: GeoView) => void;
} {
  const [s, setS] = useState<{ last: GeoView | null; applied: GeoView | null }>({
    last: null,
    applied: optionView,
  });
  let cur = s;
  if (!sameView(optionView, s.applied)) {
    cur = { last: null, applied: optionView };
    setS(cur);
  }
  const commit = useCallback((v: GeoView) => {
    setS((x) => (sameView(x.last, v) ? x : { ...x, last: v }));
  }, []);
  return { view: cur.last ?? optionView, commit };
}

/**
 * `planGeo` with stable outputs: the rows and the frame are rebuilt only when what they are made of
 * changes (the result, the options but the view, the thresholds, the assets, the run's state, the
 * size class, the motion and the stale time), and the view only replaces the spec's, so a refetch
 * start, a selection or a commit does not hand the engine new data (a new `setData` refits an
 * unmoved map and sends its marks again).
 */
function useGeoPlan(
  p: GeoMapFrameProps,
  size: FrameSize,
  view: GeoView | null,
  motion: 'ease' | 'cut',
  staleAtMs: number | null,
): GeoPlan {
  const run = p.run;
  const result = run.outcome?.result ?? null;
  const optsKey = JSON.stringify({ ...p.options, view: null });
  const thKey = JSON.stringify(p.thresholds);
  const gazetteer = p.geoData === 'loading' ? null : p.geoData.gazetteer;
  const small = size.width < MIN_MAP_W || size.height < MIN_MAP_H;
  const runKey = [run.outcome === null, run.error !== null, run.placeholder, run.fetching].join();
  const unitKey = JSON.stringify(p.unit);
  // +1 per new row set (T24-088's `seq`), adjusted during render.
  const [rs, setRs] = useState({ result, optsKey, thKey, gazetteer, seq: 1 });
  let seq = rs.seq;
  if (
    rs.result !== result ||
    rs.optsKey !== optsKey ||
    rs.thKey !== thKey ||
    rs.gazetteer !== gazetteer
  ) {
    seq = rs.seq + 1;
    setRs({ result, optsKey, thKey, gazetteer, seq });
  }
  const base = useMemo(
    () => planGeo(p, size, null, { seq, motion, staleAtMs }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the plan is a function of these
    [result, optsKey, thKey, p.geoData, small, seq, motion, staleAtMs, runKey, p.title, unitKey],
  );
  return useMemo(
    () => ('spec' in base ? { ...base, spec: { ...base.spec, view } } : base),
    [base, view],
  );
}

export default function GeoMapFrame(props: GeoMapFrameHostProps): JSX.Element {
  const { panelId, title, unit, run, onInspect, onLoadFailed } = props;
  const source = props.inspectorSource ?? true;
  const api = useInspector();
  const host = source ? api : null;
  const inspect = source ? onInspect : undefined;
  const selection = useSelection();
  const timeZone = useTimeZone();
  const geoData = useGeoData(props.geoData);
  const rootRef = useRef<HTMLDivElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const ownMemo = useRef<FrameSize | null>(null);
  const memo = props.sizeMemo ?? ownMemo;
  /** 0 × 0 until measured: the caller's memo, then the observer. */
  const [size, setSize] = useState<FrameSize>({ width: 0, height: 0 });
  const [motion] = useState(motionOf);
  const { view, commit } = useView(props.options.view);
  const [frame, setFrame] = useState<EngineFrame | null>(null);
  const [marks, setMarks] = useState<GeoMarksEvent | null>(null);
  const [summaryView, setSummaryView] = useState<GeoView | null>(null);
  const [table, setTable] = useState(false);
  /** The user opened the table (focus its first toggle once) or closed it (focus back to the map). */
  const tableIntent = useRef<'open' | 'close' | null>(null);
  const [focusToggle, setFocusToggle] = useState(false);
  const tableOn = useRef(table);
  /** Rows exist (T24 §4.12: the table is disabled while loading, after an error or invalid data). */
  const rowsOn = useRef(false);
  useLayoutEffect(() => {
    tableOn.current = table;
  });
  /** An explicit open or close of the table (Shift+T, Show table, the table's close). */
  const userTable = useCallback((on: boolean) => {
    tableIntent.current = on ? 'open' : 'close';
    setFocusToggle(on);
    setTable(on);
  }, []);
  const { text: liveText, announce } = usePoliteAnnouncer();

  // The cell's content box: the caller's memo first (before paint, so a re-mounted map plans at
  // once), then the observer; a hidden cell (0 × 0) keeps the last size.
  // eslint-disable-next-line react-hooks/immutability -- the memo is the caller's ref, kept for the pre-size (#90)
  useLayoutEffect(() => {
    const apply = (width: number, height: number): void => {
      if (!(width > 0) || !(height > 0)) return;
      memo.current = { width, height };
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    const last = memo.current;
    if (last !== null) apply(last.width, last.height);
    const el = cellRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r !== undefined) apply(r.width, r.height);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [memo]);

  // When a same-key refetch failure was first seen (the meter's `stale (HH:mm:ss)`).
  const keptFailure = run.error !== null && run.outcome !== null && !run.placeholder;
  // The time is taken in the effect that sees the failure (below); a recovery clears it here.
  const [staleAt, setStaleAt] = useState<number | null>(null);
  if (!keptFailure && staleAt !== null) setStaleAt(null);
  const staleAtMs = keptFailure ? staleAt : null;

  const plan = useGeoPlan({ ...props, geoData }, size, view, motion, staleAtMs);
  const state = plan.state;
  const rows = 'rows' in plan ? plan.rows : null;
  const rowMap = useMemo(
    () => new Map<string, GeoRow>((rows?.rows ?? []).map((r) => [r.key, r])),
    [rows],
  );
  const seq = 'data' in plan ? plan.data.geo.seq : 0;
  const complete =
    rows !== null && coverageText(rows.coverage, timeZone) === t('coverage.complete');

  // The engine frame's geo events (T24-088): exactly these three, disposed with it.
  const latest = useRef({ host, panelId, commit, active: null as string | null });
  useLayoutEffect(() => {
    latest.current = { ...latest.current, host, panelId, commit };
  });
  const offs = useRef<(() => void)[]>([]);
  const onFrame = useCallback((f: EngineFrame | null) => {
    for (const off of offs.current) off();
    offs.current = [];
    setFrame(f);
    setMarks(null);
    if (f === null) return;
    offs.current = [
      f.on('geoCommit', (c) => {
        latest.current.commit(c.view);
      }),
      f.on('geoBrush', (b) => {
        const l = latest.current;
        if (b.keys.length === 0) return;
        l.host?.select(
          { keys: [...b.keys], fromMs: null, toMs: null },
          { kind: 'brush', panelId: l.panelId },
        );
      }),
      f.on('geoMarks', (m) => {
        setMarks(m);
      }),
    ];
    // A new frame (an engine swap) gets the list's focus mark.
    const active = latest.current.active;
    if (active !== null) f.setFocusMark(active);
  }, []);
  useEffect(
    () => () => {
      for (const off of offs.current) off();
      offs.current = [];
    },
    [],
  );

  const onSummary = useCallback(
    (s: FrameSummary) => {
      if (s.kind !== 'geomap') return;
      if (s.geo === null) onLoadFailed?.();
      else setSummaryView(s.geo.view);
    },
    [onLoadFailed],
  );

  /** The list's focused mark; focus leaving both the list and the surface clears it (T24-093). */
  const onActive = useCallback(
    (id: string | null) => {
      if (id !== null) {
        latest.current.active = id;
        frame?.setFocusMark(id);
        return;
      }
      queueMicrotask(() => {
        const root = rootRef.current;
        const el = document.activeElement;
        const surface = root?.querySelector('[data-chart-frame]');
        const list = root?.querySelector('[data-geo-list]');
        if (el !== null && (surface?.contains(el) === true || list?.contains(el) === true)) return;
        latest.current.active = null;
        frame?.setFocusMark(null);
      });
    },
    [frame],
  );

  const inspectGeo = useCallback(
    (target: InspectorTarget, from: 'pointer' | 'keyboard', el: HTMLElement | null) => {
      inspect?.(target, from, el);
    },
    [inspect],
  );
  const onEmptyClick = useCallback(() => {
    const l = latest.current;
    l.host?.select(null, { kind: 'mark', panelId: l.panelId });
  }, []);

  // Shift+T flips the table (native listener: the root is no control of its own).
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'T' && e.key !== 't') return;
      if (inTextField(e.target)) return;
      // No rows: the table is disabled, so nothing is queued (review r2).
      if (!rowsOn.current) return;
      e.preventDefault();
      userTable(!tableOn.current);
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
    };
  }, [userTable]);
  const hasRows = rows !== null;
  useLayoutEffect(() => {
    rowsOn.current = hasRows;
  });
  const showTable = table && hasRows;
  const tableRows = useMemo(() => (rows === null ? null : geoTable(rows, unit)), [rows, unit]);
  // States (T24-095) and the table: focus moves only while it is in this panel.
  const inside = useRef(false);
  /** Focus is in this panel, or was when its element went away. */
  const focusInside = (): boolean => {
    const root = rootRef.current;
    const active = document.activeElement;
    if (root === null) return false;
    if (root.contains(active)) return true;
    return (active === null || active === document.body) && inside.current;
  };
  // Focus follows only the user's own open and close (review r1): an explicit open focuses the
  // table's first toggle (`focusFirstToggle`, once); an explicit close focuses Show table, else the
  // map, else the status, and only while focus is still in this panel. A table that goes away or
  // comes back with a state change moves nothing (the state's own rule applies).
  const tableShown = useRef(showTable);
  useEffect(() => {
    if (tableShown.current === showTable) return;
    tableShown.current = showTable;
    const intent = tableIntent.current;
    tableIntent.current = null;
    if (showTable) return;
    const settle = (): void => {
      setFocusToggle(false);
    };
    settle();
    if (intent !== 'close' || !focusInside()) return;
    const root = rootRef.current;
    const to =
      root?.querySelector<HTMLElement>('[data-geo-show-table]') ??
      root?.querySelector<HTMLElement>('[data-chart-frame]') ??
      root?.querySelector<HTMLElement>('[data-geo-status]');
    to?.focus();
  }, [showTable]);

  // States (T24-095): focus and the announcement on a state change, from inside the panel only.
  const [loadingText, setLoadingText] = useState(false);
  if (state !== 'loading' && loadingText) setLoadingText(false);
  const loadingShown = useRef(false);
  const pendingOk = useRef<{ announce: boolean } | null>(null);
  const prevState = useRef<GeoPlan['state'] | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onIn = (): void => {
      inside.current = true;
    };
    const onOut = (e: FocusEvent): void => {
      const to = e.relatedTarget;
      const from = e.target;
      if (to instanceof Node) {
        if (!root.contains(to)) inside.current = false;
        return;
      }
      // No new target: focus left for nothing, or its element was removed (a state change).
      queueMicrotask(() => {
        if (from instanceof Node && from.isConnected && !root.contains(document.activeElement)) {
          inside.current = false;
        }
      });
    };
    root.addEventListener('focusin', onIn);
    root.addEventListener('focusout', onOut);
    return () => {
      root.removeEventListener('focusin', onIn);
      root.removeEventListener('focusout', onOut);
    };
  }, []);
  const measured = size.width > 0;
  useLayoutEffect(() => {
    // Before the first measure the plan's size is a placeholder: no state has been shown yet.
    if (!measured) return;
    const prev = prevState.current;
    prevState.current = state;
    if (prev === state) return;
    const quick = prev === 'loading' && !loadingShown.current;
    if (state !== 'loading') loadingShown.current = false;
    pendingOk.current = null;
    if (prev === null || !focusInside()) return;
    const root = rootRef.current;
    const q = (sel: string): HTMLElement | null => root?.querySelector<HTMLElement>(sel) ?? null;
    switch (state) {
      case 'loading':
        q('[data-geo-status]')?.focus();
        return;
      case 'error':
        q('[data-geo-retry]')?.focus();
        announce(t('geo.state.error'));
        return;
      case 'invalid':
      case 'empty':
      case 'noneShown': {
        const s = q('[data-geo-status]');
        s?.focus();
        announce(s?.textContent ?? '');
        return;
      }
      case 'mapDataUnavailable':
      case 'tooSmall':
        q('[data-geo-show-table]')?.focus();
        announce(q('[data-geo-status] p')?.textContent ?? '');
        return;
      case 'ok':
        // The list exists once the engine sends its marks.
        pendingOk.current = { announce: !quick };
        return;
    }
  });
  // Loading: "Loading…" after 300 ms (the status exists, busy, at once).
  useEffect(() => {
    if (state !== 'loading') return;
    const id = setTimeout(() => {
      loadingShown.current = true;
      setLoadingText(true);
    }, LOADING_TEXT_MS);
    return () => {
      clearTimeout(id);
    };
  }, [state]);
  // `ok`: the first item (or the placeholder) once the engine sent its marks, then "‹n› marks".
  useLayoutEffect(() => {
    const p = pendingOk.current;
    if (p === null || marks === null || state !== 'ok') return;
    pendingOk.current = null;
    // Focus left the panel while the marks were pending: no move, no announcement.
    if (!focusInside()) return;
    const root = rootRef.current;
    const first =
      root?.querySelector<HTMLElement>('[data-geo-list] button[tabindex="0"]') ??
      root?.querySelector<HTMLElement>('[data-geo-list] button');
    first?.focus();
    if (p.announce) {
      const n = marks.marks.filter((m) => m.inView).length;
      announce(n === 1 ? t('geo.state.oneMark') : t('geo.state.marks', { n }));
    }
  }, [marks, state, announce]);
  // A refetch that failed on the same key keeps the map: "Couldn't refresh" (§4.12 last row).
  const prevError = useRef<unknown>(run.error);
  useEffect(() => {
    const was = prevError.current;
    prevError.current = run.error;
    if (run.error === null || run.error === was || !keptFailure) return;
    const markStale = (): void => {
      setStaleAt(Date.now());
    };
    markStale();
    if (focusInside()) announce(t('geo.state.refreshFailed'));
  });

  const select = (keys: readonly string[], kind: 'member' | 'tableRow'): void => {
    host?.select({ keys: [...keys], fromMs: null, toMs: null }, { kind, panelId });
  };
  const selected = useMemo(() => new Set(selection?.keys ?? []), [selection]);

  const status = (body: JSX.Element | string, extra?: JSX.Element, busy = false): JSX.Element => (
    <div
      className={cx(styles['state'])}
      role="status"
      tabIndex={-1}
      aria-busy={busy ? true : undefined}
      data-geo-status=""
    >
      {body}
      {extra}
    </div>
  );
  const showTableButton = (
    <span className={cx(styles['action'])} data-geo-show-table-wrap="">
      <Button
        variant="secondary"
        onPress={() => {
          userTable(true);
        }}
        data-geo-show-table=""
      >
        {t('geo.state.showTable')}
      </Button>
    </span>
  );

  let body: JSX.Element | null = null;
  if (showTable && tableRows !== null) {
    body = (
      <PanelTable
        rows={tableRows}
        title={title}
        selected={selected}
        focusFirstToggle={focusToggle}
        toggle={{
          label: (key) => t('geo.table.select', { name: rowMap.get(key)?.name ?? key }),
          onToggle: (key) => {
            if (selected.has(key)) host?.select(null, { kind: 'tableRow', panelId });
            else select([key], 'tableRow');
          },
        }}
        onInspectRow={(key, el) => {
          const target = geoTarget(rows, seq, { kind: 'marker', id: key, keys: [key] });
          const from = el.matches(':focus-visible') ? 'keyboard' : 'pointer';
          inspectGeo({ type: 'geo', target }, from, el);
        }}
        rowNote={(key) => {
          const r = rowMap.get(key);
          return r === undefined || r.draw === 'shown' ? null : drawStatusText(r.draw);
        }}
        onClose={() => {
          userTable(false);
        }}
      />
    );
  } else {
    switch (plan.state) {
      case 'loading':
        body = status(loadingText ? t('geo.state.loading') : '', undefined, true);
        break;
      case 'error':
        body = status(
          <p>{t('geo.state.error')}</p>,
          <span className={cx(styles['action'])}>
            <Button
              variant="secondary"
              onPress={() => {
                run.retry();
              }}
              data-geo-retry=""
            >
              {t('geo.state.retry')}
            </Button>
          </span>,
        );
        break;
      case 'invalid':
        body = status(invalidText(plan.issue));
        break;
      case 'mapDataUnavailable':
        body = status(<p>{t('geo.state.mapDataUnavailable')}</p>, showTableButton);
        break;
      case 'tooSmall':
        body = status(
          <p>{t('geo.state.tooSmall', { n: plan.rows.rows.length })}</p>,
          showTableButton,
        );
        break;
      case 'empty':
      case 'noneShown':
      case 'ok':
        break;
    }
  }
  const framed = 'spec' in plan && !showTable ? plan : null;

  return (
    <div
      ref={rootRef}
      className={cx(styles['root'])}
      data-geomap=""
      data-geo-state={state}
      data-geo-view={
        summaryView === null
          ? undefined
          : [summaryView.lat, summaryView.lon, summaryView.zoom].join(',')
      }
    >
      <div ref={cellRef} className={cx(styles['cell'])}>
        {framed !== null && (
          <ChartFrame
            spec={framed.spec}
            data={framed.data}
            surface="geo"
            fill
            sizeMemo={memo}
            onFrame={onFrame}
            onSummary={onSummary}
            onEmptyClick={onEmptyClick}
            {...(inspect === undefined ? {} : { onInspect: inspectGeo })}
          />
        )}
        {framed !== null && framed.state !== 'ok' && (
          <div className={cx(styles['overlay'])}>
            <p className={cx(styles['over'])} role="status" tabIndex={-1} data-geo-status="">
              {framed.state === 'empty'
                ? t('geo.state.empty')
                : t('geo.state.noneShown', {
                    parts: coverageText(framed.rows.coverage, timeZone),
                  })}
            </p>
            {framed.state === 'noneShown' && showTableButton}
          </div>
        )}
        {framed?.state === 'ok' && marks !== null && (
          <GeoMarkList
            title={title}
            marks={marks.marks}
            rows={rowMap}
            unit={unit}
            complete={complete}
            selection={selection}
            frame={frame}
            seq={seq}
            rowSet={framed.rows}
            onInspect={(target, el) => {
              inspectGeo({ type: 'geo', target }, 'keyboard', el);
            }}
            onActive={onActive}
            announce={announce}
          />
        )}
        {body}
      </div>
      <div className={cx(styles['under'])}>
        {rows !== null && (
          <GeoLegend
            title={title}
            rows={rows}
            onGroup={(keys) => {
              select(keys, 'member');
            }}
            onAggregate={(from, el) => {
              const target = geoTarget(rows, seq, { kind: 'aggregate' });
              inspectGeo({ type: 'geo', target }, from, el);
            }}
          />
        )}
        <div className={cx(styles['meter'])} data-geo-meter="">
          {rows !== null ? (
            <CoverageMeter
              coverage={rows.coverage}
              onNarrow={() => undefined}
              focusable
              timeZone={timeZone}
            />
          ) : (
            <p className={cx(styles['meterText'])}>
              {state === 'loading' ? t('geo.meter.loading') : t('geo.meter.unavailable')}
            </p>
          )}
        </div>
      </div>
      <p aria-live="polite" className={cx(styles['srOnly'])} data-geo-live="">
        {liveText}
      </p>
    </div>
  );
}
