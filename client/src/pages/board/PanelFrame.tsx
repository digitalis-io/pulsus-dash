/**
 * Panel chrome (plan #61 Part B §4.3, plan #64 §3.7, A.11): a 40 px header with the title, the unit
 * subtitle, the completeness badge and the tools (Open in Explore, Full screen, Panel menu and, in
 * Edit mode, Move or resize), and the body drawn through `<ChartFrame>`. The header is the drag
 * handle in Edit mode. Tools stay in the tab order and show on hover and focus. The panel runs its
 * query through `usePanelRun` while it is in the viewport or at full screen (T07-012); a refetch
 * shows the shimmer after 300 ms (VL-015). `PanelPreview` is the panel editor's live preview (#90).
 * A line or bars body has its legend below the chart (a table, or compact on short panels) with
 * local isolation and the threshold highlights; a stat body has the state chip and the threshold
 * text (plan #64 Part B §3.9, §4.4, §4.5).
 */
import {
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode,
  type RefCallback,
  type RefObject,
} from 'react';
import { MenuTrigger, RouterProvider, type ButtonProps } from 'react-aria-components';
import { Link, useHref, useNavigate } from 'react-router';
import type { PanelSpec } from '../../api/types';
import { BoardRunContext } from '../../boards/boardRunContext';
import { exploreHref } from '../../boards/exploreLink';
import type { LayoutOp } from '../../boards/layout';
import {
  LEGEND_ROWS,
  legendRows,
  panelFrame,
  panelView,
  type PanelView,
} from '../../boards/panelRun';
import { useLegendLayout } from '../../boards/useLegendLayout';
import { usePanelRun, type PanelRun } from '../../boards/usePanelRun';
import { useInViewport } from '../../boards/visibility';
import { ChartFrame, type FrameSize } from '../../charts/ChartFrame';
import type { SeriesTableProps } from '../../charts/SeriesTable';
import { SeriesTable } from '../../charts/SeriesTable';
import { statValue } from '../../data/frames';
import type { ThresholdState, Unit } from '../../engine/api';
import { nextSort, sortRows, toggleIsolation, type SortState } from '../../explore/seriesRows';
import { useDelayedFlag } from '../../explore/useDelayedFlag';
import { useElementWidth } from '../../explore/useElementWidth';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { Icon } from '../../kit/Icon';
import { IconButton } from '../../kit/IconButton';
import { Menu, MenuItem } from '../../kit/Menu';
import { Popover } from '../../kit/Popover';
import { StateGlyph } from '../../kit/StateGlyph';
import { useTimeContext } from '../../state/useTimeContext';
import { StateEncoding } from '../../theme/stateEncoding';
import {
  crossed,
  displayText,
  nextStep,
  stateOf as thresholdState,
  type Thresholds,
} from '../../vis/thresholds';
import styles from './Board.module.css';
import { LegendCompact } from './LegendCompact';
import { PanelFullScreen } from './PanelFullScreen';
import { PanelNotices } from './PanelNotices';

/** The shimmer's delay (VL-015). */
const SHIMMER_MS = 300;

export function panelTitle(p: PanelSpec): string {
  return p.title === '' ? t('panel.untitled') : p.title;
}

/** `rps`, `lines`, `s`, `ms`: the unit's suffix or base; none for plain numbers. */
function unitText(u: Unit): string | null {
  switch (u.kind) {
    case 'suffix':
      return u.suffix;
    case 'time':
      return u.base;
    case 'bytes':
      return 'B';
    case 'percent':
    case 'percentunit':
      return '%';
    case 'none':
      return null;
  }
}

const KEY_OPS: Readonly<Record<string, readonly [LayoutOp, LayoutOp]>> = {
  ArrowLeft: ['left', 'narrower'],
  ArrowRight: ['right', 'wider'],
  ArrowUp: ['up', 'shorter'],
  ArrowDown: ['down', 'taller'],
};

/** The layout op of an arrow key on the Move or resize button: arrows move, Shift+arrows resize. */
export function keyOp(e: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): LayoutOp | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const ops = KEY_OPS[e.key];
  return ops === undefined ? null : ops[e.shiftKey ? 1 : 0];
}

