/**
 * The geomap's mark list (T24-093, T24 §5.16; plan #234 Part 3 §3.4, §4.3): a visually hidden
 * `<ul aria-label="‹title›: map marks">` of buttons, one per in-view mark in the engine's keyboard
 * order, with one roving tab stop (T24-025). The names, `aria-posinset` and `aria-setsize` are on
 * each item. Handled keys are prevented and stopped: ↑/← and ↓/→, Home/End, PageUp/PageDown (±10,
 * clamped), Enter/Space (inspect), Shift+arrows (pan), `+`/`=`, `-` and `0`; every other key, Esc
 * included, goes on to the page's ladder (T25-007). With no mark in view one item reads "No marks
 * in view · Fit"; while it is focused it stays when marks return.
 *
 * Repair on new marks: the same id, else the mark holding the old seed or key, else the old index
 * clamped, else the placeholder. Focus moves only when it was inside the list, and a refetch that
 * drops the focused mark announces "‹old name› is no longer shown".
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import type { CameraKey, ChartFrame as EngineFrame, GeoMarksEvent, Unit } from '../../engine/api';
import { formatValue } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { Selection } from '../../inspector/types';
import { cx } from '../../kit/cx';
import type { GeoRow, GeoRowSet } from '../../vis/geo/frame';
import {
  geoPlace,
  geoTarget,
  seedOf,
  worstState,
  type GeoInspectorTarget,
} from '../../vis/geo/targets';
import styles from '../GeoMapFrame.module.css';

type Mark = GeoMarksEvent['marks'][number];

export interface GeoMarkListProps {
  readonly title: string;
  readonly marks: GeoMarksEvent['marks'];
  readonly rows: ReadonlyMap<string, GeoRow>;
  readonly unit: Unit;
  /** The meter reads `100 %`. */
  readonly complete: boolean;
  readonly selection: Selection | null;
  readonly frame: EngineFrame | null;
  /** The row set's frame sequence: a new one is a refetch. */
  readonly seq: number;
  readonly rowSet: GeoRowSet;
  readonly onInspect: (t: GeoInspectorTarget, f: HTMLElement) => void;
  /** The focused mark (its id), or null when focus leaves the list. */
  readonly onActive: (id: string | null) => void;
  readonly announce: (text: string) => void;
}

/** The marks a page key moves by. */
const PAGE = 10;

/**
 * A mark's accessible name (T24-093): a marker `‹name›, ‹value›[, ‹state›], ‹place›[, selected]`;
 * a cluster `Cluster of ‹n›, near ‹seed place›[, worst ‹state›][, ‹k› selected]`. States only with
 * thresholds.
 */
export function geoMarkName(
  m: Mark,
  rows: GeoMarkListProps['rows'],
  unit: Unit,
  sel: Selection | null,
  thresholds: boolean,
): string {
  const keys = new Set(sel?.keys ?? []);
  if (m.kind === 'marker') {
    const r = rows.get(m.keys[0] ?? m.id);
    if (r === undefined) return m.id;
    const parts = [r.name, formatValue(r.value, unit)];
    if (thresholds && r.state !== null) parts.push(r.state);
    const place = geoPlace(r);
    if (place !== '') parts.push(place);
    if (keys.has(r.key)) parts.push(t('geo.list.selected'));
    return parts.join(', ');
  }
  const members = m.keys.map((k) => rows.get(k)).filter((r): r is GeoRow => r !== undefined);
  const seed = rows.get(seedOf(m.id) ?? '') ?? members[0];
  const parts = [
    t('geo.cluster.title', { n: m.keys.length }),
    t('geo.list.near', { place: seed === undefined ? '' : geoPlace(seed) }),
  ];
  const worst = worstState(members);
  if (thresholds && worst !== null) parts.push(t('geo.list.worst', { state: worst }));
  const k = m.keys.filter((x) => keys.has(x)).length;
  if (k > 0) parts.push(t('geo.list.someSelected', { k }));
  return parts.join(', ');
}

