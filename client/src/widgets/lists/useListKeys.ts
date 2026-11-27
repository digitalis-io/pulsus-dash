/**
 * A list widget's keys and focus repair (plan #216 Part 2a §3.2, §4.4; T24-025), shared by the
 * list widgets: one roving tab stop over the shown rows, ↑/↓, Home/End and PageUp/PageDown (±10)
 * on the `<ul>`, the active row kept by key, and focus repair that moves focus only when it was in
 * the list. Whether focus is in the list is tracked by a document `focusin` listener, so a row
 * removed while focused (which fires no event) still counts as inside; a focused row becomes the
 * active row.
 *
 * - `listKey` changes (a new query key): the first row is active; focus is not moved.
 * - Same key, new rows: `repairActive`; a gone row calls `onGone` with its name.
 * - Same key, no rows (empty or error): `fallback()` takes focus once it exists.
 * - `focusRow(i)`: focuses row `i` after the commit that shows it (Show more).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { repairActive } from './focus';

const PAGE_ROWS = 10;

export interface ListKeys {
  activeKey: string | null;
  readonly rowProps: (
    key: string,
    index: number,
  ) => { tabIndex: 0 | -1; ref: (el: HTMLAnchorElement | null) => void };
  /** ↑ ↓ Home End PageUp PageDown (±10) on the list. */
  readonly onListKeyDown: (e: KeyboardEvent<HTMLUListElement>) => void;
  /** Focuses row `index` after the commit that shows it (Show more). */
  readonly focusRow: (index: number) => void;
}

export function useListKeys(i: {
  keys: readonly string[];
  listKey: string;
  names: ReadonlyMap<string, string>;
  fallback: () => HTMLElement | null;
  onGone: (name: string) => void;
}): ListKeys {
  const { keys, listKey } = i;
  const [active, setActive] = useState<{ listKey: string; key: string | null }>({
    listKey,
    key: keys[0] ?? null,
  });
  const els = useRef(new Map<string, HTMLAnchorElement>());
  const focusIn = useRef(false);
  const pendingFocus = useRef<number | null>(null);
  const wantFallback = useRef(false);
  const latest = useRef(i);
  useLayoutEffect(() => {
    latest.current = i;
  });

  // The active key belongs to its list key; another key's is none.
  const activeKey =
    active.listKey === listKey && active.key !== null && keys.includes(active.key)
      ? active.key
      : (keys[0] ?? null);

  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      const t = e.target;
      const hit = [...els.current.entries()].find(([, el]) => el === t);
      focusIn.current = hit !== undefined;
      // The roving tab stop follows focus (a pointer or a script focusing a row).
      if (hit !== undefined) setActive({ listKey: latest.current.listKey, key: hit[0] });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  // Repair after the rows changed: by key within a list key, the first row on a new key.
  const prev = useRef<{
    listKey: string;
    keys: readonly string[];
    key: string | null;
    names: ReadonlyMap<string, string>;
  }>({
    listKey,
    keys,
    key: activeKey,
    names: i.names,
  });
  const joined = keys.join('\u0000');
  useLayoutEffect(() => {
    const p = prev.current;
    const now = latest.current.keys;
    if (p.listKey !== listKey) {
      prev.current = { listKey, keys: now, key: now[0] ?? null, names: latest.current.names };
      setActive({ listKey, key: now[0] ?? null });
      return;
    }
    if (p.keys.join('\u0000') === joined) return;
    const prevIndex = p.key === null ? -1 : p.keys.indexOf(p.key);
    const r = repairActive(p.key, prevIndex, now);
    if (r.gone && p.key !== null) {
      const name = p.names.get(p.key);
      if (name !== undefined) latest.current.onGone(name);
    }
    prev.current = { listKey, keys: now, key: r.key, names: latest.current.names };
    setActive({ listKey, key: r.key });
    if (!focusIn.current) return;
    if (r.key === null) wantFallback.current = true;
    else if (pendingFocus.current === null) els.current.get(r.key)?.focus();
  }, [listKey, joined]);

  // Keep the repair's view of the active key and the names current.
  useLayoutEffect(() => {
    prev.current = { ...prev.current, key: activeKey, names: latest.current.names };
  });

  // Show more's focus, and the empty text or Retry once it is there. After every commit (the target
  // appears in a later one); it sets state only once per pending focus.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after every commit on purpose
  useLayoutEffect(() => {
    const at = pendingFocus.current;
    if (at !== null) {
      const key = latest.current.keys[at];
      const el = key === undefined ? undefined : els.current.get(key);
      if (key !== undefined && el !== undefined) {
        pendingFocus.current = null;
        setActive({ listKey, key });
        el.focus();
      }
    }
    if (wantFallback.current) {
      const el = latest.current.fallback();
      if (el !== null) {
        wantFallback.current = false;
        el.focus();
      }
    }
  });

  const rowProps = useCallback(
    (key: string) => ({
      tabIndex: key === activeKey ? (0 as const) : (-1 as const),
      ref: (el: HTMLAnchorElement | null) => {
        if (el === null) els.current.delete(key);
        else els.current.set(key, el);
      },
    }),
    [activeKey],
  );

  const onListKeyDown = useCallback(
    (e: KeyboardEvent<HTMLUListElement>) => {
      if (e.ctrlKey || e.metaKey || e.altKey || keys.length === 0) return;
      const at = activeKey === null ? 0 : Math.max(0, keys.indexOf(activeKey));
      let next: number;
      switch (e.key) {
        case 'ArrowDown':
          next = at + 1;
          break;
        case 'ArrowUp':
          next = at - 1;
          break;
        case 'PageDown':
          next = at + PAGE_ROWS;
          break;
        case 'PageUp':
          next = at - PAGE_ROWS;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = keys.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      const key = keys[Math.min(keys.length - 1, Math.max(0, next))];
      if (key === undefined) return;
      setActive({ listKey, key });
      els.current.get(key)?.focus();
    },
    [keys, activeKey, listKey],
  );

  const focusRow = useCallback((index: number) => {
    pendingFocus.current = index;
  }, []);

  return { activeKey, rowProps, onListKeyDown, focusRow };
}
