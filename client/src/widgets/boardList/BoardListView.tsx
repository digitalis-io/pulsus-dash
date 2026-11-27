/**
 * A Board list's view (plan #216 Part 2a §4.3; T24-021 to T24-027, T22-013), top to bottom: the
 * search field (search mode), the ranking caption, the notice (an old server's tag mode, or a
 * failed refresh with Retry), the list area, the meter, then the sr-only summary and live region.
 * Tab order: field → list → Show more → meter (T24-025).
 *
 * The list area is the rows and Show more (ok), "Loading…" after 300 ms (pending), the empty text
 * (a focus target, `tabIndex -1`) or the error with Retry; with `table` it is the kit `PanelTable`
 * over the snapshot's rows (`drawn` = shown), or the state's text with Export disabled. The field,
 * caption, notice, meter, summary and live region stay in both.
 *
 * A row is a link as the sidebar's (the board's path, the time Context, `BOARD_LINK_STATE`,
 * preloading the board route) named `‹display›[, this board]`; search and tag rows have a meta line
 * (≤ 3 tag chips and `+k`, or "tags unknown", and `updated d MMM HH:mm` in the Context's zone) as
 * the link's description. Rows new on a same-key refresh are `data-new` (a 150 ms fade, none under
 * reduced motion).
 */
import { useId, useMemo, useRef, useState, type ReactElement, type Ref } from 'react';
import { Link } from 'react-router';
import { PanelTable, type TableView } from '../../charts/PanelTable';
import { CoverageMeter } from '../../charts/CoverageMeter';
import { preloadRoute } from '../../app/routeModules';
import { useDelayedFlag } from '../../explore/useDelayedFlag';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { TextField } from '../../kit/TextField';
import { BOARD_LINK_STATE } from '../../shell/SidebarBoards';
import { contextSearchString } from '../../state/contextSearch';
import { useTimeZone } from '../../state/timeZone';
import { useTimeContext } from '../../state/useTimeContext';
import { clockText } from '../../vis/reduce';
import { listSetSize, type ListSnapshot } from '../lists/snapshot';
import type { ListKeys } from '../lists/useListKeys';
import { SEARCH_MAX, type SearchCommit } from '../lists/useSearchCommit';
import styles from './BoardList.module.css';
import { boardListTable, boardRowName, type BoardRow } from './rows';
import type { BoardListModel } from './useBoardList';

/** The search field of a search list. */
export interface ListField {
  readonly commit: SearchCommit;
  /** No Esc ladder on the page: the field clears itself on Esc. */
  readonly clearsOnEsc: boolean;
}

const MAX_CHIPS = 3;
const PENDING_DELAY_MS = 300;
const COUNT = new Intl.NumberFormat('en-GB');
const stamps = new Map<string, Intl.DateTimeFormat>();

/** `d MMM HH:mm` in `tz` (en-GB parts, h23). */
function updatedText(iso: string, tz: string): string {
  let f = stamps.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: tz,
    });
    stamps.set(tz, f);
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    f.formatToParts(Date.parse(iso)).find((p) => p.type === type)?.value ?? '';
  return `${part('day')} ${part('month')} ${part('hour')}:${part('minute')}`;
}

/** The empty text of the model's mode (T24 §4.5). */
export function emptyText(m: Pick<BoardListModel, 'mode' | 'q' | 'tag'>): string {
  switch (m.mode) {
    case 'starred':
      return t('boardList.empty.starred');
    case 'recent':
      return t('boardList.empty.recent');
    case 'search':
      return m.q === '' ? t('boardList.empty.searchAll') : t('boardList.empty.search', { q: m.q });
    case 'tag':
      return t('boardList.empty.tag', { tag: m.tag ?? '' });
  }
}

/** The state text of a list without rows to show (the table's status). */
function stateText(m: BoardListModel): string {
  if (m.phase === 'pending') return t('boardList.loading');
  if (m.phase === 'error')
    return m.error === 'store' ? t('boardList.storeUnavailable') : t('boardList.failed');
  if (m.notice === 'tagNeedsServer') return t('boardList.tagNeedsServer');
  return emptyText(m);
}

/** The uids new on a same-key refresh of `m` (none on a key's first snapshot). */
function useFreshRows(m: BoardListModel): ReadonlySet<string> {
  const listKey = JSON.stringify(m.key);
  const [seen, setSeen] = useState<{
    listKey: string;
    at: number;
    uids: ReadonlySet<string> | null;
    fresh: ReadonlySet<string>;
  }>({ listKey, at: m.answerGen, uids: null, fresh: new Set() });
  let s = seen;
  const rows = m.snapshot?.rows ?? null;
  if (s.listKey !== listKey) {
    s = { listKey, at: m.answerGen, uids: rows === null ? null : uidsOf(rows), fresh: new Set() };
  } else if (s.at !== m.answerGen && rows !== null) {
    const before = s.uids;
    s = {
      listKey,
      at: m.answerGen,
      uids: uidsOf(rows),
      fresh:
        before === null
          ? new Set()
          : new Set(rows.filter((r) => !before.has(r.uid)).map((r) => r.uid)),
    };
  } else if (s.uids === null && rows !== null) {
    s = { ...s, uids: uidsOf(rows) };
  }
  if (s !== seen) setSeen(s);
  return s.fresh;
}

