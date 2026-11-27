/**
 * `InspectorHost` (T25-001, T25-006, T25-007, T25-012, T25 §4.8; plan #192 §4.1, §4.2, plan #234
 * Part 4 §4.2): one per page. It owns the selection, the Inspector sheet with the open request's
 * navigation stack, and the page's one Esc ladder; kinds reach it only through
 * `useInspector()` (null without a host: kinds then neither inspect nor select). State is in memory
 * only and dies with the page (a route, tenant or board change); refreshes and window changes keep
 * it. The registries are `Map`s in refs: last wins, and a disposer removes only its own entry.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import { CAPABILITIES } from '../app/capabilities';
import { cx } from '../kit/cx';
import { useShellRoute } from '../shell/useShellRoute';
import type { BoardFilter } from '../state/boardParams';
import { useTimeContext } from '../state/useTimeContext';
import { activePanelId, ladderSkips } from './escape';
import { Inspector, type InspectorNav } from './Inspector';
import styles from './Inspector.module.css';
import { resolveGeoMembers } from '../vis/geo/targets';
import type { MemberList } from './members';
import { inspectorModel } from './model';
import { INITIAL_INSPECTOR, inspectorReducer, topOf, viewKey } from './store';
import type {
  InspectorEnv,
  InspectOrigin,
  InspectRequest,
  NavView,
  Selection,
  SelectionSource,
} from './types';

/** A kind's own Esc steps: the next step, or null when none applies. */
export interface EscapeProvider {
  pre(): (() => void) | null;
  post(): (() => void) | null;
}

export interface InspectorHostApi {
  inspect(r: InspectRequest): void;
  select(s: Selection | null, src: SelectionSource): void;
  /**
   * A per-panel stack (plan #234 Part 3 §4.9): the newest live registration answers; its disposer
   * removes only its own entry, so the one before answers again (a full screen closing, StrictMode).
   */
  registerMembers(panelId: string, r: (runId: string) => MemberList | null): () => void;
  resolveMembers(panelId: string, runId: string): MemberList | null;
  registerEscape(panelId: string, p: EscapeProvider): () => void;
}

export interface InspectorHostProps {
  readonly surface: 'board' | 'explore';
  /** Board `f=` in URL order; [] on Explore. */
  readonly filters: readonly BoardFilter[];
  /** Board: JSON of the panel's [query, vis], or null when it is gone; Explore: `q`. */
  readonly originKey: (panelId: string | null) => string | null;
  readonly onEditQuery: (o: InspectOrigin) => void;
  readonly children: ReactNode;
}

/** The host API; null without a host. Exported for kinds' tests. */
export const InspectorApiContext = createContext<InspectorHostApi | null>(null);
/** The page selection. Exported for kinds' tests. */
export const SelectionContext = createContext<Selection | null>(null);
const OriginContext = createContext<string | null>(null);

export function useInspector(): InspectorHostApi | null {
  return useContext(InspectorApiContext);
}

export function useSelection(): Selection | null {
  return useContext(SelectionContext);
}

/** The board panel the Inspector was opened from, for its outline (T25-014). */
export function useInspectedPanelId(): string | null {
  return useContext(OriginContext);
}

/** At most one live-region write per this many ms; the latest text wins (T08-018). */
const LIVE_MS = 500;

