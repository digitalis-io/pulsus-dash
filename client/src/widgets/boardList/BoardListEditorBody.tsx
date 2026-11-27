/**
 * The Board list's editor body (plan #216 Part 2b §4.1; T24-021, T24-023, T08-008), inside
 * `WidgetEditor` below Title: the preview on top (a group named by its visible caption, holding the
 * 2a body with `preview` over the draft debounced by `SEARCH_COMMIT_MS`, 240 px tall and `inert`),
 * then Show, Search text or Tag (the one the mode needs), Rows and Order. Each change writes the
 * vis through `boardListVis`, in the head's stored representation.
 *
 * Search text and Rows keep a local text, seeded from the option and seeded again when the option
 * changes from outside (Discard, a remote head). A local text that cannot be written (a Cc
 * character or more than 100 code points; Rows not a whole number from 1 to 50) stays shown with
 * its error and reaches no draft; the body reports the first such text through `onLocalInvalid`
 * (null when none, and on unmount), and the editor blocks Done and Save meanwhile. A field shows its
 * local error first, then the draft's live error (`widgetVisErrors`), then the last save's.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { BoardListMode } from '../../api/types';
import { CAPABILITIES } from '../../app/capabilities';
import { fieldMessage } from '../../boards/fieldMessages';
import { widgetVisErrors } from '../../boards/spec';
import { t, type MessageId } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { SegmentedControl } from '../../kit/SegmentedControl';
import { Select } from '../../kit/Select';
import { TextField } from '../../kit/TextField';
import { useDebounced } from '../lists/useDebounced';
import { HAS_CC, SEARCH_COMMIT_MS, SEARCH_MAX } from '../lists/useSearchCommit';
import type { WidgetEditorBodyProps } from '../registry';
import { BoardListBody } from './BoardListBody';
import styles from './BoardListEditor.module.css';
import { boardListVis } from './boardListVis';
import { boardListOptions, type BoardListOptions } from './options';
import { rankingCaption } from './rows';

const MODES: readonly { id: BoardListMode; label: MessageId }[] = [
  { id: 'starred', label: 'boardList.mode.starred' },
  { id: 'recent', label: 'boardList.mode.recent' },
  { id: 'search', label: 'boardList.mode.search' },
  { id: 'tag', label: 'boardList.mode.tag' },
];

const SORTS: readonly { id: BoardListOptions['sort']; label: MessageId }[] = [
  { id: 'default', label: 'widget.boardList.sort.default' },
  { id: 'incidents', label: 'widget.boardList.sort.incidents' },
];

const MAX_ROWS = 50;
const ROWS = /^\d{1,2}$/;

/** The Search text's local error: a Cc character, or more than 100 code points (T24 §5.5). */
function queryProblem(text: string): string | null {
  if (HAS_CC.test(text)) return t('boardList.searchCc');
  if (Array.from(text).length > SEARCH_MAX) return fieldMessage('board.options.query.invalid');
  return null;
}

