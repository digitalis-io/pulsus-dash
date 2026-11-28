/**
 * A Text panel's body (plan #198 Part 3a §3.1, §4.2; T24-008, T24-009, T24-014, T24-015, T24-017),
 * in the board route's chunk: it imports no sanitiser module. One named region in every state:
 *
 * 1. `invalid`: the save's own rules refuse the panel (`widgetVisErrors`); nothing renders and the
 *    Markdown chunk is not loaded. The board says why; the editor's preview says "Preview
 *    unavailable" in a status that describes the region.
 * 2. `empty`: blank content ("Write Markdown" while editing); no chunk load.
 * 3. `loading` / 4. `error` / 5. `content`: the lazy `TextMarkdown` entry. The options and the
 *    panel's set variables reach it through `useDeferredValue` (M0), so an input commits first and
 *    the Markdown renders in a transition while the previous output stays.
 *
 * The region scrolls its own content and is a tab stop exactly while that overflows
 * (`scrollHeight > clientHeight`), measured by one `ResizeObserver` on the region and its content
 * and after every commit that changes the state, the options or the variables.
 */
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { WidgetPanelSpec } from '../../api/types';
import { BoardRunContext } from '../../boards/boardRunContext';
import { fieldMessage } from '../../boards/fieldMessages';
import { widgetVisErrors } from '../../boards/spec';
import { panelVars } from '../../boards/variableRefs';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { EmptyState } from '../../kit/EmptyState';
import { textOptions, type TextOptions } from '../spec';
import { ChunkBoundary } from './ChunkBoundary';
import styles from './Text.module.css';

/** The Text widget's one dynamic entry, behind which all the Markdown code sits. */
export const loadTextMarkdown = () => import('./TextMarkdown');

// Memoised: a render of the body whose deferred options and variables are unchanged (another
// variable changed, the mode toggled) does not render the content again.
const TextContent = lazy(async () => {
  const m = await loadTextMarkdown();
  return { default: memo(m.TextContent) };
});

/** The region's accessible name: the frame's heading on a board, a label in the preview. */
export type RegionName = { labelledBy: string } | { label: string };

export interface TextBodyProps {
  panel: WidgetPanelSpec;
  name: RegionName;
  /** The board is in Edit mode, or this is the editor's preview: the empty state invites writing. */
  editing: boolean;
  context: 'board' | 'preview';
}

export type TextState = 'empty' | 'invalid' | 'loading' | 'error' | 'content';
type ChunkState = 'loading' | 'error' | 'content';

const NO_VARS: ReadonlyMap<string, string> = new Map();
/** `textVars` results by their entries, so equal entries give the same map (at most 64 kept). */
const varsMemo = new Map<string, ReadonlyMap<string, string>>();
const VARS_MEMO_SIZE = 64;

/**
 * The set variables `o.content` references, in name order; empty in code mode (T24-008). Memoised
 * by its entries: a change to a variable the content does not reference gives the same map.
 */
export function textVars(
  all: ReadonlyMap<string, string>,
  o: TextOptions,
): ReadonlyMap<string, string> {
  if (o.mode !== 'markdown') return NO_VARS;
  const entries = panelVars(o.content, all);
  if (entries.length === 0) return NO_VARS;
  const key = JSON.stringify(entries);
  const hit = varsMemo.get(key);
  if (hit !== undefined) {
    varsMemo.delete(key);
    varsMemo.set(key, hit);
    return hit;
  }
  const vars: ReadonlyMap<string, string> = new Map(entries);
  varsMemo.set(key, vars);
  if (varsMemo.size > VARS_MEMO_SIZE) {
    const oldest = varsMemo.keys().next();
    if (oldest.done !== true) varsMemo.delete(oldest.value);
  }
  return vars;
}

/** Reports which side of the lazy entry committed: its fallback, its error or its content. */
function Phase({
  phase,
  report,
  children,
}: {
  phase: ChunkState;
  report: (p: ChunkState) => void;
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    report(phase);
  }, [phase, report]);
  return children;
}

export const TextBody = memo(function TextBody({
  panel,
  name,
  editing,
  context,
}: TextBodyProps): ReactElement {
  const statusId = useId();
  const options = useMemo(() => textOptions(panel.vis.options), [panel.vis.options]);
  const errors = useMemo(() => widgetVisErrors(panel), [panel]);
  const { displayVars: all } = useContext(BoardRunContext);
  const vars = textVars(all, options);
  const deferredOptions = useDeferredValue(options);
  const deferredVars = useDeferredValue(vars);
  const [chunk, setChunk] = useState<ChunkState>('loading');

  const first = errors[0];
  const state: TextState =
    first !== undefined ? 'invalid' : options.content.trim() === '' ? 'empty' : chunk;

  const region = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const measure = useCallback(() => {
    const r = region.current;
    if (r === null) return;
    const next = r.scrollHeight > r.clientHeight;
    setOverflows((was) => (was === next ? was : next));
  }, []);
  useEffect(() => {
    const r = region.current;
    const c = content.current;
    if (r === null || c === null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(r);
    ro.observe(c);
    return () => {
      ro.disconnect();
    };
  }, [measure]);
  useLayoutEffect(() => {
    measure();
  }, [measure, state, deferredOptions, deferredVars]);

  let body: ReactNode;
  if (first !== undefined) {
    const reason = fieldMessage(first.messageKey);
    body =
      context === 'preview' ? (
        <p id={statusId} role="status" className={cx(styles['message'])}>
          {t('widget.text.invalidPreview', { reason })}
        </p>
      ) : (
        <p className={cx(styles['message'])}>{t('widget.text.invalid', { reason })}</p>
      );
  } else if (state === 'empty') {
    body = <EmptyState title={t(editing ? 'widget.text.write' : 'widget.text.empty')} />;
  } else {
    body = (
      <ChunkBoundary
        fallback={
          <Phase phase="error" report={setChunk}>
            <p className={cx(styles['message'])}>{t('widget.text.loadFailed')}</p>
          </Phase>
        }
      >
        <Suspense
          fallback={
            <Phase phase="loading" report={setChunk}>
              <p className={cx(styles['message'])} aria-busy="true">
                {t('panel.loading')}
              </p>
            </Phase>
          }
        >
          <Phase phase="content" report={setChunk}>
            <TextContent panelId={panel.id} options={deferredOptions} vars={deferredVars} />
          </Phase>
        </Suspense>
      </ChunkBoundary>
    );
  }

  const named =
    'labelledBy' in name ? { 'aria-labelledby': name.labelledBy } : { 'aria-label': name.label };
  return (
    <div
      ref={region}
      role="region"
      {...named}
      aria-describedby={first !== undefined && context === 'preview' ? statusId : undefined}
      // A scrolling region is reachable by keyboard while it overflows (T24-017).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={overflows ? 0 : undefined}
      className={cx(styles['region'])}
      data-text-body=""
      data-text-state={state}
    >
      <div ref={content} data-text-measure="">
        {body}
      </div>
    </div>
  );
});