/** The table's rows while it is shown: every loaded row, `drawn` when shown (memoised). */
function useTableView(
  table: boolean,
  s: ListSnapshot<BoardRow> | null,
  shown: number,
): TableView | null {
  return useMemo(() => {
    if (!table || s === null) return null;
    const tv = boardListTable(s);
    return { columns: tv.columns, rows: tv.rows.map((r, i) => ({ ...r, drawn: i < shown })) };
  }, [table, s, shown]);
}

const uidsOf = (rows: readonly BoardRow[]): ReadonlySet<string> => new Set(rows.map((r) => r.uid));

function Meta({ row, id, tz }: { row: BoardRow; id: string; tz: string }): ReactElement {
  const more = row.tags === null ? 0 : row.tags.length - MAX_CHIPS;
  return (
    <span id={id} className={cx(styles['meta'])}>
      {row.tags === null ? (
        <span className={cx(styles['muted'])}>{t('boardList.tagsUnknown')}</span>
      ) : (
        <>
          {row.tags.slice(0, MAX_CHIPS).map((tag) => (
            <span key={tag} className={cx(styles['chip'])} data-board-list-chip="">
              {tag}
            </span>
          ))}
          {more > 0 && (
            <span className={cx(styles['chip'])} data-board-list-chip="">
              {t('boardList.moreTags', { k: more })}
            </span>
          )}
        </>
      )}
      {row.updatedAt !== null && (
        <span className={cx(styles['muted'])}>
          {t('boardList.updated', { time: updatedText(row.updatedAt, tz) })}
        </span>
      )}
    </span>
  );
}

export interface BoardListViewProps {
  readonly ref: Ref<HTMLDivElement>;
  readonly model: BoardListModel;
  /** The shown rows. */
  readonly rows: readonly BoardRow[];
  readonly headingId: string;
  readonly title: string;
  readonly tenant: string;
  readonly field: ListField | null;
  readonly table: boolean;
  readonly onTable: (on: boolean) => void;
  readonly keys: ListKeys;
  readonly live: string;
}