/** `data-panel-state`: the view kind, or the message's state. */
function stateOf(v: PanelView): string {
  return v.kind === 'message' ? v.state : v.kind;
}

/** The host's last non-empty size, held above `ChartFrame` across its unmounts (#90). */
export type SizeMemo = { current: FrameSize | null };

type FrameView = Extract<PanelView, { kind: 'frame' }>;

/** A legend cell's highlight: watch, degraded or failing; ok, unknown and none show none (§4.5). */
function legendState(t: Thresholds, v: number | null): ThresholdState | null {
  const s = thresholdState(t, v);
  return s === 'watch' || s === 'degraded' || s === 'failing' ? s : null;
}

/** The stat tile's chip state and the step its threshold text shows (§4.4). */
function statState(t: Thresholds, view: FrameView) {
  const raw = statValue(view.data);
  const v = Number.isFinite(raw) ? raw : null;
  const hit = v === null ? null : crossed(t, v);
  return {
    chip: v === null ? 'unknown' : (hit?.state ?? 'ok'),
    hit,
    step: hit ?? nextStep(t, v),
  } as const;
}

/** The stat tile (§3.9, §4.4): the state chip, the chart and the threshold text. */
function StatStack({
  t,
  view,
  chart,
  cellRef,
}: {
  t: Thresholds | null;
  view: FrameView;
  chart: ReactNode;
  cellRef: RefObject<HTMLDivElement | null>;
}) {
  const s = t === null ? null : statState(t, view);
  return (
    <div className={cx(styles['statStack'])} data-stat-stack="">
      {s !== null && (
        <div className={cx(styles['statChip'])} data-stat-chip="" data-state={s.chip}>
          <StateGlyph state={s.chip} />
        </div>
      )}
      <div ref={cellRef} className={cx(styles['chartCell'])}>
        {chart}
      </div>
      {t !== null && s?.step != null && (
        <p
          className={cx(
            styles['statThreshold'],
            s.hit === null ? undefined : StateEncoding[s.hit.state].className,
          )}
          data-stat-threshold=""
          data-crossed={s.hit === null ? undefined : ''}
        >
          <span aria-hidden="true">{StateEncoding[s.step.state].glyph}</span>{' '}
          {displayText(t, s.step, view.spec.unit)}
        </p>
      )}
    </div>
  );
}

/**
 * A chart frame titled with the panel's current title (a rename shows at once). It shows the
 * panel's Loading until the engine has drawn it, and a new frame is sized from `sizeMemo` (#90).
 * Line and bars stack the legend under the chart; stat stacks the chip, the chart and the
 * threshold text (§3.9). The isolation and the legend sort are this instance's own, never saved.
 * Memoised: a board change that leaves a panel's view and title alone (an edit to another panel,
 * opening the editor) does not render its chart or legend again.
 */
