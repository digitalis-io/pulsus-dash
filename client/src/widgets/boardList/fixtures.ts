/**
 * The board list test fixtures (T24 §10.1; plan #216 Part 1 §5): B, the 12 starred refs in server
 * order; S, org A's boards for search, with `findS` answering as the BFF; and the wire bodies of a
 * new and an old server (`wireOf`, `oldServer`). Used by the tests only.
 */
import type { BoardListItem, BoardPage, BoardRef, RefPage } from '../../api/types';

/** The time the fixtures are read at: 2026-11-26T12:00:00Z. */
export const NOW_MS = Date.parse('2026-11-26T12:00:00Z');

const B_REFS: readonly BoardRef[] = [
  { uid: 'ck-1', title: 'Checkout' },
  { uid: 'ck-2', title: 'Checkout' },
  { uid: 'edge', title: 'Edge' },
  { uid: 'gateway', title: 'Gateway' },
  { uid: 'inventory', title: 'Inventory' },
  { uid: 'noc', title: 'NOC overview' },
  { uid: 'orders', title: 'Orders' },
  { uid: 'pay', title: 'Payments' },
  { uid: 'psp', title: 'PSP API' },
  { uid: 'search', title: 'Search' },
  { uid: 'shipping', title: 'Shipping' },
  { uid: 'web', title: 'Web' },
];

/** Fixture B: 12 starred refs in server order, from a new server. */
export const B: RefPage = Object.freeze({ items: B_REFS, truncated: false, applied: {} });

/** B's uids, in order. */
export const B_UIDS: readonly string[] = B_REFS.map((r) => r.uid);

function item(uid: string, title: string, updatedAtMs: number, tags: string[]): BoardListItem {
  return {
    uid,
    title,
    version: 1,
    updatedAt: new Date(updatedAtMs).toISOString().replace('.000Z', 'Z'),
    updatedBy: 'Ada Admin',
    tags,
  };
}

const NAMED: readonly [string, string, string[]][] = [
  ['s-1', 'Checkout overview', ['team:payments']],
  ['s-2', 'CHECKOUT latency', []],
  ['s-3', 'Zürich edge', []],
  ['s-4', 'ZÜRICH core', []],
  ['s-5', 'payments', ['payments']],
  ['s-6', 'Ledger', ['finance', 'team:payments']],
];

/**
 * Fixture S, org A, most recently updated first: the six named boards (s-1 at 12:00, then one
 * minute older each), then bulk-0001 … bulk-1002, older still, one second apart.
 */
export const S: readonly BoardListItem[] = [
  ...NAMED.map(([uid, title, tags], i) => item(uid, title, NOW_MS - i * 60_000, tags)),
  ...Array.from({ length: 1002 }, (_, i) => {
    const uid = `bulk-${String(i + 1).padStart(4, '0')}`;
    return item(uid, uid, NOW_MS - 3_600_000 - i * 1000, []);
  }),
];

/** ASCII-only lower case (the BFF's folding). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * S as `GET /boards` answers it: `q` matches when the title contains it or it equals a tag (both
 * ASCII case folded), `tag` when it equals a tag, both must hold; the 1 000 newest, `truncated` when more
 * matched, `applied` the filter, `tagsStale` 0.
 */
export function findS(f: { readonly q?: string; readonly tag?: string }): BoardPage {
  const q = f.q === undefined ? undefined : asciiLower(f.q);
  const matching = S.filter(
    (b) =>
      (q === undefined || asciiLower(b.title).includes(q) || (b.tags ?? []).includes(q)) &&
      (f.tag === undefined || (b.tags ?? []).includes(f.tag)),
  );
  return {
    items: matching.slice(0, 1000),
    truncated: matching.length > 1000,
    applied: { ...f },
    tagsStale: 0,
  };
}

function isBoardPage(p: BoardPage | RefPage): p is BoardPage {
  return 'tagsStale' in p;
}

/** The wire body of a page, as a new server sends it. */
export function wireOf(p: BoardPage | RefPage): Record<string, unknown> {
  if (!isBoardPage(p)) {
    return {
      items: p.items.map((r) => ({ uid: r.uid, title: r.title })),
      applied: {},
      truncated: p.truncated,
    };
  }
  return {
    items: p.items.map((b) => ({
      uid: b.uid,
      title: b.title,
      version: b.version,
      updated_at: b.updatedAt,
      updated_by: { kind: 'local', name: b.updatedBy },
      tags: b.tags,
    })),
    truncated: p.truncated,
    applied: p.applied ?? {},
    tagsStale: p.tagsStale,
  };
}

/** The wire body of a page from an old server: no `applied`, no `tagsStale`, no item `tags`. */
export function oldServer(p: BoardPage | RefPage): Record<string, unknown> {
  const w = wireOf(p);
  const without = (o: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const items = (w['items'] as Record<string, unknown>[]).map((i) => without(i, ['tags']));
  return { ...without(w, ['applied', 'tagsStale']), items };
}
