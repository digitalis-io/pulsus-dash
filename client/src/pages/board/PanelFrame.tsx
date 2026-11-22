/**
 * Panel chrome (plan #61 Part B §4.3, plan #64 §3.7, A.11): a 40 px header with the title, the unit
 * subtitle, the completeness badge and the tools (Open in Explore, Full screen, Panel menu and, in
 * Edit mode, Move or resize), and the body drawn through `<ChartFrame>`. The header is the drag
 * handle in Edit mode. Tools stay in the tab order and show on hover and focus. The panel runs its
 * query through `usePanelRun` while it is in the viewport or at full screen (T07-012); a refetch
 * shows the shimmer after 300 ms (VL-015). `PanelPreview` is the panel editor's live preview (#90).
 */
import {
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type RefCallback,
} from 'react';
import { MenuTrigger, RouterProvider, type ButtonProps } from 'react-aria-components';
import { Link, useHref, useNavigate } from 'react-router';
import type { PanelSpec } from '../../api/types';
import { BoardRunContext } from '../../boards/boardRunContext';
import { exploreHref } from '../../boards/exploreLink';
import type { LayoutOp } from '../../boards/layout';
import { panelView, type PanelView } from '../../boards/panelRun';
import { usePanelRun, type PanelRun } from '../../boards/usePanelRun';
import { useInViewport } from '../../boards/visibility';
import { ChartFrame, type FrameSize } from '../../charts/ChartFrame';
import type { Unit } from '../../engine/api';
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
import { useTimeContext } from '../../state/useTimeContext';
import styles from './Board.module.css';
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

/**
 * A chart frame titled with the panel's current title (a rename shows at once). It shows the
 * panel's Loading until the engine has drawn it, and a new frame is sized from `sizeMemo` (#90).
 */
function PanelChart({
  title,
  view,
  sizeMemo,
}: {
  title: string;
  view: Extract<PanelView, { kind: 'frame' }>;
  sizeMemo: SizeMemo | undefined;
}) {
  const spec = useMemo(() => ({ ...view.spec, title }), [view.spec, title]);
  return (
    <ChartFrame
      fill
      spec={spec}
      data={view.data}
      pending={<p className={cx(styles['message'])}>{t('panel.loading')}</p>}
      {...(sizeMemo === undefined ? {} : { sizeMemo })}
    />
  );
}

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
  const view = useMemo(() => panelView(run, panel.vis.kind, title), [run, panel.vis.kind, title]);
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

/**
 * Memoised (#111): a board state change that leaves a panel's props alone (opening the panel
 * editor, an edit to another panel) does not render it. The page passes stable callbacks, and the
 * draft keeps the objects of the panels an edit does not touch.
 */
export const PanelFrame = memo(
  forwardRef<HTMLElement, PanelFrameProps>(function PanelFrame(
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
  const view = useMemo(() => panelView(run, panel.vis.kind, title), [run, panel.vis.kind, title]);
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
}),
);