/** Where focus goes when the Inspector closes (T25-008). */
function closeTarget(req: InspectRequest, doc: Document): HTMLElement | null {
  const back = req.returnFocus;
  if (back?.isConnected === true) return back;
  const id = req.origin.panelId;
  const panel =
    id === null ? null : doc.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`);
  return panel ?? doc.getElementById('main');
}

/**
 * The one polite region: one write per `viewKey` change, at most one per 500 ms, the latest text
 * wins; a text equal to the last one is cleared and rewritten on the next frame, so it is read
 * again (T25-008). Keyed by tenant by the host, so a tenant change drops its text and its pending
 * write.
 */
function LiveRegion({ text, viewKey }: { text: string | null; viewKey: string }) {
  const live = useLiveText(text, viewKey);
  return (
    <p aria-live="polite" className={cx(styles['srOnly'])} data-inspector-live="">
      {live}
    </p>
  );
}

function useLiveText(text: string | null, viewKey: string): string {
  const [live, setLive] = useState('');
  const shown = useRef('');
  const last = useRef(-Infinity);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  const pending = useRef('');
  /** Shows `x`; the same text again is cleared first and rewritten on the next frame. */
  const write = useCallback((x: string): void => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    last.current = Date.now();
    if (x !== shown.current) {
      shown.current = x;
      setLive(x);
      return;
    }
    setLive('');
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setLive(x);
    });
  }, []);
  useEffect(() => {
    if (text === null) return;
    pending.current = text;
    if (timer.current !== null) return;
    const wait = last.current + LIVE_MS - Date.now();
    if (wait <= 0) {
      write(text);
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      write(pending.current);
    }, wait);
    // One write per view: `viewKey` changes even when the text does not.
  }, [text, viewKey, write]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return live;
}

export function InspectorHost({
  surface,
  filters,
  originKey,
  onEditQuery,
  children,
}: InspectorHostProps) {
  const [state, dispatch] = useReducer(inspectorReducer, INITIAL_INSPECTOR);
  const { tenant } = useShellRoute();
  // T25 §8: a tenant change (Back or Forward between tenants on one route keeps the page mounted)
  // drops the selection and the Inspector before this render commits, so nothing of the last
  // tenant shows, not even during the close; the sheet drops its layers for the new scope and the live region is keyed by tenant.
  const [tenantSeen, setTenantSeen] = useState(tenant);
  if (tenantSeen !== tenant) {
    setTenantSeen(tenant);
    dispatch({ type: 'reset' });
  }
  const current = tenantSeen === tenant ? state : INITIAL_INSPECTOR;
  const { search, timeZone } = useTimeContext();
  const { pathname } = useLocation();
  const asideRef = useRef<HTMLElement | null>(null);
  const members = useRef(new Map<string, { r: (runId: string) => MemberList | null }[]>());
  const escapes = useRef(new Map<string, { p: EscapeProvider }>());
  const lastPressed = useRef<string | null>(null);
  /** The origin's key and the path when the Inspector opened (T25-012). */
  const opened = useRef<{ key: string | null; pathname: string } | null>(null);
  const latest = useRef({ state, originKey, pathname });
  useLayoutEffect(() => {
    latest.current = { state, originKey, pathname };
  });

  const api = useMemo<InspectorHostApi>(
    () => ({
      inspect(r) {
        const l = latest.current;
        opened.current = { key: l.originKey(r.origin.panelId), pathname: l.pathname };
        dispatch({ type: 'inspect', req: r });
      },
      select(s) {
        dispatch({ type: 'select', sel: s });
      },
      registerMembers(panelId, r) {
        const entry = { r };
        const stack = members.current.get(panelId) ?? [];
        members.current.set(panelId, [...stack, entry]);
        return () => {
          const now = members.current.get(panelId) ?? [];
          const rest = now.filter((x) => x !== entry);
          if (rest.length === now.length) return;
          if (rest.length === 0) members.current.delete(panelId);
          else members.current.set(panelId, rest);
        };
      },
      resolveMembers(panelId, runId) {
        // A geo view's members come from the open request's top view, its own snapshot (T25
        // §4.8, §4.9): no instance holds them, so every mount of the panel answers alike.
        if (runId.startsWith('geo:')) {
          const s = latest.current.state;
          const top = topOf(s);
          if (top?.type !== 'geo' || s.req?.origin.panelId !== panelId) return null;
          return resolveGeoMembers(top.target, runId);
        }
        return members.current.get(panelId)?.at(-1)?.r(runId) ?? null;
      },
      registerEscape(panelId, p) {
        const entry = { p };
        escapes.current.set(panelId, entry);
        return () => {
          if (escapes.current.get(panelId) === entry) escapes.current.delete(panelId);
        };
      },
    }),
    [],
  );

  /** Closes the sheet; `user` closes (Esc, Close) always move focus, others only from inside. */
  const close = useCallback((by: 'user' | 'auto') => {
    const req = latest.current.state.req;
    if (req === null) return;
    const aside = asideRef.current;
    const inside = aside !== null && aside.contains(document.activeElement);
    dispatch({ type: 'close' });
    if (by === 'user' || inside) closeTarget(req, document)?.focus();
  }, []);

  // The origin panel removed, its query or vis changed, Explore ran another query, or the route
  // changed: the snapshot closes (T25-012). Runs after every render: `originKey` reads the page.
  useEffect(() => {
    const req = state.req;
    const o = opened.current;
    if (req === null || o === null) return;
    if (originKey(req.origin.panelId) !== o.key || pathname !== o.pathname) {
      const aside = asideRef.current;
      const inside = aside !== null && aside.contains(document.activeElement);
      dispatch({ type: 'originChanged', panelId: req.origin.panelId });
      if (inside) closeTarget(req, document)?.focus();
    }
  });

  // The Esc ladder (T25-007): one document listener, bubble phase; the last panel pressed is
  // recorded in the capture phase.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      const panel =
        e.target instanceof Element ? e.target.closest<HTMLElement>('[data-panel-id]') : null;
      if (panel !== null) lastPressed.current = panel.dataset['panelId'] ?? null;
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (ladderSkips(e, document)) return;
      const s = latest.current.state;
      const id = activePanelId(document, asideRef.current, s.req, lastPressed.current);
      const provider = id === null ? undefined : escapes.current.get(id)?.p;
      const pre = provider?.pre() ?? null;
      let step: (() => void) | null = pre;
      // A deeper view pops before the selection clears (T25-007, T25 §4.8).
      if (step === null && s.req !== null && s.nav.length > 0) {
        const to = s.nav.length - 1;
        step = () => {
          dispatch({ type: 'pop', to });
        };
      }
      if (step === null && s.selection !== null) {
        step = () => {
          dispatch({ type: 'select', sel: null });
        };
      }
      if (step === null && s.req !== null) {
        step = () => {
          close('user');
        };
      }
      step ??= provider?.post() ?? null;
      if (step === null) return;
      e.preventDefault();
      step();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close]);

  const env = useMemo<InspectorEnv>(
    () => ({ tenant, ctx: { search, filters }, timeZone, capabilities: CAPABILITIES }),
    [tenant, search, filters, timeZone],
  );
  // The top view, rendered at its depth (T25 §4.8): every view is built from the request's own
  // snapshot, so a refresh never changes it.
  const { req, nav, seq } = current;
  const model = useMemo(() => {
    if (req === null) return null;
    const target = nav.at(-1)?.target ?? req.target;
    return inspectorModel({ ...req, target }, env, nav.length);
  }, [req, nav, env]);
  const rootHeading = useMemo(
    () => (req === null || nav.length === 0 ? null : inspectorModel(req, env).heading),
    [req, nav.length, env],
  );
  const key = viewKey(current);
  const navProps = useMemo<InspectorNav | null>(
    () =>
      rootHeading === null
        ? null
        : {
            titles: [rootHeading, ...nav.map((v) => v.title)],
            onPop: (to) => {
              dispatch({ type: 'pop', to });
            },
          },
    [rootHeading, nav],
  );
  // The entries of this render push at its `seq` and depth: a second press before the next render
  // (or after a close) is stale and dropped by the reducer.
  const onEntry = useCallback(
    (view: NavView) => {
      dispatch({ type: 'push', seq, depth: nav.length, view });
    },
    [seq, nav.length],
  );
  const origin =
    surface === 'board' && current.req?.origin.surface === 'board'
      ? current.req.origin.panelId
      : null;

  const onEdit = useCallback(() => {
    const req = latest.current.state.req;
    if (req !== null) onEditQuery(req.origin);
  }, [onEditQuery]);

  return (
    <InspectorApiContext.Provider value={api}>
      <SelectionContext.Provider value={current.selection}>
        <OriginContext.Provider value={origin}>
          {children}
          <Inspector
            ref={asideRef}
            model={model}
            scope={tenant}
            seq={seq}
            viewKey={key}
            focusHeading={req?.source === 'keyboard' ? seq : null}
            nav={navProps}
            onEntry={onEntry}
            collapsed={current.collapsed}
            onToggleCollapsed={() => {
              dispatch({ type: 'toggleCollapsed' });
            }}
            onClose={() => {
              close('user');
            }}
            onEditQuery={onEdit}
            resolveMembers={(panelId, runId) => api.resolveMembers(panelId, runId)}
          />
          <LiveRegion key={tenant} text={model?.announce ?? null} viewKey={key} />
        </OriginContext.Provider>
      </SelectionContext.Provider>
    </InspectorApiContext.Provider>
  );
}
