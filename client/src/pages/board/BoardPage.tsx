/**
 * A board (IA-022, plan #61 Part B §4, Part C §4.2–§4.4): the filter bar and the toolbar, the
 * grids and their collapsible sections in View or Edit mode, the panel editor dialog, saving with the
 * head's etag and the conflict dialog, and the guard against leaving with unsaved changes. The page
 * holds the loaded head and the draft in one reducer (`editorState.ts`); variables, filters and
 * View-mode section overrides live in the URL (`useBoardParams`). The board's event markers are
 * read once per window for every panel (`useBoardEvents`, plan #64 Part C §3.8). A widget with a
 * registry def is added from Add widget and edited in the widget editor (plan #198 Part 3a §4.4).
 * The Edit toolbar's Tags button sets the board's tags, and Save waits for a widget editor's
 * invalid local field to be fixed (plan #216 Part 2b §4.1, §4.2).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link, useBlocker, useLocation, useNavigate } from 'react-router';
import { useApi, useBoardPrefs } from '../../app/providers';
import {
  BoardConflictError,
  isApiError,
  type Board,
  type BoardSpec,
  type FieldError,
  type PanelSpec,
} from '../../api/types';
import { BoardFiltersContext } from '../../boards/boardFilters';
import { BoardEventsContext, useBoardEvents } from '../../boards/boardEvents';
import { boardKeyAction } from '../../boards/boardKeys';
import { BoardRunProvider } from '../../boards/boardRun';
import { boardTimeInit, isTimeReady, type TimeTarget } from '../../boards/boardTime';
import {
  allPanels,
  blockedText,
  boardReducer,
  initialState,
  isCollapsed,
  isDirty,
  panelPointer,
  type GridRef,
} from '../../boards/editorState';
import {
  fieldMessage,
  geomapUnsupported,
  saveFieldMessage,
  tagsUnsupported,
} from '../../boards/fieldMessages';
import type { LayoutOp } from '../../boards/layout';
import { invalidateBoardLists } from '../../boards/queries';
import { checkBoardSpec } from '../../boards/spec';
import { tagError } from '../../boards/tags';
import { boardVariables } from '../../boards/variables';
import { WidgetRegistryContext, type WidgetDef } from '../../widgets/registry';
import { isDataPanel, isWidgetPanel } from '../../widgets/spec';
import { t } from '../../i18n/t';
import { InspectorHost } from '../../inspector/host';
import type { InspectOrigin } from '../../inspector/types';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { ContextSummary } from '../../shell/ContextSummary';
import { usePageTitle } from '../../shell/PageTitle';
import type { BoardLinkState } from '../../shell/SidebarBoards';
import { useShellRoute } from '../../shell/useShellRoute';
import type { ParamError } from '../../state/boardParams';
import { contextSearchString } from '../../state/contextSearch';
import { useBoardParams } from '../../state/useBoardParams';
import { useClock, useTimeContext } from '../../state/useTimeContext';
import pages from '../pages.module.css';
import styles from './Board.module.css';
import { BoardConflict } from './BoardConflict';
import { BoardFilterBar } from './BoardFilterBar';
import { BoardGuard } from './BoardGuard';
import { BoardModeContext } from './boardMode';
import { BoardSection } from './BoardSection';
import { BoardToolbar } from './BoardToolbar';
import { focusAfterEditor, PanelEditor } from './PanelEditor';
import { PanelFrame, type PanelFrameProps } from './PanelFrame';
import { WidgetEditor } from './WidgetEditor';

// The grid chunk (react-grid-layout, ADR-0014 §8): one grid serves View and Edit mode, so the
// panels stay mounted across the modes (#111). It is a lazy chunk of its own, requested when the
// board route mounts, alongside the board's own read.
const loadGrid = () => import('./BoardGrid');
const BoardGrid = lazy(loadGrid);

const PANEL_POINTER = /^(?:\/sections\/(\d+))?\/panels\/(\d+)(?:\/|$)/;
/** A section title's error shows under its field, not under the status line. */
const SECTION_TITLE_POINTER = /^\/sections\/(\d+)\/title$/;

function isLinkState(v: unknown): v is BoardLinkState {
  return typeof v === 'object' && v !== null && 'applySavedTime' in v;
}