const PanelChart = memo(function PanelChart({
  title,
  view,
  sizeMemo,
}: {
  title: string;
  view: FrameView;
  sizeMemo: SizeMemo | undefined;
}) {
  const [isolatedKey, setIsolatedKey] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);
  const [stackRef, layout, measured] = useLegendLayout();
  const cellRef = useRef<HTMLDivElement>(null);
  const rows = legendRows(view.result);
  const legend = view.legend === 'table' && rows.length > 0;
  // The chart cell is smaller than the body by the legend or the stat's chip and text: its size
  // goes into the memo in the commit, before the chart's mount effect pre-sizes from it, so a
  // re-created chart is sized once and draws in its first frame (#90, ADR-0019).
  const structure = `${view.vis}|${String(legend)}|${layout}|${String(measured)}|${String(view.thresholds !== null)}`;
  const ownMemo = useRef<FrameSize | null>(null);
  const memo = sizeMemo ?? ownMemo;
  // eslint-disable-next-line react-hooks/immutability -- the memo is the caller's ref, kept for the chart's pre-size (#90)
  useLayoutEffect(() => {
    const el = cellRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) memo.current = { width: r.width, height: r.height };
  }, [structure, memo]);
  // A new result without the isolated series shows all again.
  const isolation =
    isolatedKey !== null && rows.some((r) => r.key === isolatedKey) ? isolatedKey : null;
  const frame = useMemo(() => panelFrame(view, isolation), [view, isolation]);
  const spec = useMemo(() => ({ ...frame.spec, title }), [frame.spec, title]);
  const sorted = useMemo(() => sortRows(rows, sort), [rows, sort]);
  const chart = (
    <ChartFrame
      fill
      spec={spec}
      data={frame.data}
      pending={<p className={cx(styles['message'])}>{t('panel.loading')}</p>}
      sizeMemo={memo}
    />
  );
  if (view.vis === 'heatmap') return chart;
  if (view.vis === 'stat') {
    return <StatStack t={view.thresholds} view={view} chart={chart} cellRef={cellRef} />;
  }
  const th = view.thresholds;
  const table: SeriesTableProps = {
    caption: t('panel.legend.caption'),
    columns: ['mean', 'max', 'last'],
    maxRows: LEGEND_ROWS,
    swatches: true,
    onIsolate: (key) => {
      setIsolatedKey(toggleIsolation(isolation, key));
    },
    ...(th === null ? {} : { cellState: (v: number | null) => legendState(th, v) }),
    sort,
    onSort: (c) => {
      setSort((s) => nextSort(s, c));
    },
    unit: spec.unit,
    rows: sorted,
    total: rows.length,
    isolatedKey: isolation,
  };
  return (
    <div ref={stackRef} className={cx(styles['frameStack'])} data-legend={view.legend}>
      {/* The chart mounts once the stack is measured, so the legend layout is final (see above). */}
      <div ref={cellRef} className={cx(styles['chartCell'])}>
        {measured ? chart : null}
      </div>
      {legend &&
        (layout === 'table' ? (
          <div className={cx(styles['legend'])} data-panel-legend="table">
            <SeriesTable {...table} />
          </div>
        ) : (
          <LegendCompact table={table} />
        ))}
    </div>
  );
});

export function PanelBody({
  title,
  view,
  sizeMemo,
  onNarrow,
}: {
  title: string;
  view: PanelView;
  /** Kept by the caller (board panel, full screen, preview), above the chart (#90). */
  sizeMemo?: SizeMemo;
  onNarrow: () => void;
}) {
  switch (view.kind) {
    case 'frame':
      return <PanelChart title={title} view={view} sizeMemo={sizeMemo} />;
    case 'loading':
      return <p className={cx(styles['message'])}>{t('panel.loading')}</p>;
    case 'message':
      return <p className={cx(styles['message'])}>{view.text}</p>;
    case 'error':
      return (
        <EmptyState title={t('error.generic')}>
          <div className={cx(styles['panelError'])}>
            <p role="alert" className={cx(styles['panelErrorDetail'])}>
              {view.detail}
            </p>
            {view.narrow && (
              <Button variant="ghost" onPress={onNarrow}>
                {t('explore.narrow')}
              </Button>
            )}
          </div>
        </EmptyState>
      );
  }
}

/** The completeness badge shows with any frame or message view of an outcome (§4.2). */
function noticesOf(run: PanelRun, view: PanelView) {
  return run.outcome !== null && (view.kind === 'frame' || view.kind === 'message')
    ? run.outcome.result.completeness
    : null;
}

/**
 * The editor's live preview (#90): the panel's header text and body, from the editor's run.
 * `bodyRef` measures the preview body (the run's width when the panel has none yet).
 */
