/**
 * Keyboard coverage for `e2e:a11y-rooms` (plan #57 §5.3). `press(keys)` and `type(text)` are the
 * only input paths of the keyboard script. After every keystroke the harness collects every
 * interactive control in the accessibility snapshot, keyed by state (route pattern + open overlay);
 * before an operating keystroke it records the focused control as operated. The script passes only
 * when every collected control was operated and every required state was visited, so a new control
 * or overlay that no loop operates fails without editing a list.
 *
 * Snapshot scope: with an overlay open (a React Aria popover or a modal dialog) the snapshot is the
 * overlay's, because React Aria popovers leave the page behind them in the accessibility tree.
 */
import type { Locator, Page } from '@playwright/test';

export const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'link',
  'button',
  'checkbox',
  'radio',
  'switch',
  'textbox',
  'searchbox',
  'combobox',
  'spinbutton',
  'slider',
  'tab',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'option',
  'grid',
]);

/** Keys that operate the focused control. Tab, Shift+Tab, F6 and modifiers only move focus. */
const OPERATING =
  /^(?:Shift\+)?(?:Enter|Space| |ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/;

const TIME_RANGE_NAME =
  /^(?:Last \d+ (?:minutes?|hours?|days?)|\d{1,2} [A-Z][a-z]{2,3} \d{4}, \d{2}:\d{2}:\d{2} – |now[-/\w]* to )/;

export interface SnapshotEntry {
  role: string;
  name: string;
}

/** The control that duplicates a board panel (plan #64 §3.6). */
const DUPLICATE = /^(?:menuitem|button) "Duplicate\b/;

/** A key without its `#n`. */
function baseKey(k: string): string {
  return k.replace(/ #\d+$/, '');
}

/** `role "name"` keys of an ARIA snapshot; duplicates get `#2`, `#3`; grid cells count as the grid. */
export function parseSnapshot(yaml: string): string[] {
  const keys: string[] = [];
  const seen = new Map<string, number>();
  let gridIndent = -1;
  for (const raw of yaml.split('\n')) {
    const m = /^(\s*)- (.*)$/.exec(raw);
    if (m === null) continue;
    const indent = m[1]?.length ?? 0;
    if (gridIndent >= 0 && indent > gridIndent) continue;
    gridIndent = -1;
    let rest = m[2] ?? '';
    if (rest.startsWith("'")) {
      const end = rest.indexOf("':", 1) === -1 ? rest.lastIndexOf("'") : rest.indexOf("':", 1);
      rest = rest.slice(1, end).replace(/''/g, "'");
    }
    const e = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(rest);
    if (e === null) continue;
    const role = e[1] ?? '';
    if (!INTERACTIVE_ROLES.has(role)) continue;
    if (/\[disabled\]/.test(e[3] ?? '')) continue;
    let name = e[2] === undefined ? '' : (JSON.parse(`"${e[2]}"`) as string);
    if (role === 'grid') {
      gridIndent = indent;
      // The calendar grid's name carries the month; the grid is one control whatever the month.
      name = name.split(', ')[0] ?? name;
    }
    // The time range trigger is named by the current range; every range is the same control.
    if (role === 'button' && TIME_RANGE_NAME.test(name)) name = '<time range>';
    const base = `${role} "${name}"`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keys.push(n === 1 ? base : `${base} #${String(n)}`);
  }
  return keys;
}

/** The route pattern of the page (§3.4), or `not-found` / `session-error` from the page heading. */
async function routeState(page: Page): Promise<string> {
  const h1 = await page.evaluate(() => document.querySelector('h1')?.textContent ?? '');
  if (h1 === 'Pulsus Dash could not load your session') return 'session-error';
  const path = new URL(page.url()).pathname;
  const patterns: [RegExp, string][] = [
    [/^\/t\/[^/]+\/boards$/, '/t/:tenant/boards'],
    [/^\/t\/[^/]+\/board\/[^/]+$/, '/t/:tenant/board/:uid'],
    [/^\/t\/[^/]+\/explore\/metrics$/, '/t/:tenant/explore/metrics'],
    [/^\/t\/[^/]+\/explore\/logs$/, '/t/:tenant/explore/logs'],
    [/^\/t\/[^/]+\/admin$/, '/t/:tenant/admin'],
    [/^\/t\/[^/]+\/dev\/gallery$/, '/t/:tenant/dev/gallery'],
    [/^\/signed-out$/, '/signed-out'],
  ];
  for (const [re, name] of patterns) if (re.test(path)) return name;
  if (h1 === 'Page not found') return path.startsWith('/t/') ? '/t/:tenant/*' : 'not-found';
  return path;
}

const POPOVER = '[data-trigger]:not([data-trigger="TooltipTrigger"])';

/** The topmost open overlay: `dialog "<name>"`, `menu "<name>"`, `listbox "<name>"` or `none`. */
async function overlayState(
  page: Page,
): Promise<{ key: string; kind: 'none' | 'popover' | 'modal' }> {
  return page.evaluate((popover) => {
    const roots = [
      ...document.querySelectorAll(
        '[data-trigger]:not([data-trigger="TooltipTrigger"]), [role="dialog"]',
      ),
    ].filter(
      (el) =>
        el.closest('#root') === null && el.closest('[data-trigger="TooltipTrigger"]') === null,
    );
    const top = roots.at(-1);
    if (top === undefined) return { key: 'none', kind: 'none' as const };
    // The overlay's own widget: a menu inside a popover, else the dialog, else a list box.
    const el =
      top.querySelector('[role="menu"]') ??
      (top.matches('[role="dialog"]') ? top : top.querySelector('[role="dialog"]')) ??
      top.querySelector('[role="listbox"]');
    const role = el?.getAttribute('role') ?? 'dialog';
    const labelledBy = el?.getAttribute('aria-labelledby');
    const name =
      el?.getAttribute('aria-label') ??
      (labelledBy ? (document.getElementById(labelledBy)?.textContent ?? '') : '');
    return {
      key: `${role} "${name}"`,
      kind: top.matches(popover) ? ('popover' as const) : ('modal' as const),
    };
  }, POPOVER);
}

/**
 * Keys of React Aria's screen-reader-only controls inside `root`: empty buttons with
 * `tabindex="-1"` whose parent is React Aria's VisuallyHidden wrapper (the popover "Dismiss"
 * buttons, the calendar's second "Next"). They exist for a screen reader's virtual cursor; Escape
 * and the visible buttons are their keyboard equivalents. Any other control is counted.
 */
async function screenReaderOnly(root: Locator): Promise<string[]> {
  return root.evaluate((r) => {
    // React Aria's VisuallyHidden wraps the control in an element with an inline
    // `clip-path: inset(50%)` style; nothing else in the app sets inline styles (ESLint bans them).
    const visuallyHiddenByLibrary = (el: Element): boolean => {
      const parent = el.parentElement;
      return parent instanceof HTMLElement && parent.style.clipPath === 'inset(50%)';
    };
    const counts = new Map<string, number>();
    const out: string[] = [];
    for (const el of r.querySelectorAll('button[aria-label]')) {
      const base = `button "${el.getAttribute('aria-label') ?? ''}"`;
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      const empty = el.textContent.trim() === '';
      if (el.getAttribute('tabindex') === '-1' && empty && visuallyHiddenByLibrary(el)) {
        out.push(n === 1 ? base : `${base} #${String(n)}`);
      }
    }
    return out;
  });
}

export interface KeyboardHarness {
  press: (keys: string) => Promise<void>;
  type: (text: string) => Promise<void>;
  /** The state key of the current page and overlay. */
  state: () => Promise<string>;
  /** The accessible `role "name"` of the focused control. */
  focusName: () => Promise<string>;
  /** Controls on screen now that have not been operated in the current state. */
  pendingHere: () => Promise<string[]>;
  collected: () => ReadonlySet<string>;
  operated: () => ReadonlySet<string>;
  /** Route states seen so far. */
  visited: () => ReadonlySet<string>;
  uncovered: () => string[];
  unvisited: (required: readonly string[]) => string[];
}

export function keyboardHarness(page: Page): KeyboardHarness {
  const collected = new Set<string>();
  const operated = new Set<string>();
  const visited = new Set<string>();
  // Panels the traversal made with Duplicate (plan #64), by `data-panel` id: 1 for a copy of a
  // board's own panel, 2 for a copy of that copy. A first copy is collected and operated like any
  // panel; a copy of a copy is not collected, so the copies end there. A page load starts a fresh
  // board (the stub's), so it forgets them.
  const copies = new Map<string, number>();
  page.on('load', () => {
    copies.clear();
  });

  async function panelIds(): Promise<string[]> {
    return page.evaluate(() =>
      [...document.querySelectorAll('[data-panel]')].map((e) => e.getAttribute('data-panel') ?? ''),
    );
  }

  /** The panel a Duplicate acts on: the focused control's, or the one whose menu is open. */
  async function sourcePanel(): Promise<string | null> {
    return page.evaluate(() => {
      const own = document.activeElement?.closest('[data-panel]');
      const p = own ?? document.querySelector('[data-panel]:has([aria-expanded="true"])');
      return p?.getAttribute('data-panel') ?? null;
    });
  }

  /** Keys in `root` of the controls of copies of copies, with their `#n` among equals. */
  async function beyondFirstCopy(root: Locator): Promise<string[]> {
    const out: string[] = [];
    for (const [id, depth] of copies) {
      if (depth < 2) continue;
      const panel = root.locator(`[data-panel="${id}"]`);
      if ((await panel.count()) === 0) continue;
      for (const key of new Set(parseSnapshot(await panel.ariaSnapshot()).map(baseKey))) {
        const m = /^([a-z]+) "(.*)"$/.exec(key);
        if (m === null) continue;
        const same = root.getByRole(m[1] as Parameters<Page['getByRole']>[0], {
          name: m[2] ?? '',
          exact: true,
        });
        const n = await same.count();
        for (let i = 0; i < n; i++) {
          const inside = await same
            .nth(i)
            .evaluate((e, pid) => e.closest(`[data-panel="${pid}"]`) !== null, id);
          if (inside) out.push(i === 0 ? key : `${key} #${String(i + 1)}`);
        }
      }
    }
    return out;
  }

  async function scope(): Promise<{ state: string; root: Locator }> {
    const route = await routeState(page);
    visited.add(route);
    const overlay = await overlayState(page);
    const root =
      overlay.kind === 'none'
        ? page.locator('body')
        : overlay.kind === 'popover'
          ? page.locator(POPOVER).last()
          : page.locator('[role="dialog"]').last();
    return { state: `${route} + ${overlay.key}`, root };
  }

  /** Let a navigation or overlay change finish rendering before reading the page. */
  async function settle(): Promise<void> {
    await page.evaluate(
      () =>
        new Promise<void>((r) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              r();
            });
          });
        }),
    );
  }

  async function collect(): Promise<void> {
    await settle();
    const { state, root } = await scope();
    let yaml = '';
    let skip: string[] = [];
    try {
      skip = await screenReaderOnly(root);
      yaml = await root.ariaSnapshot({ timeout: 5_000 });
      skip = [...skip, ...(await screenReaderOnly(root)), ...(await beyondFirstCopy(root))];
    } catch {
      return; // the overlay closed between the reads; the next keystroke collects again
    }
    for (const k of parseSnapshot(yaml)) if (!skip.includes(k)) collected.add(`${state} › ${k}`);
  }

  /** `role "name"` (with its `#n` among equals in the current scope) of the focused control. */
  async function focused(): Promise<string | null> {
    // document.activeElement, not :focus: WebKit stops matching :focus when the window loses focus.
    const path = await page.evaluate(() => {
      let el = document.activeElement;
      if (el === null || el === document.body || el === document.documentElement) return null;
      // React Aria's combobox keeps focus on the input and marks the option it points at.
      const id = el.getAttribute('aria-activedescendant');
      if (id) el = document.getElementById(id) ?? el;
      el = el.closest('[role="grid"]') ?? el;
      const parts: string[] = [];
      for (
        let e: Element | null = el;
        e !== null && e !== document.documentElement;
        e = e.parentElement
      ) {
        const parent: Element | null = e.parentElement;
        const index = parent === null ? 1 : [...parent.children].indexOf(e) + 1;
        parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${String(index)})`);
      }
      return `html > ${parts.join(' > ')}`;
    });
    if (path === null) return null;
    const target = page.locator(path);
    if ((await target.count()) === 0) return null;
    const first = parseSnapshot((await target.ariaSnapshot()).split('\n')[0] ?? '')[0];
    if (first === undefined) return null;
    const m = /^([a-z]+) "(.*)"$/.exec(first);
    if (m === null) return null;
    const role = m[1] ?? '';
    const { root } = await scope();
    const yaml = await root.ariaSnapshot();
    const keys = parseSnapshot(yaml).filter((k) => k === first || k.startsWith(`${first} #`));
    if (keys.length <= 1) return first;
    const same = root.getByRole(role as Parameters<Page['getByRole']>[0], {
      name: m[2] ?? '',
      exact: true,
    });
    const n = await same.count();
    for (let i = 0; i < n; i++) {
      if (
        await same.nth(i).evaluate((e) => {
          // Into open shadow roots: the editor's textbox is focused inside its host (plan #63 R2).
          let a = document.activeElement;
          while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
          return a !== null && (e === a || e.contains(a));
        })
      ) {
        return i === 0 ? first : `${first} #${String(i + 1)}`;
      }
    }
    return first;
  }

  async function record(): Promise<string | null> {
    const f = await focused();
    if (f === null) return null;
    const { state } = await scope();
    operated.add(`${state} › ${f}`);
    return f;
  }

  return {
    async press(keys) {
      const overlayOpen = (await overlayState(page)).key !== 'none';
      const f = OPERATING.test(keys) || (keys === 'Escape' && overlayOpen) ? await record() : null;
      const dup = f !== null && OPERATING.test(keys) && DUPLICATE.test(f);
      const before = dup ? await panelIds() : [];
      const source = dup ? await sourcePanel() : null;
      await page.keyboard.press(keys);
      if (dup) {
        await settle();
        const depth = (source === null ? 0 : (copies.get(source) ?? 0)) + 1;
        for (const id of await panelIds()) if (!before.includes(id)) copies.set(id, depth);
      }
      await collect();
    },
    async type(text) {
      await record();
      await page.keyboard.type(text);
      await collect();
    },
    async state() {
      return (await scope()).state;
    },
    async focusName() {
      return (await focused()) ?? 'none';
    },
    async pendingHere() {
      await settle();
      const { state, root } = await scope();
      const skip = [...(await screenReaderOnly(root)), ...(await beyondFirstCopy(root))];
      const keys = parseSnapshot(await root.ariaSnapshot());
      return keys.filter((k) => !skip.includes(k) && !operated.has(`${state} › ${k}`));
    },
    collected: () => collected,
    operated: () => operated,
    visited: () => visited,
    uncovered: () => [...collected].filter((k) => !operated.has(k)).sort(),
    unvisited: (required) => required.filter((r) => !visited.has(r)),
  };
}