/** The limit Rows' text gives, or null when it is not a whole number from 1 to 50. */
function rowsValue(text: string): number | null {
  if (!ROWS.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_ROWS ? n : null;
}

/**
 * A field's local text: `seed` again when the option changes to a value the text does not already
 * give (`gives(text)`), else what the user typed.
 */
function useLocalText(
  seed: string,
  gives: (text: string) => string | null,
): [string, (text: string) => void] {
  const [state, setState] = useState({ seed, text: seed });
  let current = state;
  if (state.seed !== seed) {
    current = { seed, text: gives(state.text) === seed ? state.text : seed };
    setState(current);
  }
  const set = (text: string): void => {
    setState((s) => ({ ...s, text }));
  };
  return [current.text, set];
}

const givesQuery = (text: string): string | null => (queryProblem(text) === null ? text : null);
const givesRows = (text: string): string | null => {
  const n = rowsValue(text);
  return n === null ? null : String(n);
};

export function BoardListEditorBody({
  panel,
  pointer,
  fields,
  readOnly,
  original,
  onVis,
  onLocalInvalid,
}: WidgetEditorBodyProps): ReactElement {
  const o = useMemo(() => boardListOptions(panel.vis.options), [panel.vis.options]);
  const live = useMemo(() => widgetVisErrors(panel), [panel]);
  const shown = useDebounced(panel, SEARCH_COMMIT_MS);
  const captionId = useId();
  const queryHelpId = useId();
  const tagHelpId = useId();
  const rowsHelpId = useId();
  const [queryText, setQueryText] = useLocalText(o.mode === 'search' ? o.query : '', givesQuery);
  const [rowsText, setRowsText] = useLocalText(String(o.limit), givesRows);

  const queryLocal = o.mode === 'search' ? queryProblem(queryText) : null;
  const rowsLocal =
    rowsValue(rowsText) === null ? fieldMessage('board.options.limit.invalid') : null;
  const invalid = queryLocal ?? rowsLocal;

  // The first local text that cannot be written, for the editor's Done and the page's Save.
  const report = useRef(onLocalInvalid);
  useLayoutEffect(() => {
    report.current = onLocalInvalid;
  });
  useEffect(() => {
    report.current?.(invalid);
  }, [invalid]);
  useEffect(
    () => () => {
      report.current?.(null);
    },
    [],
  );

  const errorAt = (key: string, local: string | null = null): string | null => {
    if (local !== null) return local;
    const suffix = `/vis/options/${key}`;
    const f =
      live.find((x) => x.pointer === suffix) ??
      fields.find((x) => x.pointer === `${pointer}${suffix}`);
    return f === undefined ? null : fieldMessage(f.messageKey);
  };
  const set = (next: BoardListOptions): void => {
    onVis(boardListVis(next, original));
  };
  const caption = rankingCaption(o.sort, CAPABILITIES);

  return (
    <>
      <div role="group" aria-labelledby={captionId} className={cx(styles['previewGroup'])}>
        <p id={captionId} className={cx(styles['caption'])}>
          {t('widget.boardList.preview')}
        </p>
        <div className={cx(styles['preview'])} inert>
          <BoardListBody
            panel={shown}
            headingId={captionId}
            editing
            table={false}
            onTable={() => undefined}
            preview
          />
        </div>
      </div>
      <div className={cx(styles['fields'])}>
        <div className={cx(styles['wide'])}>
          <SegmentedControl
            label={t('widget.boardList.show')}
            options={MODES.map((m) => ({ id: m.id, label: t(m.label) }))}
            value={o.mode}
            isDisabled={readOnly}
            onChange={(mode) => {
              // Leaving search keeps no query and leaving tag no tag; entering tag keeps the tag.
              setQueryText('');
              set({ ...o, mode, query: '', tag: mode === 'tag' ? o.tag : null });
            }}
          />
        </div>
        {o.mode === 'search' && (
          <div className={cx(styles['wide'])}>
            <TextField
              label={t('widget.boardList.query')}
              value={queryText}
              onChange={(text) => {
                setQueryText(text);
                if (queryProblem(text) === null) set({ ...o, query: text });
              }}
              error={errorAt('query', queryLocal)}
              isReadOnly={readOnly}
              aria-describedby={queryHelpId}
              autoComplete="off"
              mono
            />
            <p id={queryHelpId} className={cx(styles['help'])}>
              {t('widget.boardList.queryHelp')}
            </p>
          </div>
        )}
        {o.mode === 'tag' && (
          <div className={cx(styles['wide'])}>
            <TextField
              label={t('widget.boardList.tag')}
              value={o.tag ?? ''}
              onChange={(text) => {
                set({ ...o, tag: text === '' ? null : text });
              }}
              error={errorAt('tag')}
              isReadOnly={readOnly}
              aria-describedby={tagHelpId}
              autoComplete="off"
              mono
            />
            <p id={tagHelpId} className={cx(styles['help'])}>
              {t('widget.boardList.tagHelp')}
            </p>
          </div>
        )}
        <div>
          <TextField
            label={t('widget.boardList.limit')}
            value={rowsText}
            inputMode="numeric"
            onChange={(text) => {
              setRowsText(text);
              const n = rowsValue(text);
              if (n !== null) set({ ...o, limit: n });
            }}
            error={errorAt('limit', rowsLocal)}
            isReadOnly={readOnly}
            aria-describedby={rowsHelpId}
            autoComplete="off"
          />
          <p id={rowsHelpId} className={cx(styles['help'])}>
            {t('widget.boardList.limitHelp')}
          </p>
        </div>
        <div>
          <Select
            label={t('widget.boardList.sort')}
            value={o.sort}
            options={SORTS.map((s) => ({ id: s.id, label: t(s.label) }))}
            onChange={(sort) => {
              set({ ...o, sort });
            }}
            error={errorAt('sort')}
            isDisabled={readOnly}
          />
          {caption !== null && <p className={cx(styles['help'])}>{caption}</p>}
        </div>
      </div>
    </>
  );
}
