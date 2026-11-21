/**
 * A board (IA-022, plan #61 Part B §4): the toolbar, the grids in View or Edit mode, the panel
 * editor, saving with the head's etag and the conflict dialog, and the guard against leaving with
 * unsaved changes. The page holds the loaded head and the draft in one reducer (`editorState.ts`).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useReducer, useRef, useState } from 'react';
import { Link, useBlocker, useLocation, useNavigate } from 'react-router';
import { useApi } from '../../app/providers';
import {
  BoardConflictError,
  isApiError,
  type Board,
  type BoardSpec,
  type FieldError,
  type PanelSpec,
} from '../../api/types';
import { boardKeyAction } from '../../boards/boardKeys';
import {
  allPanels,
  blockedText,
  boardReducer,
  initialState,
  isDirty,
  panelPointer,
  type GridRef,
} from '../../boards/editorState';
import { fieldMessage } from '../../boards/fieldMessages';
import type { LayoutOp } from '../../boards/layout';
import { checkBoardSpec } from '../../boards/spec';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { ContextSummary } from '../../shell/ContextSummary';
import { usePageTitle } from '../../shell/PageTitle';
import { pushRecent } from '../../shell/recentBoards';
import type { BoardLinkState } from '../../shell/SidebarBoards';
import { useShellRoute } from '../../shell/useShellRoute';
import { contextSearchString } from '../../state/contextSearch';
import { useTimeContext } from '../../state/useTimeContext';
import { safeStorage } from '../../theme/theme';
import pages from '../pages.module.css';
import styles from './Board.module.css';
import { BoardConflict } from './BoardConflict';
import { BoardGridView } from './BoardGridView';
import { BoardGuard } from './BoardGuard';
import { BoardToolbar } from './BoardToolbar';
import { PanelEditor } from './PanelEditor';
import { PanelFrame, type PanelFrameProps } from './PanelFrame';

// The Edit-mode chunk: react-grid-layout loads only when a board is edited (ADR-0014 §8). It is
// preloaded when the pointer or the focus reaches Edit board, so the grid seldom swaps under a
// user who acts at once.
const loadGridEditor = () => import('./BoardGridEditor');
const BoardGridEditor = lazy(loadGridEditor);

function preloadGridEditor(): void {
  loadGridEditor().catch(() => undefined);
}

const PANEL_POINTER = /^(?:\/sections\/(\d+))?\/panels\/(\d+)(?:\/|$)/;

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
  const loadedUid = board.isSuccess ? board.data.uid : null;
  useEffect(() => {
    if (loadedUid !== null) pushRecent(safeStorage(), tenant, loadedUid);
  }, [tenant, loadedUid]);

  if (board.isPending) {
    return (
      <p className={cx(pages['muted'])} aria-busy="true">
        <PageTitle title={t('board.loading')} />
        {t('board.loading')}
      </p>
    );
  }
  if (board.isError) {
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
  return <BoardEditor key={`${tenant}/${uid}`} tenant={tenant} uid={uid} latest={board.data} />;
}

function BoardEditor({ tenant, uid, latest }: { tenant: string; uid: string; latest: Board }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const time = useTimeContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [s, dispatch] = useReducer(boardReducer, latest, initialState);
  const [gone, setGone] = useState(false);
  const [doneGuard, setDoneGuard] = useState(false);
  const dirty = isDirty(s);
  const saving = s.save.status === 'saving';
  const edit = s.mode === 'edit';

  usePageTitle(edit ? t('board.editingTitle', { title: s.head.title }) : s.head.title);

  // Every later read of the board (window focus, invalidation) is a remote head.
  const seen = useRef(latest);
  useEffect(() => {
    if (seen.current === latest) return;
    seen.current = latest;
    dispatch({ type: 'remoteHead', board: latest });
  }, [latest]);

  // A board link applies the saved time range once, then the entry forgets the link (IA-022): a
  // deep link or a reload keeps the URL's time.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const st: unknown = location.state;
    if (!isLinkState(st)) return;
    void navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: null },
    );
    const saved = latest.spec.time;
    if (saved !== undefined) {
      time.dispatch({ type: 'setRange', from: saved.from, to: saved.to }, { replace: true });
    }
    if (st.edit === true) dispatch({ type: 'enterEdit' });
  }, [location, navigate, latest, time]);

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
    if (saving) return;
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
        void queryClient.invalidateQueries({ queryKey: ['boards'] });
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
    queryClient
      .query({
        queryKey: ['board', tenant, uid],
        queryFn: ({ signal }) => api.getBoard(tenant, uid, signal),
        staleTime: 0,
      })
      .then(
        (b) => {
          seen.current = b;
          dispatch({ type: 'loaded', board: b });
          dispatch({ type: 'exitEdit' });
        },
        () => {
          dispatch({ type: 'saveFailed' });
        },
      );
  };

  const done = (): void => {
    if (dirty) setDoneGuard(true);
    else dispatch({ type: 'exitEdit' });
  };

  // Shift+E and ⌘S / Ctrl+S (T08-024), on the latest state.
  const keys = useRef({ edit, done, save, busy: false });
  useEffect(() => {
    keys.current = { edit, done, save, busy: saving || s.conflict !== null };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const k = keys.current;
      const action = boardKeyAction(e, k.edit ? 'edit' : 'view');
      if (action === null) return;
      e.preventDefault();
      if (action === 'save') {
        if (!k.busy) k.save();
      } else if (k.edit) k.done();
      else dispatch({ type: 'enterEdit' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const selected =
    s.selected === null ? undefined : allPanels(s.draft).find((x) => x.panel.id === s.selected);
  const full =
    s.announce === t('board.full') || s.announce === t('board.fullPanels') ? s.announce : '';
  const statusText = {
    idle: full,
    saving: t('board.saving'),
    saved: t('board.saved'),
    failed: gone ? t('board.saveGone') : t('board.saveFailed'),
    invalid: t('board.saveInvalid', { n: s.save.fields.length }),
  }[s.save.status];
  // Errors outside any panel (the board title, the time) show under the status line.
  const boardErrors =
    s.save.status === 'invalid' ? s.save.fields.filter((f) => !PANEL_POINTER.test(f.pointer)) : [];

  const panelProps = (p: PanelSpec): PanelFrameProps => ({
    panel: p,
    tenant,
    mode: s.mode,
    readOnly: saving,
    selected: edit && s.selected === p.id,
    onEdit: (id: string) => {
      dispatch({ type: 'enterEdit' });
      dispatch({ type: 'select', id });
    },
    onKeyOp: (id: string, op: LayoutOp) => {
      dispatch({ type: 'keyOp', id, op });
    },
  });

  const viewGrid = (panels: readonly PanelSpec[]) => (
    <BoardGridView
      panels={panels}
      renderPanel={(p, place, className) => (
        <PanelFrame key={p.id} ref={place} className={className} {...panelProps(p)} />
      )}
    />
  );

  const grid = (panels: readonly PanelSpec[], ref: GridRef) =>
    edit ? (
      <Suspense fallback={viewGrid(panels)}>
        <BoardGridEditor
          panels={panels}
          readOnly={saving}
          onLayout={(items) => {
            dispatch({ type: 'layout', grid: ref, items });
          }}
          onBlocked={(p) => {
            dispatch({ type: 'announce', text: blockedText(p) });
          }}
          renderPanel={(p) => <PanelFrame {...panelProps(p)} />}
        />
      </Suspense>
    ) : (
      viewGrid(panels)
    );

  const empty = s.draft.panels.length === 0 && s.draft.sections.length === 0;

  return (
    <div className={cx(styles['page'])}>
      <div className={cx(styles['bar'])}>
        <ContextSummary />
        {edit ? (
          <BoardToolbar
            mode="edit"
            saving={saving}
            dirty={dirty}
            savesTime={s.draft.time !== undefined}
            onAdd={() => {
              dispatch({ type: 'addPanel' });
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
              dispatch({ type: 'enterEdit' });
            }}
            onPreloadEdit={preloadGridEditor}
          />
        )}
      </div>
      {edit && (
        <p role="status" aria-label={t('board.saveStatus')} className={cx(styles['status'])}>
          {statusText}
        </p>
      )}
      {boardErrors.map((f) => (
        <p key={f.pointer} className={cx(styles['status'])}>
          {fieldMessage(f.messageKey)}
        </p>
      ))}
      <p aria-live="polite" className={cx(styles['live'])} data-board-live="">
        {s.announce}
      </p>
      {s.remote !== null && (
        <p className={cx(styles['notice'])}>{t('board.remote', { version: s.remote.version })}</p>
      )}
      <div className={cx(styles['workspace'])}>
        <div className={cx(styles['grids'])}>
          {empty && !edit ? (
            <EmptyState title={t('board.noPanels')} />
          ) : (
            <>
              {(s.draft.panels.length > 0 || edit) && grid(s.draft.panels, 'top')}
              {s.draft.sections.map((sec, j) => (
                <section key={sec.id} className={cx(styles['section'])} aria-label={sec.title}>
                  <h2 className={cx(styles['sectionTitle'])}>{sec.title}</h2>
                  {grid(sec.panels, j)}
                </section>
              ))}
            </>
          )}
        </div>
        {edit && selected !== undefined && (
          <PanelEditor
            key={selected.panel.id}
            panel={selected.panel}
            pointer={panelPointer(selected.grid, selected.index)}
            fields={s.save.status === 'invalid' ? s.save.fields : []}
            readOnly={saving}
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
}