interface Active {
  /** The active mark's id; null: the placeholder (or nothing yet). */
  readonly id: string | null;
  /** Its index when it was set. */
  readonly index: number;
}

/** The repaired active item of `next` for the last `prev` (T24-093 repair order). */
function repair(prev: Active, prevMarks: readonly Mark[], next: readonly Mark[]): Active {
  if (next.length === 0) return { id: null, index: 0 };
  if (prev.id === null) return { id: next[0]?.id ?? null, index: 0 };
  const same = next.findIndex((m) => m.id === prev.id);
  if (same >= 0) return { id: prev.id, index: same };
  const old = prevMarks.find((m) => m.id === prev.id);
  const held = old === undefined ? null : (seedOf(old.id) ?? old.keys[0] ?? null);
  if (held !== null) {
    const i = next.findIndex((m) => m.keys.includes(held));
    if (i >= 0) return { id: next[i]?.id ?? null, index: i };
  }
  const i = Math.min(prev.index, next.length - 1);
  return { id: next[i]?.id ?? null, index: i };
}

export function GeoMarkList(p: GeoMarkListProps): JSX.Element {
  const ulRef = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => p.marks.filter((m) => m.inView), [p.marks]);
  const thresholds = useMemo(() => p.rowSet.rows.some((r) => r.state !== null), [p.rowSet]);
  const [active, setActive] = useState<Active>({ id: shown[0]?.id ?? null, index: 0 });
  /** The placeholder holds focus: it stays while marks return. */
  const [holding, setHolding] = useState(false);
  const last = useRef({ marks: shown, seq: p.seq, rows: p.rows, active });
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });

  const placeholder = shown.length === 0 || holding;
  /** Focus was in the list: still, or on a button this commit removed. */
  const within = useRef(false);
  const inside = (): boolean => {
    const ul = ulRef.current;
    if (ul === null) return false;
    if (ul.contains(document.activeElement)) return true;
    const a = document.activeElement;
    return (a === null || a === document.body) && within.current;
  };

  // Focus in and out of the list (native listeners on the list itself).
  useEffect(() => {
    const ul = ulRef.current;
    if (ul === null) return;
    const onIn = (): void => {
      within.current = true;
    };
    const onOut = (e: FocusEvent): void => {
      const to = e.relatedTarget;
      if (to instanceof Node && ul.contains(to)) return;
      const from = e.target;
      if (to instanceof Node) within.current = false;
      else {
        // No new target: focus left for nothing, or its button was removed (a repair follows).
        queueMicrotask(() => {
          if (from instanceof Node && from.isConnected && !ul.contains(document.activeElement)) {
            within.current = false;
          }
        });
      }
      setHolding(false);
      latest.current.onActive(null);
    };
    ul.addEventListener('focusin', onIn);
    ul.addEventListener('focusout', onOut);
    return () => {
      ul.removeEventListener('focusin', onIn);
      ul.removeEventListener('focusout', onOut);
    };
  }, []);

  // Repair on new marks or a new row set (in the commit, before paint).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per commit; it compares with the last marks itself
  useLayoutEffect(() => {
    const prev = last.current;
    if (prev.marks === shown && prev.seq === p.seq) return;
    const focused = inside();
    const next = holding ? prev.active : repair(prev.active, prev.marks, shown);
    const old = prev.marks.find((m) => m.id === prev.active.id);
    if (
      focused &&
      !holding &&
      old !== undefined &&
      p.seq !== prev.seq &&
      !shown.some((m) => m.id === old.id) &&
      old.keys.some((k) => !p.rows.has(k))
    ) {
      const name = geoMarkName(old, prev.rows, p.unit, p.selection, thresholds);
      p.announce(t('geo.list.gone', { name }));
    }
    last.current = { marks: shown, seq: p.seq, rows: p.rows, active: next };
    if (next.id !== prev.active.id || next.index !== prev.active.index) setActive(next);
    if (focused && !holding) {
      const ul = ulRef.current;
      const el =
        next.id === null
          ? ul?.querySelector<HTMLElement>('[data-geo-placeholder]')
          : ul?.querySelector<HTMLElement>(`[data-mark-id="${CSS.escape(next.id)}"]`);
      el?.focus();
    }
  });

  const focusAt = (i: number): void => {
    const m = shown[i];
    if (m === undefined) return;
    const a = { id: m.id, index: i };
    last.current = { ...last.current, active: a };
    setActive(a);
    setHolding(false);
    ulRef.current?.querySelector<HTMLElement>(`[data-mark-id="${CSS.escape(m.id)}"]`)?.focus();
  };

  const camera = (k: CameraKey): void => {
    latest.current.frame?.cameraKey(k);
  };

  /** The camera keys shared by the marks and the placeholder; true when handled. */
  const cameraKey = (e: KeyboardEvent): boolean => {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.shiftKey) {
      const pan: Partial<Record<string, CameraKey>> = {
        ArrowLeft: 'panLeft',
        ArrowRight: 'panRight',
        ArrowUp: 'panUp',
        ArrowDown: 'panDown',
      };
      const k = pan[e.key];
      if (k !== undefined) {
        camera(k);
        return true;
      }
    }
    if (e.key === '+' || e.key === '=') camera('in');
    else if (e.key === '-') camera('out');
    else if (e.key === '0') camera('fit');
    else return false;
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number, m: Mark): void => {
    let handled = cameraKey(e);
    if (!handled && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      handled = true;
      const n = shown.length;
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          focusAt(Math.max(0, i - 1));
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          focusAt(Math.min(n - 1, i + 1));
          break;
        case 'Home':
          focusAt(0);
          break;
        case 'End':
          focusAt(n - 1);
          break;
        case 'PageUp':
          focusAt(Math.max(0, i - PAGE));
          break;
        case 'PageDown':
          focusAt(Math.min(n - 1, i + PAGE));
          break;
        case 'Enter':
        case ' ': {
          const q = latest.current;
          const target = geoTarget(q.rowSet, q.seq, { kind: m.kind, id: m.id, keys: m.keys });
          q.onInspect(target, e.currentTarget);
          break;
        }
        default:
          handled = false;
      }
    }
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onPlaceholderKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    let handled = cameraKey(e);
    if (!handled && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      handled = true;
      switch (e.key) {
        case 'Enter':
        case ' ':
          camera('fit');
          break;
        case 'ArrowDown':
        case 'ArrowRight':
        case 'Home':
          if (shown.length > 0) focusAt(0);
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
        case 'End':
          if (shown.length > 0) focusAt(shown.length - 1);
          break;
        default:
          handled = false;
      }
    }
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const all = p.marks.length > 0 && p.marks.every((m) => m.inView);
  const setsize = p.complete && all ? shown.length : -1;
  const at = Math.max(
    0,
    shown.findIndex((m) => m.id === active.id),
  );
  return (
    <ul
      ref={ulRef}
      className={cx(styles['srOnly'])}
      aria-label={t('geo.list.label', { title: p.title })}
      data-geo-list=""
    >
      {placeholder ? (
        <li>
          <button
            type="button"
            data-geo-placeholder=""
            onFocus={() => {
              setHolding(true);
            }}
            onKeyDown={onPlaceholderKey}
          >
            {t('geo.list.none')}
          </button>
        </li>
      ) : (
        shown.map((m, i) => (
          <li key={m.id} aria-posinset={i + 1} aria-setsize={setsize}>
            <button
              type="button"
              tabIndex={i === at ? 0 : -1}
              data-mark-id={m.id}
              onFocus={() => {
                if (active.id !== m.id) {
                  const a = { id: m.id, index: i };
                  last.current = { ...last.current, active: a };
                  setActive(a);
                }
                latest.current.onActive(m.id);
              }}
              onKeyDown={(e) => {
                onKey(e, i, m);
              }}
            >
              {geoMarkName(m, p.rows, p.unit, p.selection, thresholds)}
            </button>
          </li>
        ))
      )}
    </ul>
  );
}