/** The first panel a field error points into, if any. */
function firstPanelOf(spec: BoardSpec, fields: readonly FieldError[]): string | null {
  for (const f of fields) {
    const m = PANEL_POINTER.exec(f.pointer);
    if (m === null) continue;
    const grid: GridRef = m[1] === undefined ? 'top' : Number(m[1]);
    const found = allPanels(spec).find((x) => x.grid === grid && x.index === Number(m[2]));
    if (found !== undefined) return found.panel.id;
  }
  return null;
}

/** Why a later read of a loaded board failed: it was deleted, or the read did not complete. */
type ReloadError = 'gone' | 'failed';

function PageTitle({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

export function BoardPage() {
  const api = useApi();
  const { tenant, uid = '' } = useShellRoute();
  const { search } = useTimeContext();
  const board = useQuery({
    queryKey: ['board', tenant, uid],
    queryFn: ({ signal }) => api.getBoard(tenant, uid, signal),
    retry: (count, e) => !isApiError(e, 'notFound') && count < 1,
  });
  const notFound = board.isError && isApiError(board.error, 'notFound');
  // Set once the board first loads (a later failed read keeps the data): one view per opening.
  const loadedUid = board.data?.uid ?? null;
  const prefs = useBoardPrefs();
  useEffect(() => {
    if (loadedUid !== null) prefs.recordView(tenant, loadedUid);
  }, [prefs, tenant, loadedUid]);
  useEffect(() => {
    // A failed load shows again through the grid's Suspense, which retries it.
    loadGrid().catch(() => undefined);
  }, []);

  if (board.isPending) {
    return (
      <p className={cx(pages['muted'])} aria-busy="true">
        <PageTitle title={t('board.loading')} />
        {t('board.loading')}
      </p>
    );
  }
  // Only a first read that failed replaces the page; a failed later read keeps the editor and its
  // draft mounted and shows a notice.
  if (board.data === undefined) {
    return (
      <div className={cx(pages['page'])}>
        <PageTitle title={notFound ? t('board.notFound') : t('error.generic')} />
        <p className={cx(pages['muted'])}>
          {notFound ? t('board.notFoundDetail') : t('error.genericDetail')}
        </p>
        <Link
          to={{ pathname: `/t/${tenant}/boards`, search: contextSearchString(search) }}
          className={cx(pages['link'])}
        >
          {t('board.back')}
        </Link>
      </div>
    );
  }
  const reload: ReloadError | null = !board.isRefetchError ? null : notFound ? 'gone' : 'failed';
  return (
    <BoardEditor
      key={`${tenant}/${uid}`}
      tenant={tenant}
      uid={uid}
      latest={board.data}
      reload={reload}
    />
  );
}

function BoardEditor({
  tenant,
  uid,
  latest,
  reload,
}: {
  tenant: string;
  uid: string;
  latest: Board;
  reload: ReloadError | null;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const time = useTimeContext();
  const clock = useClock();
  const location = useLocation();
  const navigate = useNavigate();
  const [s, dispatch] = useReducer(boardReducer, latest, initialState);
  const [gone, setGone] = useState(false);
  const [doneGuard, setDoneGuard] = useState(false);
  // Discard's read of the head is in flight: Edit is read-only, as while saving, so no edit or
  // save can be made that the read's response would then replace.
  const [discarding, setDiscarding] = useState(false);
  // A widget editor's local field text that cannot be written (plan #216 Part 2b §4.1): Save is
  // refused while it is set, and `refused` shows why on the status line.
  const [editorInvalid, setEditorInvalid] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const onLocalInvalid = useCallback((m: string | null) => {
    setEditorInvalid(m);
    if (m === null) setRefused(false);
  }, []);
  const dirty = isDirty(s);
  const saving = s.save.status === 'saving';
  const busy = saving || discarding;
  const edit = s.mode === 'edit';
  const boardParams = useBoardParams(s.draft.sections.map((x) => x.id));
  // The filters a bar chart's click toggles (T22-007, #173 Part 3b): one object while they hold,
  // so a board render that leaves the URL alone renders no panel (#111). `setFilter` changes with
  // every render (the section ids), so the panels get a stable function that calls the latest.
  const filters = boardParams.params.filters;
  const latestSetFilter = useRef(boardParams.setFilter);
  useLayoutEffect(() => {
    latestSetFilter.current = boardParams.setFilter;
  });
  const setFilter = useCallback(
    (key: string, value: string | null) => latestSetFilter.current(key, value),
    [],
  );
  const boardFilters = useMemo(() => ({ filters, setFilter }), [filters, setFilter]);
  // A View-mode section toggle the URL budget refused; shown until the next press.
  const [overrideError, setOverrideError] = useState<ParamError | null>(null);

  // Edit starts from, and saves, the saved section state: View-mode overrides are dropped on
  // every way into Edit (button, Shift+E, a new board's link state).
  const { clearSectionOverrides } = boardParams;
  useEffect(() => {
    if (edit) clearSectionOverrides();
  }, [edit, clearSectionOverrides]);

  usePageTitle(edit ? t('board.editingTitle', { title: s.head.title }) : s.head.title);

  // Every later read of the board (window focus, invalidation) is a remote head.
  const seen = useRef(latest);
  useEffect(() => {
    if (seen.current === latest) return;
    seen.current = latest;
    dispatch({ type: 'remoteHead', board: latest });
  }, [latest]);

  // The board's time on first open (plan #64 §4.6, A.8; IA-002, IA-022): a link without a time
  // opens on the saved time (or the default), a board link applies the saved time once, and the
  // entry then forgets the link, so a deep link or a reload keeps the URL's time. One navigation.
  // Panels plan nothing until the URL holds that time (`timeReady`, latched while rendering).
  const [timeTarget, setTimeTarget] = useState<TimeTarget | undefined>(undefined);
  const [timeReady, setTimeReady] = useState(false);
  if (!timeReady && isTimeReady(timeTarget, new URLSearchParams(location.search), time.search)) {
    setTimeReady(true);
  }
  const opened = useRef(false);
  const { timeZone } = time;
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const st: unknown = location.state;
    const linkState = isLinkState(st);
    const init = boardTimeInit({
      search: location.search,
      linkState,
      saved: latest.spec.time,
      nowMs: clock.anchor(),
      timeZone,
    });
    if (init?.tick === true) clock.tick();
    if (init !== null || linkState) {
      void navigate(
        { pathname: location.pathname, search: init?.search ?? location.search },
        { replace: true, state: null },
      );
    }
    setTimeTarget(init ?? 'url');
    if (linkState && st.edit === true) dispatch({ type: 'enterEdit' });
  }, [location, navigate, latest, clock, timeZone]);

  // Leaving for another page asks first; time and refresh changes (same path) never do.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty]);

  const save = (etag: string = s.head.etag): void => {
    if (busy) return;
    if (editorInvalid !== null) {
      setRefused(true);
      return;
    }
    const draft = s.draft;
    const fields = checkBoardSpec(draft);
    if (fields.length > 0) {
      dispatch({ type: 'saveInvalid', fields });
      const id = firstPanelOf(draft, fields);
      if (id !== null) dispatch({ type: 'select', id });
      return;
    }
    setGone(false);
    dispatch({ type: 'saveStart' });
    api.saveBoard(tenant, uid, etag, draft).then(
      (r) => {
        seen.current = r.board;
        dispatch({ type: 'saveOk', board: r.board });
        queryClient.setQueryData(['board', tenant, uid], r.board);
        // The title may have changed: the list and the sidebar groups show it.
        void invalidateBoardLists(queryClient);
      },
      (e: unknown) => {
        if (e instanceof BoardConflictError) {
          dispatch({ type: 'conflict', current: e.current });
        } else if (isApiError(e, 'invalid')) {
          dispatch({ type: 'saveInvalid', fields: [...e.fields] });
          const id = firstPanelOf(draft, e.fields);
          if (id !== null) dispatch({ type: 'select', id });
        } else {
          setGone(isApiError(e, 'notFound'));
          dispatch({ type: 'saveFailed' });
        }
      },
    );
  };

  /** Discard: read the head again, load it and leave Edit mode. */
  const discard = (): void => {
    if (busy) return;
    setDiscarding(true);
    queryClient
      .query({
        queryKey: ['board', tenant, uid],
        queryFn: ({ signal }) => api.getBoard(tenant, uid, signal),
        staleTime: 0,
      })
      .then(
        (b) => {
          seen.current = b;
          setDiscarding(false);
          dispatch({ type: 'loaded', board: b });
          dispatch({ type: 'exitEdit' });
        },
        () => {
          // The draft stays, editable; the status says the saved version did not load.
          setDiscarding(false);
          dispatch({ type: 'discardFailed' });
        },
      );
  };

  const done = (): void => {
    if (dirty) setDoneGuard(true);
    else dispatch({ type: 'exitEdit' });
  };

  // Shift+E and ⌘S / Ctrl+S (T08-024), on the latest state.
  const keys = useRef({ edit, done, save, busy: false, discarding: false });
  useEffect(() => {
    keys.current = { edit, done, save, busy: busy || s.conflict !== null, discarding };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const k = keys.current;
      const action = boardKeyAction(e, k.edit ? 'edit' : 'view');
      if (action === null) return;
      e.preventDefault();
      if (action === 'save') {
        if (!k.busy) k.save();
      } else if (k.discarding) return;
      else if (k.edit) k.done();
      else dispatch({ type: 'enterEdit' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // #90: when the panel editor closes in Edit mode, focus goes to the edited panel's Panel menu
  // (its Edit control), or to Add panel if the panel is gone. Scheduled one frame later, so it runs
  // after the overlay's own focus restore.
  const editedId = useRef<string | null>(null);
  // After Remove from the panel menu: focus goes to Add panel once the menu has closed.
  const [focusAdd, setFocusAdd] = useState(false);
  useEffect(() => {
    if (!focusAdd) return;
    const raf = requestAnimationFrame(() => {
      setFocusAdd(false);
      document.querySelector<HTMLElement>('[data-board-add]')?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [focusAdd]);
  useEffect(() => {
    const was = editedId.current;
    editedId.current = s.selected;
    if (was === null || s.selected !== null || !edit) return;
    const raf = requestAnimationFrame(() => {
      focusAfterEditor(document, was);
    });
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [s.selected, edit]);

  const selected =
    s.selected === null ? undefined : allPanels(s.draft).find((x) => x.panel.id === s.selected);
  // The run text of the panel in the dialog (plan #64 §4.4, A.10): the preview and the panel
  // behind run it, so they share one key; typing changes the draft only. Set while rendering.
  // `seq` counts the runs of the same text: a LogQL stream preview's new pager (plan #67 §3.5).
  // `degraded`: the dialog's Query field failed to load an import, so the edited panel runs
  // without a language if it has none (#147); other panels keep `langFailed`.
  const [editRun, setEditRun] = useState<{
    id: string;
    text: string;
    seq: number;
    degraded: boolean;
  } | null>(null);
  // The editor edits data panels only: a selected widget opens none (plan #198 Part 1 §4.2).
  const dialogPanel =
    edit && selected !== undefined && isDataPanel(selected.panel) ? selected.panel : null;
  // A selected widget whose kind the registry has opens the widget editor (plan #198 Part 3a §4.4).
  const registry = useContext(WidgetRegistryContext);
  const selectedWidget =
    edit && selected !== undefined && isWidgetPanel(selected.panel) ? selected.panel : null;
  const widgetDef =
    selectedWidget === null
      ? undefined
      : registry.defs.find((d) => d.kind === selectedWidget.vis.kind);
  const dialogWidget = widgetDef === undefined ? null : selectedWidget;
  // The head's vis of the panel in the widget editor: `textVis` keeps its representation.
  const headPanel =
    dialogWidget === null
      ? undefined
      : allPanels(s.head.spec).find((x) => x.panel.id === dialogWidget.id)?.panel;
  const originalVis =
    headPanel !== undefined && isWidgetPanel(headPanel) ? headPanel.vis : undefined;
  const addWidget = (def: WidgetDef, grid?: GridRef): void => {
    dispatch({
      type: 'addWidget',
      vis: def.newVis(),
      size: def.size,
      ...(grid === undefined ? {} : { grid }),
    });
  };
  if (dialogPanel === null) {
    if (editRun !== null) setEditRun(null);
  } else if (editRun?.id !== dialogPanel.id) {
    setEditRun({ id: dialogPanel.id, text: dialogPanel.query.text, seq: 0, degraded: false });
  }
  const runEdited = (text: string): void => {
    if (editRun === null) return;
    if (text !== editRun.text) {
      setEditRun({ ...editRun, text });
      return;
    }
    // The same text again: abort the run in flight, first fetch included, and run it again.
    setEditRun({ ...editRun, seq: editRun.seq + 1 });
    const queryKey = ['data', 'panel', tenant, editRun.id];
    void queryClient.cancelQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey });
  };
  // The same object when unchanged: the field's report causes no render.
  const onDegraded = useCallback((d: boolean) => {
    setEditRun((r) => (r === null || r.degraded === d ? r : { ...r, degraded: d }));
  }, []);
  const full = [t('board.full'), t('board.fullPanels'), t('board.sectionsFull')].includes(
    s.announce,
  )
    ? s.announce
    : '';
  const statusText = refused
    ? t('board.save.editorInvalid')
    : {
        idle: full,
        saving: t('board.saving'),
        saved: t('board.saved'),
        failed: gone ? t('board.saveGone') : t('board.saveFailed'),
        invalid: t('board.saveInvalid', { n: s.save.fields.length }),
        discardFailed: t('board.discardFailed'),
      }[s.save.status];
  // The tags field shows a save's `/tags` error (an older server's refusal reads as such).
  const tagField = tagError(s.save.status === 'invalid' ? s.save.fields : []);
  const tagsError =
    tagField === null
      ? null
      : tagsUnsupported(tagField)
        ? t('board.save.tagsUnsupported')
        : fieldMessage(tagField.messageKey);
  // Errors outside any panel and section title (the board title, the time) show under the status
  // line, and so does an older server's refusal of a map panel (plan #234 Part 1 §4.5).
  const invalid = s.save.status === 'invalid' ? s.save.fields : [];
  const boardErrors = invalid.filter(
    (f) =>
      geomapUnsupported(s.draft, f) ||
      (!PANEL_POINTER.test(f.pointer) && !SECTION_TITLE_POINTER.test(f.pointer)),
  );
  const titleErrorOf = (j: number): string | null => {
    const f = invalid.find((x) => x.pointer === `/sections/${String(j)}/title`);
    return f === undefined ? null : fieldMessage(f.messageKey);
  };

  // Stable, so a memoised `PanelFrame` whose panel is unchanged skips the page's renders (#111).
  // The editor opens in a transition: React renders the dialog in slices that yield to the
  // browser instead of in one long task after the click (#111, PRF-005).
  const onEdit = useCallback((id: string) => {
    startTransition(() => {
      dispatch({ type: 'enterEdit' });
      dispatch({ type: 'select', id });
    });
  }, []);
  const onKeyOp = useCallback((id: string, op: LayoutOp) => {
    dispatch({ type: 'keyOp', id, op });
  }, []);
  // From the panel menu (plan #64 Q3): the change needs a save, so it enters Edit mode.
  const onDuplicate = useCallback((id: string) => {
    dispatch({ type: 'enterEdit' });
    dispatch({ type: 'duplicatePanel', id });
  }, []);
  const onRemove = useCallback((id: string) => {
    dispatch({ type: 'enterEdit' });
    dispatch({ type: 'removePanel', id });
    setFocusAdd(true);
  }, []);
  // The Inspector (T25-001, T25-012): it closes when its panel goes or its query or vis changes.
  const draft = s.draft;
  const originKey = useCallback(
    (id: string | null): string | null => {
      const p = allPanels(draft).find((x) => x.panel.id === id)?.panel;
      return p === undefined ? null : JSON.stringify([p.query, p.vis]);
    },
    [draft],
  );
  const onEditQuery = useCallback(
    (o: InspectOrigin) => {
      if (o.panelId !== null) onEdit(o.panelId);
    },
    [onEdit],
  );
  const panelProps = (p: PanelSpec): PanelFrameProps => ({
    panel: p,
    tenant,
    readOnly: busy,
    selected: edit && s.selected === p.id,
    onEdit,
    onKeyOp,
    onDuplicate,
    onRemove,
    ...(editRun?.id === p.id
      ? { runText: editRun.text, runSeq: editRun.seq, runDegraded: editRun.degraded }
      : {}),
  });

  // One grid for both modes (#111): entering or leaving Edit mode changes its props, not the
  // components, so no panel mounts again.
  const grid = (panels: readonly PanelSpec[], ref: GridRef) => (
    <BoardGrid
      mode={s.mode}
      panels={panels}
      readOnly={busy}
      onLayout={(items) => {
        dispatch({ type: 'layout', grid: ref, items });
      }}
      onBlocked={(p) => {
        dispatch({ type: 'announce', text: blockedText(p) });
      }}
      renderPanel={(p) => <PanelFrame {...panelProps(p)} />}
    />
  );

  const empty = s.draft.panels.length === 0 && s.draft.sections.length === 0;
  const livePanels = useMemo(() => allPanels(s.draft).map((x) => x.panel.id), [s.draft]);
  // One events request for the whole board (plan #64 Part C §3.8): every grid and section counts,
  // collapsed ones too, and none is made before the board's time is ready.
  const events = useBoardEvents(tenant, timeReady && livePanels.length > 0);
  const eventsNotice = events.failed
    ? t('board.events.failed')
    : events.truncated
      ? t('board.events.truncated')
      : '';

  const page = (
    <div className={cx(styles['page'])}>
      <div className={cx(styles['bar'])}>
        <ContextSummary />
        <BoardFilterBar variables={boardVariables(s.draft)} state={boardParams} />
        {edit ? (
          <BoardToolbar
            mode="edit"
            busy={busy}
            dirty={dirty}
            savesTime={s.draft.time !== undefined}
            onAdd={() => {
              dispatch({ type: 'addPanel' });
            }}
            onAddWidget={(def) => {
              addWidget(def);
            }}
            onAddSection={() => {
              dispatch({ type: 'addSection' });
            }}
            tags={s.draft.tags ?? []}
            tagsError={tagsError}
            onTags={(tags) => {
              dispatch({ type: 'setTags', tags });
            }}
            onSaveTime={(on) => {
              dispatch({
                type: 'setTime',
                time: on ? { from: time.search.from, to: time.search.to } : null,
              });
            }}
            onDiscard={discard}
            onSave={() => {
              save();
            }}
            onDone={done}
          />
        ) : (
          <BoardToolbar
            mode="view"
            onEdit={() => {
              // In a transition, as the panel editor's opening (#111): React renders the Edit
              // chrome in slices.
              startTransition(() => {
                dispatch({ type: 'enterEdit' });
              });
            }}
          />
        )}
      </div>
      {edit ? (
        <p role="status" aria-label={t('board.saveStatus')} className={cx(styles['status'])}>
          {statusText}
        </p>
      ) : (
        <p role="status" className={cx(styles['status'])}>
          {overrideError === null ? '' : t(overrideError)}
        </p>
      )}
      {boardErrors.map((f) => (
        <p key={f.pointer} className={cx(styles['status'])}>
          {saveFieldMessage(s.draft, f)}
        </p>
      ))}
      <p aria-live="polite" className={cx(styles['live'])} data-board-live="">
        {s.announce}
      </p>
      {reload !== null && (
        <p className={cx(styles['notice'])}>
          {reload === 'gone' ? t('board.reloadGone') : t('board.reloadFailed')}
        </p>
      )}
      {s.remote !== null && (
        <p className={cx(styles['notice'])}>{t('board.remote', { version: s.remote.version })}</p>
      )}
      <p role="status" className={cx(styles['status'])} data-board-events-notice="">
        {eventsNotice}
      </p>
      <div className={cx(styles['workspace'])}>
        <div className={cx(styles['grids'])}>
          {/* One boundary for every grid: until the grid chunk arrives the board shows none, so
              no grid is placed above another that has not (#111). */}
          <Suspense fallback={<div data-board-grid="" aria-busy="true" />}>
            {empty && !edit ? (
              <EmptyState title={t('board.noPanels')} />
            ) : (
              <>
                {(s.draft.panels.length > 0 || edit) && grid(s.draft.panels, 'top')}
                {s.draft.sections.map((sec, j) => {
                  const collapsed = isCollapsed(s.mode, sec, boardParams.params.sections);
                  return (
                    <BoardSection
                      key={sec.id}
                      section={sec}
                      index={j}
                      mode={s.mode}
                      collapsed={collapsed}
                      busy={busy}
                      titleError={titleErrorOf(j)}
                      onToggle={() => {
                        if (edit) {
                          dispatch({ type: 'toggleSection', id: sec.id });
                          return;
                        }
                        // Only a state that differs from the saved one is written to the URL.
                        const next = !collapsed;
                        setOverrideError(
                          boardParams.setSectionOverride(
                            sec.id,
                            next === sec.collapsed ? null : next,
                          ),
                        );
                      }}
                      onTitle={(title) => {
                        dispatch({ type: 'updateSection', id: sec.id, title });
                      }}
                      onAddPanel={() => {
                        dispatch({ type: 'addPanel', grid: j });
                      }}
                      onAddWidget={(def) => {
                        addWidget(def, j);
                      }}
                      onRemove={() => {
                        dispatch({ type: 'removeSection', id: sec.id });
                      }}
                    >
                      {grid(sec.panels, j)}
                    </BoardSection>
                  );
                })}
              </>
            )}
          </Suspense>
        </div>
        {dialogPanel !== null && selected !== undefined && (
          <PanelEditor
            key={dialogPanel.id}
            panel={dialogPanel}
            tenant={tenant}
            pointer={panelPointer(selected.grid, selected.index)}
            fields={s.save.status === 'invalid' ? s.save.fields : []}
            readOnly={busy}
            statusText={statusText}
            runText={editRun?.id === dialogPanel.id ? editRun.text : dialogPanel.query.text}
            runSeq={editRun?.id === selected.panel.id ? editRun.seq : 0}
            runDegraded={editRun?.id === selected.panel.id ? editRun.degraded : false}
            onDegraded={onDegraded}
            onRun={runEdited}
            onChange={(patch) => {
              dispatch({ type: 'updatePanel', id: selected.panel.id, patch });
            }}
            onRemove={() => {
              dispatch({ type: 'removePanel', id: selected.panel.id });
            }}
            onClose={() => {
              dispatch({ type: 'select', id: null });
            }}
          />
        )}
        {dialogWidget !== null && widgetDef !== undefined && selected !== undefined && (
          <WidgetEditor
            key={dialogWidget.id}
            panel={dialogWidget}
            def={widgetDef}
            pointer={panelPointer(selected.grid, selected.index)}
            fields={s.save.status === 'invalid' ? s.save.fields : []}
            readOnly={busy}
            statusText={statusText}
            original={originalVis}
            onChange={(patch) => {
              dispatch({ type: 'updateWidget', id: dialogWidget.id, patch });
            }}
            onRemove={() => {
              dispatch({ type: 'removePanel', id: dialogWidget.id });
            }}
            onClose={() => {
              dispatch({ type: 'select', id: null });
            }}
            onLocalInvalid={onLocalInvalid}
          />
        )}
      </div>
      {blocker.state === 'blocked' && (
        <BoardGuard
          onKeep={() => {
            blocker.reset();
          }}
          onDiscard={() => {
            blocker.proceed();
          }}
        />
      )}
      {doneGuard && (
        <BoardGuard
          onKeep={() => {
            setDoneGuard(false);
          }}
          onDiscard={() => {
            setDoneGuard(false);
            dispatch({ type: 'loaded', board: s.head });
            dispatch({ type: 'exitEdit' });
          }}
        />
      )}
      {s.conflict !== null && (
        <BoardConflict
          current={s.conflict}
          onOverwrite={() => {
            if (s.conflict !== null) save(s.conflict.etag);
          }}
          onTakeTheirs={() => {
            if (s.conflict !== null) dispatch({ type: 'loaded', board: s.conflict });
          }}
        />
      )}
    </div>
  );
  // Every panel of the board reads its variables, width store, viewport tracker and time gate here.
  return (
    <BoardRunProvider
      tenant={tenant}
      vars={boardParams.params.vars}
      timeReady={timeReady}
      livePanels={livePanels}
    >
      <BoardEventsContext.Provider value={events}>
        <BoardModeContext.Provider value={s.mode}>
          <BoardFiltersContext.Provider value={boardFilters}>
            <InspectorHost
              surface="board"
              filters={boardParams.params.filters}
              originKey={originKey}
              onEditQuery={onEditQuery}
            >
              {page}
            </InspectorHost>
          </BoardFiltersContext.Provider>
        </BoardModeContext.Provider>
      </BoardEventsContext.Provider>
    </BoardRunProvider>
  );
}

// The widget gallery (dev and stub builds) takes the board's widget modules from this chunk: its
// own static imports of them would split the stub build's initial chunks (#198 Part 3b).
export { BoardRunContext } from '../../boards/boardRunContext';
export { WIDGETS } from '../../widgets/registry';
export { WidgetBody } from '../../widgets/WidgetBody';
// The widget gallery's Board list pages prime a panel's cache under its key (plan #216 Part 2a).
export { boardListKey } from '../../widgets/boardList/source';
export { boardListOptions } from '../../widgets/boardList/options';