export function PanelPreview({
  panel,
  run,
  bodyRef,
}: {
  panel: PanelSpec;
  run: PanelRun;
  bodyRef?: RefCallback<HTMLDivElement>;
}) {
  const { dispatch } = useTimeContext();
  const title = panelTitle(panel);
  const view = useMemo(() => panelView(run, panel.vis, title), [run, panel.vis, title]);
  // The preview host's size, across message states (Appendix C §C.2).
  const frameSize = useRef<FrameSize | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    // Same API and box as ChartFrame's observer (content box), so both write equal values.
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r !== undefined && r.width > 0 && r.height > 0) {
        frameSize.current = { width: r.width, height: r.height };
      }
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
    };
  }, []);
  const onNarrow = useCallback(() => {
    dispatch({ type: 'zoom', dir: 'in' });
  }, [dispatch]);
  const unit = view.kind === 'frame' ? unitText(view.spec.unit) : null;
  return (
    <section
      className={cx(styles['panel'], styles['preview'])}
      aria-label={t('editor.preview')}
      data-panel-preview=""
      data-panel-state={stateOf(view)}
      data-panel-vis={view.kind === 'frame' ? view.vis : undefined}
    >
      <div className={cx(styles['panelHeader'])}>
        <div className={cx(styles['titles'])}>
          <p
            className={cx(styles['title'], panel.title === '' ? styles['untitled'] : undefined)}
            title={title}
            data-preview-title=""
          >
            {title}
          </p>
          {unit !== null && <p className={cx(styles['unit'])}>{t('panel.unit', { unit })}</p>}
        </div>
      </div>
      <div ref={bodyRef} className={cx(styles['body'])} data-preview-body="">
        <div ref={hostRef} className={cx(styles['previewHost'])} data-preview-host="">
          <PanelBody title={title} view={view} sizeMemo={frameSize} onNarrow={onNarrow} />
        </div>
      </div>
    </section>
  );
}

export interface PanelFrameProps {
  panel: PanelSpec;
  tenant: string;
  mode: 'view' | 'edit';
  /** A save is in flight: the layout button, Duplicate and Remove are disabled. */
  readOnly: boolean;
  selected: boolean;
  /** §4.4: the edited panel's run text (the dialog's); else the saved text runs. */
  runText?: string;
  onEdit: (id: string) => void;
  onKeyOp: (id: string, op: LayoutOp) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  /** Set by the View-mode grid: the panel is placed from these custom properties. */
  className?: string;
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref !== null) ref.current = value;
}

