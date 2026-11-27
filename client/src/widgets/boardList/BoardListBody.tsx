/**
 * A Board list panel's body (plan #216 Part 2a §4.2; T24-014, T24-020 to T24-027), in the board
 * route's chunk. The outer body validates first: invalid options show the T24-014 state and fetch
 * nothing. A search list (`SearchBoardList`) owns its field; the other modes (`FixedBoardList`) have
 * none. Each component has a fixed hook list, and a mode or validity change swaps the child (another
 * element type and key), so no hook list changes in place.
 *
 * `BoardListCore` reads the model (`useBoardList`), owns Shift+T (not in a text field), the keys
 * (`useListKeys`) and the announcements (`useListAnnouncer`), and renders `BoardListView`. In the
 * stub and dev builds (not http), under the bench's flag, it marks each render and measures
 * `boardList:render` per commit (`bench:widget-lists`).
 *
 * `preview` (plan #216 Part 2b §4.1, the widget editor): every mode goes through `FixedBoardList`,
 * a search list with `q` = its trimmed query, so the preview registers no Escape or Inspector
 * provider; Shift+T is off and the view is inert text (`BoardListView`).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { WidgetPanelSpec } from '../../api/types';
import { fieldMessage } from '../../boards/fieldMessages';
import { widgetVisErrors } from '../../boards/spec';
import { t } from '../../i18n/t';
import { useInspector } from '../../inspector/host';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { inTextField } from '../../kit/inTextField';
import { useShellRoute } from '../../shell/useShellRoute';
import { useListAnnouncer } from '../lists/announce';
import { useListKeys } from '../lists/useListKeys';
import { useSearchCommit } from '../lists/useSearchCommit';
import styles from './BoardList.module.css';
import { BoardListView, emptyText, type ListField } from './BoardListView';
import { boardListOptions, type BoardListOptions } from './options';
import { useBoardList } from './useBoardList';

export interface BoardListBodyProps {
  panel: WidgetPanelSpec;
  /** The id of the frame's heading, which names the list. */
  headingId: string;
  editing: boolean;
  /** The table view is shown (Shift+T, the Panel menu). */
  table: boolean;
  onTable: (on: boolean) => void;
  /**
   * The editor's preview (plan #216 Part 2b §4.1): a search list reads its stored query through
   * `FixedBoardList` (no field, no Esc provider) and the view draws plain, link-free rows.
   */
  preview?: boolean;
}

/**
 * Render timing for `bench:widget-lists`: the stub and dev builds only, and only while the bench
 * has set `localStorage['pulsus-dash.bench.boardList']` to `1` before the page loads, so no other
 * session accumulates timing entries.
 */
function benchOn(): boolean {
  if (!(import.meta.env.DEV || import.meta.env['VITE_API_MODE'] !== 'http')) return false;
  try {
    return localStorage.getItem('pulsus-dash.bench.boardList') === '1';
  } catch {
    return false;
  }
}
const BENCH = benchOn();
const RENDER_MARK = 'boardList:render:start';
const COUNT = new Intl.NumberFormat('en-GB');

type ModeProps = BoardListBodyProps & { readonly options: BoardListOptions };

interface CoreProps extends ModeProps {
  readonly q: string;
  /** The search field; null for the other modes. */
  readonly field: ListField | null;
  /** The user typed since the field last reset: a committed search's first answer is announced. */
  readonly typed: boolean;
}

