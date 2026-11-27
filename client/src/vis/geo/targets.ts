/**
 * The geomap's Inspector targets (T24-092, T24 §4.13, §5.16; plan #234 Part 1 §4.4): snapshots of
 * a row set, built here only, so a refetch never changes an open one. Type-only imports of the
 * frame: the shared Inspector needs this module, not the row builder.
 */
import type { Labels } from '../../data/frames';
import { t } from '../../i18n/t';
import type { State } from '../../theme/stateEncoding';
import type { GeoRow, GeoRowSet, GroupId } from './frame';
import type { LocationResult } from './locate';

export interface GeoMemberEntry {
  readonly text: string;
  readonly labels: Labels;
  readonly keys: readonly string[];
}

export interface GeoInspectorTarget {
  readonly kind: 'marker' | 'cluster' | 'aggregate' | 'group';
  readonly id: string;
  readonly frameSeq: number;
  readonly title: string;
  /** A snapshot, in key order. */
  readonly rows: readonly GeoRow[];
  /** One entry per row (cluster, group) or member group (aggregate); null for a marker. */
  readonly members: readonly GeoMemberEntry[] | null;
  /** The row set the target was built from; `group` targets and later views read only it. */
  readonly set: GeoRowSet;
}

export type GeoTargetRef =
  | { readonly kind: 'marker' | 'cluster'; readonly id: string; readonly keys: readonly string[] }
  | { readonly kind: 'aggregate' }
  | { readonly kind: 'group'; readonly from: GeoInspectorTarget; readonly entry: number };

/** The aggregate's id (T24-092). */
export const AGGREGATE_ID = 'other:geo';

const idKey = (id: GroupId): string => JSON.stringify(id);

function byKey(a: GeoRow, b: GeoRow): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** One entry per row: its name, labels and key. */
function rowEntries(rows: readonly GeoRow[]): GeoMemberEntry[] {
  return rows.map((r) => ({ text: r.name, labels: r.labels, keys: [r.key] }));
}

/** A member group's labels: `{[L]: v}`, `{}` when the label is absent, or its series' labels. */
function memberLabels(id: GroupId, rows: readonly GeoRow[], groupBy: string | null): Labels {
  if ('present' in id) return id.present && groupBy !== null ? { [groupBy]: id.value } : {};
  return rows[0]?.labels ?? {};
}

/**
 * A target of `s` (§4.4): a marker (its row, no members), a cluster (`Cluster of n`, the keys'
 * rows, one entry per row), the aggregate (`other:geo`, `other (n)`, its rows, one entry per
 * member group with its final label) or a group of an earlier target (`group:` + its id as JSON,
 * the entry's text, that target's rows of the group, one entry per row; built from `from` only).
 */
export function geoTarget(s: GeoRowSet, frameSeq: number, ref: GeoTargetRef): GeoInspectorTarget {
  if (ref.kind === 'group') {
    const from = ref.from;
    const entry = from.members?.[ref.entry];
    const keys = new Set(entry?.keys ?? []);
    const rows = from.rows.filter((r) => keys.has(r.key));
    const first = rows[0];
    return {
      kind: 'group',
      id: `group:${first === undefined ? '' : idKey(first.groupId)}`,
      frameSeq: from.frameSeq,
      title: entry?.text ?? '',
      rows,
      members: rowEntries(rows),
      set: from.set,
    };
  }
  if (ref.kind === 'aggregate') {
    const j = s.groups.findIndex((g) => g.members !== null);
    const g = s.groups[j];
    const rows = s.rows.filter((r) => r.group === j);
    const members = (g?.members ?? []).map((id, i) => {
      const own = rows.filter((r) => idKey(r.groupId) === idKey(id));
      return {
        text: g?.memberLabels?.[i] ?? '',
        labels: memberLabels(id, own, s.groupBy),
        keys: own.map((r) => r.key),
      };
    });
    return {
      kind: 'aggregate',
      id: AGGREGATE_ID,
      frameSeq,
      title: g?.label ?? '',
      rows,
      members,
      set: s,
    };
  }
  const keys = new Set(ref.keys);
  const rows = s.rows.filter((r) => keys.has(r.key)).sort(byKey);
  if (ref.kind === 'marker') {
    return {
      kind: 'marker',
      id: ref.id,
      frameSeq,
      title: rows[0]?.name ?? '',
      rows,
      members: null,
      set: s,
    };
  }
  return {
    kind: 'cluster',
    id: ref.id,
    frameSeq,
    title: t('geo.cluster.title', { n: rows.length }),
    rows,
    members: rowEntries(rows),
    set: s,
  };
}

/** Where a row is (§5.16): the gazetteer name, else `lat, lon` to 4 places; '' when not placed. */
export function geoPlace(r: GeoRow): string {
  if (r.location.status !== 'placed') return '';
  const p = r.location.place;
  return p.name ?? t('geo.place.coords', { lat: p.lat.toFixed(4), lon: p.lon.toFixed(4) });
}

/** The prefix of a cluster's mark id; the rest is its seed key. */
export const CLUSTER_PREFIX = 'cluster:';

/** A cluster id's seed key; null for a marker id. */
export function seedOf(id: string): string | null {
  return id.startsWith(CLUSTER_PREFIX) ? id.slice(CLUSTER_PREFIX.length) : null;
}

/** rank (T24 §4.11): failing 4, degraded 3, watch 2, else 0. */
export function geoRank(s: State | null): number {
  switch (s) {
    case 'failing':
      return 4;
    case 'degraded':
      return 3;
    case 'watch':
      return 2;
    default:
      return 0;
  }
}

/** The worst threshold state of `rows` (ok and unknown included); null without thresholds. */
export function worstState(rows: readonly GeoRow[]): State | null {
  let worst: State | null = null;
  let at = -1;
  for (const r of rows) {
    if (r.state === null) continue;
    const k = r.state === 'unknown' ? -1 : geoRank(r.state) + (r.state === 'ok' ? 1 : 0);
    if (worst === null || k > at) {
      worst = r.state;
      at = k;
    }
  }
  return worst;
}

/** `rows` in seed order (T24 §4.11): (−rank, −|v|, key). */
export function seedOrdered(rows: readonly GeoRow[]): GeoRow[] {
  return [...rows].sort(
    (a, b) =>
      geoRank(b.state) - geoRank(a.state) ||
      Math.abs(b.value) - Math.abs(a.value) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/** `location_detail` (§4.14): why a row is not placed; empty when placed or without a location. */
export function locationDetail(l: LocationResult): string {
  switch (l.status) {
    case 'invalid':
      return `${l.reason} ${l.key}`;
    case 'unknownCode':
      return `${l.source} ${l.key}=${l.value}`;
    case 'providerMismatch':
      return `${l.provider}: ${l.candidates.join('; ')}`;
    case 'ambiguous':
      return `${l.reason}: ${l.candidates.join('; ')}`;
    case 'placed':
    case 'noLocation':
    case 'gazetteerUnavailable':
      return '';
  }
}

/**
 * The full member list behind `geo:` + `top.id` (T25 §4.9; plan #234 Part 3 §4.5 with Part 4
 * §4.4): every entry's text and labels, from the target's own snapshot; null for another id or a
 * marker. The host answers `geo:` ids from the open request with it.
 */
export function resolveGeoMembers(
  top: GeoInspectorTarget,
  runId: string,
): { texts: string[]; members: []; labels: Labels[] } | null {
  if (top.members === null || runId !== `geo:${top.id}`) return null;
  return {
    texts: top.members.map((m) => m.text),
    members: [],
    labels: top.members.map((m) => m.labels),
  };
}