export function BoardListView({ ref, ...p }: BoardListViewProps): ReactElement {
  const { model: m, rows, field, keys } = p;
  const summaryId = useId();
  const metaId = useId();
  const tz = useTimeZone();
  const { search } = useTimeContext();
  const late = useDelayedFlag(m.phase === 'pending', PENDING_DELAY_MS);
  const fieldRef = useRef<HTMLInputElement>(null);
  const fresh = useFreshRows(m);
  const s = m.snapshot;
  const linkSearch = contextSearchString(search);

  const table = p.table;
  const shown = m.shown;
  const tableView = useTableView(table, s, shown);

  const loaded = s?.rows.length ?? 0;
  const facts = m.facts;
  const retry = (fallback: boolean) => (
    <Button
      variant="secondary"
      onPress={m.retry}
      {...(fallback ? { 'data-board-list-fallback': '' } : {})}
    >
      {t('boardList.retry')}
    </Button>
  );

  let area: ReactElement | null;
  if (p.table) {
    area = (
      <div className={cx(styles['tableArea'])}>
        <PanelTable
          rows={tableView}
          title={p.title}
          caption={t('boardList.tableCaption', {
            n: COUNT.format(loaded),
            d: COUNT.format(m.shown),
          })}
          closeLabel={t('boardList.showList')}
          emptyText={stateText(m)}
          selected={new Set<string>()}
          onClose={() => {
            p.onTable(false);
          }}
        />
      </div>
    );
  } else if (m.phase === 'ok' && s !== null) {
    const setSize = listSetSize(s);
    area = (
      <>
        {/* The keys of the roving tab stop reach the list from its focused row. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <ul
          className={cx(styles['rows'])}
          aria-labelledby={p.headingId}
          aria-describedby={summaryId}
          data-board-list-rows=""
          onKeyDown={keys.onListKeyDown}
        >
          {rows.map((r, i) => {
            const meta = m.mode === 'search' || m.mode === 'tag';
            const rp = keys.rowProps(r.uid, i);
            return (
              <li
                key={r.uid}
                aria-setsize={setSize}
                aria-posinset={i + 1}
                className={cx(styles['row'])}
                data-new={fresh.has(r.uid) ? '' : undefined}
              >
                <Link
                  ref={rp.ref}
                  tabIndex={rp.tabIndex}
                  to={{ pathname: `/t/${p.tenant}/board/${r.uid}`, search: linkSearch }}
                  state={BOARD_LINK_STATE}
                  className={cx(styles['link'])}
                  aria-label={boardRowName(r)}
                  aria-current={r.current ? 'page' : undefined}
                  aria-describedby={meta ? `${metaId}-${String(i)}` : undefined}
                  data-row-key={r.uid}
                  onPointerEnter={() => {
                    preloadRoute('board');
                  }}
                  onFocus={() => {
                    preloadRoute('board');
                  }}
                >
                  <span className={cx(styles['title'])}>{r.title}</span>
                  {r.display !== r.title && (
                    <span className={cx(styles['uid'])}>{` · ${r.uid}`}</span>
                  )}
                  {r.current && (
                    <span className={cx(styles['muted'])}>{` ${t('boardList.thisBoard')}`}</span>
                  )}
                  {meta && <Meta row={r} id={`${metaId}-${String(i)}`} tz={tz} />}
                </Link>
              </li>
            );
          })}
        </ul>
        {m.shown < loaded && (
          <Button
            variant="ghost"
            onPress={() => {
              keys.focusRow(m.showMore());
            }}
          >
            {t('boardList.showMore')}
          </Button>
        )}
      </>
    );
  } else if (m.phase === 'pending') {
    area = late ? (
      <p role="status" className={cx(styles['state'])}>
        {t('boardList.loading')}
      </p>
    ) : null;
  } else if (m.phase === 'error') {
    area = (
      <div className={cx(styles['state'])}>
        <p className={cx(styles['stateText'])}>{stateText(m)}</p>
        {retry(true)}
      </div>
    );
  } else if (m.notice !== null) {
    area = null;
  } else {
    area = (
      <p tabIndex={-1} className={cx(styles['state'])} data-board-list-fallback="">
        {emptyText(m)}
      </p>
    );
  }

  const commit = field?.commit ?? null;
  return (
    <div
      ref={ref}
      className={cx(styles['root'])}
      data-board-list=""
      data-board-list-mode={m.mode}
      data-board-list-phase={m.phase}
      data-board-list-fetching={m.fetching ? '' : undefined}
      data-board-list-updated={String(m.updatedAtMs)}
    >
      {field !== null && commit !== null && (
        <TextField
          label={t('boardList.search')}
          value={commit.text}
          onChange={commit.setText}
          maxLength={SEARCH_MAX}
          escapeLadder
          inputRef={fieldRef}
          error={commit.cc ? t('boardList.searchCc') : null}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && field.clearsOnEsc && commit.text !== '') {
              commit.clear();
              return;
            }
            e.continuePropagation();
          }}
        />
      )}
      {m.caption !== null && <p className={cx(styles['caption'])}>{m.caption}</p>}
      {m.notice === 'tagNeedsServer' && (
        <p className={cx(styles['notice'])} data-board-list-notice="">
          {t('boardList.tagNeedsServer')}
        </p>
      )}
      {m.refreshFailed && s !== null && (
        <div className={cx(styles['notice'])} data-board-list-notice="">
          <p className={cx(styles['stateText'])}>
            {t('boardList.refreshFailed', { time: clockText(s.fetchedAtMs, tz) })}
          </p>
          {retry(false)}
        </div>
      )}
      {p.table && m.phase === 'error' && (
        <div className={cx(styles['notice'])} data-board-list-notice="">
          {retry(false)}
        </div>
      )}
      <div className={cx(styles['area'])}>{area}</div>
      {s !== null ? (
        <CoverageMeter
          coverage={s.coverage}
          timeZone={tz}
          {...(field === null
            ? {}
            : {
                // After the popover's own focus restore (a frame after it closes).
                onNarrow: () => {
                  requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                      fieldRef.current?.focus();
                    });
                  });
                },
              })}
        />
      ) : (
        <div className={cx(styles['meter'])} data-coverage-meter="">
          <p role="status" className={cx(styles['meterText'])}>
            {t(m.phase === 'error' ? 'meter.unavailable' : 'meter.loading')}
          </p>
        </div>
      )}
      <p id={summaryId} className={cx(styles['srOnly'])} data-board-list-summary="">
        {facts === null
          ? ''
          : t('boardList.summary', {
              mode: facts.current?.series ?? '',
              text: facts.current?.text ?? '',
            })}
      </p>
      <p aria-live="polite" className={cx(styles['srOnly'])} data-board-list-live="">
        {p.live}
      </p>
    </div>
  );
}