function BoardListCore(p: CoreProps): ReactElement {
  if (BENCH) performance.mark(RENDER_MARK);
  const { panel, table, onTable, options, q, field, typed } = p;
  const { tenant, uid } = useShellRoute();
  const title = panel.title === '' ? t('panel.untitled') : panel.title;
  const model = useBoardList({ tenant, currentUid: uid ?? null, title, options, q });
  const rootRef = useRef<HTMLDivElement>(null);
  const { text: live, announce } = useListAnnouncer();

  const snapshot = model.snapshot;
  const shownRows = useMemo(
    () => (snapshot === null ? [] : snapshot.rows.slice(0, model.shown)),
    [snapshot, model.shown],
  );
  const keysList = useMemo(() => shownRows.map((r) => r.uid), [shownRows]);
  const names = useMemo(() => new Map(shownRows.map((r) => [r.uid, r.display])), [shownRows]);
  const listKey = JSON.stringify(model.key);
  const keys = useListKeys({
    keys: keysList,
    listKey,
    names,
    fallback: () =>
      rootRef.current?.querySelector<HTMLElement>('[data-board-list-fallback]') ?? null,
    onGone: (name) => {
      announce(t('boardList.gone', { name }));
    },
  });

  // A search the user committed: its first ok or empty answer is announced (T24-025).
  const target = useRef<string | null>(null);
  const seenKey = useRef(listKey);
  const seenQ = useRef(q);
  const { phase, mode } = model;
  const settledText =
    snapshot === null || (phase !== 'ok' && phase !== 'empty')
      ? null
      : phase === 'empty'
        ? emptyText(model)
        : snapshot.rows.length === 1
          ? t('boardList.countOne')
          : t('boardList.count', { n: COUNT.format(snapshot.rows.length) });
  useEffect(() => {
    if (seenKey.current !== listKey) {
      // Only a key the user's commit made (a new `q`) is announced, not a tenant change.
      const committed = seenQ.current !== q;
      seenKey.current = listKey;
      seenQ.current = q;
      target.current = typed && committed && mode === 'search' ? listKey : null;
    }
    if (target.current !== listKey || settledText === null) return;
    target.current = null;
    announce(settledText);
  }, [listKey, q, typed, mode, settledText, announce]);

  // Shift+T flips the table (native listener: the root is no control of its own).
  const preview = p.preview === true;
  const tableRef = useRef({ table, onTable, preview });
  useLayoutEffect(() => {
    tableRef.current = { table, onTable, preview };
  });
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (tableRef.current.preview) return;
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'T' && e.key !== 't') return;
      if (inTextField(e.target)) return;
      e.preventDefault();
      tableRef.current.onTable(!tableRef.current.table);
    };
    root.addEventListener('keydown', onKey);
    return () => {
      root.removeEventListener('keydown', onKey);
    };
  }, []);
  // Focus follows the swap: the grid on open, the active row (else the state element) on close.
  const shownTable = useRef(table);
  const activeKey = keys.activeKey;
  useEffect(() => {
    if (shownTable.current === table) return;
    shownTable.current = table;
    const root = rootRef.current;
    if (root === null) return;
    const row =
      activeKey === null
        ? null
        : root.querySelector<HTMLElement>(
            `[data-board-list-rows] a[data-row-key="${CSS.escape(activeKey)}"]`,
          );
    const to = table
      ? (root.querySelector<HTMLElement>('[role=grid]') ??
        root.querySelector<HTMLElement>('[data-panel-table] button'))
      : (row ?? root.querySelector<HTMLElement>('[data-board-list-fallback]'));
    to?.focus();
  }, [table, activeKey]);

  useLayoutEffect(() => {
    if (!BENCH) return;
    performance.measure('boardList:render', RENDER_MARK);
    performance.clearMarks(RENDER_MARK);
  });

  return (
    <BoardListView
      ref={rootRef}
      model={model}
      rows={shownRows}
      headingId={p.headingId}
      title={title}
      tenant={tenant}
      field={field}
      table={table}
      onTable={onTable}
      keys={keys}
      live={live}
      preview={preview}
    />
  );
}

/** True once `text` differs from `initial`, until `initial` changes. */
function useTypedSince(initial: string, text: string): boolean {
  const [state, setState] = useState({ initial, typed: false });
  let s = state;
  if (s.initial !== initial) s = { initial, typed: false };
  if (!s.typed && text !== initial) s = { ...s, typed: true };
  if (s !== state) setState(s);
  return s.typed;
}

function SearchBoardList(p: ModeProps): ReactElement {
  const commit = useSearchCommit(p.options.query);
  const host = useInspector();
  const panelId = p.panel.id;
  const latest = useRef(commit);
  useLayoutEffect(() => {
    latest.current = commit;
  });
  // The T25-007 pre step: Esc clears the field first, then the ladder carries on.
  useEffect(() => {
    if (host === null) return;
    return host.registerEscape(panelId, {
      pre: () => (latest.current.text !== '' ? latest.current.clear : null),
      post: () => null,
    });
  }, [host, panelId]);
  const typed = useTypedSince(p.options.query, commit.text);
  return (
    <BoardListCore
      {...p}
      q={commit.q}
      field={{ commit, clearsOnEsc: host === null }}
      typed={typed}
    />
  );
}

function FixedBoardList(p: ModeProps): ReactElement {
  const q = p.preview === true && p.options.mode === 'search' ? p.options.query.trim() : '';
  return <BoardListCore {...p} q={q} field={null} typed={false} />;
}

export function BoardListBody(p: BoardListBodyProps): ReactElement {
  const errors = useMemo(() => widgetVisErrors(p.panel), [p.panel]);
  const options = useMemo(() => boardListOptions(p.panel.vis.options), [p.panel.vis.options]);
  const first = errors[0];
  if (first !== undefined) {
    return (
      <div className={cx(styles['invalid'])} data-board-list-invalid="">
        <EmptyState title={t('boardList.invalid', { reason: fieldMessage(first.messageKey) })} />
      </div>
    );
  }
  return options.mode === 'search' && p.preview !== true ? (
    <SearchBoardList key="search" {...p} options={options} />
  ) : (
    <FixedBoardList key="fixed" {...p} options={options} />
  );
}
