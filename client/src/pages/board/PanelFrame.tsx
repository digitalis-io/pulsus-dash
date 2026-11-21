/**
 * Panel chrome (plan #61 Part B §4.3): a 40 px header with the title, the unit subtitle and the
 * tools (Open in Explore, Full screen, Panel menu and, in Edit mode, Move or resize), and the body
 * drawn through `<ChartFrame>`. The header is the drag handle in Edit mode. Tools stay in the tab
 * order and show on hover and focus. `PanelPreview` is the panel editor's live preview (#90).
 */
import { useQuery } from '@tanstack/react-query';
import { forwardRef, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MenuTrigger, type ButtonProps } from 'react-aria-components';
import { Link } from 'react-router';
import { useApi } from '../../app/providers';
import type { PanelData, PanelSpec } from '../../api/types';
import { canonicalJson } from '../../boards/spec';
import type { LayoutOp } from '../../boards/layout';
import { ChartFrame, type FrameSize } from '../../charts/ChartFrame';
import type { Unit } from '../../engine/api';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { Icon } from '../../kit/Icon';
import { IconButton } from '../../kit/IconButton';
import { Menu, MenuItem } from '../../kit/Menu';
import { Popover } from '../../kit/Popover';
import { contextSearchString } from '../../state/contextSearch';
import { useTimeContext } from '../../state/useTimeContext';
import styles from './Board.module.css';
import { PanelFullScreen } from './PanelFullScreen';

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

/** The panel's data, shared by the panel body and its full-screen view (one query per key). */
export function usePanelData(tenant: string, panel: PanelSpec) {
  const api = useApi();
  const { window } = useTimeContext();
  return useQuery({
    queryKey: ['panel', tenant, panel.id, canonicalJson(panel.query), panel.vis.kind, window],
    queryFn: ({ signal }) => api.panelData(tenant, panel, window, signal),
    structuralSharing: false,
    retry: false,
  });
}

/** The host's last non-empty size, held above `ChartFrame` across its unmounts (#90). */
export type SizeMemo = { current: FrameSize | null };

/**
 * A chart frame titled with the panel's current title (a rename shows at once). It shows the
 * panel's Loading until the engine has drawn it, and a new frame is sized from `sizeMemo` (#90).
 */
function PanelChart({
  title,
  data,
  sizeMemo,
}: {
  title: string;
  data: Extract<PanelData, { kind: 'frame' }>;
  sizeMemo: SizeMemo | undefined;
}) {
  const spec = useMemo(() => ({ ...data.spec, title }), [data.spec, title]);
  return (
    <ChartFrame
      fill
      spec={spec}
      data={data.data}
      pending={<p className={cx(styles['message'])}>{t('panel.loading')}</p>}
      {...(sizeMemo === undefined ? {} : { sizeMemo })}
    />
  );
}

export function PanelBody({
  title,
  data,
  isError,
  sizeMemo,
}: {
  title: string;
  data: PanelData | undefined;
  isError: boolean;
  /** Kept by the caller (board panel, full screen, preview), above the chart (#90). */
  sizeMemo?: SizeMemo;
}) {
  if (isError) return <EmptyState title={t('error.generic')} />;
  if (data === undefined) return <p className={cx(styles['message'])}>{t('panel.loading')}</p>;
  switch (data.kind) {
    case 'frame':
      return <PanelChart title={title} data={data} sizeMemo={sizeMemo} />;
    case 'noRoute':
      return (
        <p className={cx(styles['message'])}>
          {t(data.lang === 'promql' ? 'panel.noRoute.promql' : 'panel.noRoute.logql')}
        </p>
      );
    case 'noVis':
      return <p className={cx(styles['message'])}>{t('panel.noVis')}</p>;
  }
}

/** The editor's live preview (#90): the panel's header text and body, from the shared query. */
export function PanelPreview({ panel, tenant }: { panel: PanelSpec; tenant: string }) {
  const data = usePanelData(tenant, panel);
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
  const title = panelTitle(panel);
  const unit = data.data?.kind === 'frame' ? unitText(data.data.spec.unit) : null;
  return (
    <section
      className={cx(styles['panel'], styles['preview'])}
      aria-label={t('editor.preview')}
      data-panel-preview=""
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
      <div className={cx(styles['body'])} data-preview-body="">
        <div ref={hostRef} className={cx(styles['previewHost'])} data-preview-host="">
          <PanelBody title={title} data={data.data} isError={data.isError} sizeMemo={frameSize} />
        </div>
      </div>
    </section>
  );
}

export interface PanelFrameProps {
  panel: PanelSpec;
  tenant: string;
  mode: 'view' | 'edit';
  /** A save is in flight: the layout button is disabled. */
  readOnly: boolean;
  selected: boolean;
  onEdit: (id: string) => void;
  onKeyOp: (id: string, op: LayoutOp) => void;
  /** Set by the View-mode grid: the panel is placed from these custom properties. */
  className?: string;
}

export const PanelFrame = forwardRef<HTMLElement, PanelFrameProps>(function PanelFrame(
  { panel, tenant, mode, readOnly, selected, onEdit, onKeyOp, className },
  ref,
) {
  const headingId = useId();
  const { search } = useTimeContext();
  const [full, setFull] = useState(false);
  const data = usePanelData(tenant, panel);
  // The body's size, across message states and remounts of its chart (#90); full screen holds its own.
  const frameSize = useRef<FrameSize | null>(null);
  const title = panelTitle(panel);
  const unit = data.data?.kind === 'frame' ? unitText(data.data.spec.unit) : null;
  const g = panel.grid;
  const explore = `/t/${tenant}/explore/${panel.query.lang === 'promql' ? 'metrics' : 'logs'}${contextSearchString(search)}&q=${encodeURIComponent(panel.query.text)}`;

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
      ref={ref}
      className={cx(styles['panel'], className)}
      aria-labelledby={headingId}
      data-panel={panel.id}
      data-grid={[g.x, g.y, g.w, g.h].join(',')}
      data-vis={panel.vis.kind}
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
        </div>
        <div className={cx(styles['tools'])}>
          <Link
            to={explore}
            className={cx(styles['tool'])}
            aria-label={t('panel.explore', { title })}
          >
            <Icon name="square-arrow-out-up-right" />
          </Link>
          <IconButton
            icon="maximize-2"
            aria-label={t('panel.fullScreen', { title })}
            onPress={() => {
              setFull(true);
            }}
          />
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
      <div className={cx(styles['body'])}>
        <PanelBody title={title} data={data.data} isError={data.isError} sizeMemo={frameSize} />
      </div>
      <PanelFullScreen
        isOpen={full}
        title={title}
        data={data.data}
        isError={data.isError}
        onClose={() => {
          setFull(false);
        }}
      />
    </section>
  );
});