export const PanelFrame = forwardRef<HTMLElement, PanelFrameProps>(function PanelFrame(
  {
    panel,
    tenant,
    mode,
    readOnly,
    selected,
    runText,
    onEdit,
    onKeyOp,
    onDuplicate,
    onRemove,
    className,
  },
  ref,
) {
  const headingId = useId();
  const { search, dispatch } = useTimeContext();
  const navigate = useNavigate();
  const [full, setFull] = useState(false);
  // The root element, for the board's viewport tracker.
  const [el, setEl] = useState<HTMLElement | null>(null);
  const visible = useInViewport(el);
  const [bodyRef, widthPx] = useElementWidth<HTMLDivElement>();
  const { widths } = useContext(BoardRunContext);
  // The last known width stays in the store across a remount (the Edit grid), so the preview keeps
  // sharing the panel's key while the new body is measured.
  useEffect(() => {
    if (widthPx !== null) widths.set(panel.id, widthPx);
  }, [widths, panel.id, widthPx]);
  const run = usePanelRun({
    tenant,
    panel,
    text: runText ?? panel.query.text,
    enabled: visible || full,
    widthPx,
  });
  const title = panelTitle(panel);
  const view = useMemo(() => panelView(run, panel.vis, title), [run, panel.vis, title]);
  const shimmer = useDelayedFlag(run.fetching, SHIMMER_MS);
  const notices = noticesOf(run, view);
  // The body's size, across message states and remounts of its chart (#90); full screen holds its own.
  const frameSize = useRef<FrameSize | null>(null);
  const unit = view.kind === 'frame' ? unitText(view.spec.unit) : null;
  const g = panel.grid;
  const explore = exploreHref(tenant, panel, search, run.expanded);
  const onNarrow = useCallback(() => {
    dispatch({ type: 'zoom', dir: 'in' });
  }, [dispatch]);

  const rootRef = (node: HTMLElement | null): void => {
    assignRef(ref, node);
    if (node !== null) setEl(node);
  };

  const onLayoutKey = (e: Parameters<NonNullable<ButtonProps['onKeyDown']>>[0]): void => {
    const op = keyOp(e);
    if (op === null) {
      // Other keys (Tab, the board keys) carry on to their handlers.
      e.continuePropagation();
      return;
    }
    e.preventDefault();
    onKeyOp(panel.id, op);
  };

  return (
    <section
      ref={rootRef}
      className={cx(styles['panel'], className)}
      aria-labelledby={headingId}
      data-panel={panel.id}
      data-grid={[g.x, g.y, g.w, g.h].join(',')}
      data-vis={panel.vis.kind}
      data-panel-state={stateOf(view)}
      data-panel-vis={view.kind === 'frame' ? view.vis : undefined}
      data-selected={selected ? '' : undefined}
    >
      <div
        className={cx(styles['panelHeader'])}
        data-drag-handle={mode === 'edit' ? '' : undefined}
      >
        <div className={cx(styles['titles'])}>
          <h3
            id={headingId}
            className={cx(styles['title'], panel.title === '' ? styles['untitled'] : undefined)}
            title={title}
          >
            {title}
          </h3>
          {unit !== null && <p className={cx(styles['unit'])}>{t('panel.unit', { unit })}</p>}
          {notices !== null && (
            <PanelNotices title={title} completeness={notices} onNarrow={onNarrow} />
          )}
        </div>
        <div className={cx(styles['tools'])}>
          {explore === null ? (
            <IconButton
              icon="square-arrow-out-up-right"
              aria-label={t('panel.explore', { title })}
              isDisabled
            />
          ) : (
            <Link
              to={explore}
              className={cx(styles['tool'])}
              aria-label={t('panel.explore', { title })}
            >
              <Icon name="square-arrow-out-up-right" />
            </Link>
          )}
          <IconButton
            icon="maximize-2"
            aria-label={t('panel.fullScreen', { title })}
            onPress={() => {
              setFull(true);
            }}
          />
          <RouterProvider
            navigate={(to) => {
              void navigate(to);
            }}
            useHref={useHref}
          >
            <MenuTrigger>
              <IconButton
                icon="ellipsis"
                aria-label={t('panel.menu', { title })}
                data-panel-menu=""
              />
              <Popover placement="bottom end">
                <Menu aria-label={t('panel.menu', { title })}>
                  <MenuItem
                    id="edit"
                    onAction={() => {
                      onEdit(panel.id);
                    }}
                  >
                    {t('panel.editPanel')}
                  </MenuItem>
                  <MenuItem
                    id="duplicate"
                    isDisabled={readOnly}
                    onAction={() => {
                      onDuplicate(panel.id);
                    }}
                  >
                    {t('panel.duplicate')}
                  </MenuItem>
                  <MenuItem
                    id="remove"
                    isDisabled={readOnly}
                    onAction={() => {
                      onRemove(panel.id);
                    }}
                  >
                    {t('panel.remove')}
                  </MenuItem>
                  <MenuItem
                    id="explore"
                    {...(explore === null ? { isDisabled: true } : { href: explore })}
                  >
                    {t('panel.openExplore')}
                  </MenuItem>
                  <MenuItem
                    id="copy"
                    onAction={() => {
                      // On the gesture (T08-021); a refused clipboard leaves nothing to undo.
                      navigator.clipboard.writeText(panel.query.text).catch(() => undefined);
                    }}
                  >
                    {t('panel.copyQuery')}
                  </MenuItem>
                </Menu>
              </Popover>
            </MenuTrigger>
          </RouterProvider>
          {mode === 'edit' && (
            <Button
              variant="ghost"
              className={cx(styles['tool'])}
              aria-label={t('panel.layout', { title })}
              isDisabled={readOnly}
              onKeyDown={onLayoutKey}
            >
              <Icon name="move" />
            </Button>
          )}
        </div>
      </div>
      <div ref={bodyRef} className={cx(styles['body'])} aria-busy={shimmer ? true : undefined}>
        {shimmer && <div className={cx(styles['shimmer'])} data-shimmer="" aria-hidden="true" />}
        <PanelBody title={title} view={view} sizeMemo={frameSize} onNarrow={onNarrow} />
      </div>
      <PanelFullScreen
        isOpen={full}
        title={title}
        view={view}
        onNarrow={onNarrow}
        onClose={() => {
          setFull(false);
        }}
      />
    </section>
  );
});
