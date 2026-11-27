/**
 * The geo Inspector model (T24 §4.13, T25 §4.9; plan #234 Part 3 §4.5): the header, value,
 * details, labels and members of the four kinds of geo target — a marker (one row), a cluster (its
 * rows), the aggregate `other (n)` (its member groups) and a group (its rows) — and the announce
 * text. Members show entries 0–7 with their label maps; past eight, `resolve` names the run id
 * `geo:` + the target's id, which the host answers from the open request (`resolveGeoMembers`).
 * Pure; imports only the targets module of the geo code, so it stays in the board route.
 */
import { formatValue, type Unit } from '../i18n/format';
import { t } from '../i18n/t';
import { StateEncoding, type State } from '../theme/stateEncoding';
import type { DrawStatus, GeoRow, GeoRowSet, ValueStatus } from '../vis/geo/frame';
import {
  geoPlace,
  locationDetail,
  seedOf,
  worstState,
  type GeoInspectorTarget,
} from '../vis/geo/targets';
import { MEMBERS_SHOWN, type MemberSection } from './members';
import type { InspectorFact, InspectorModel, Labels } from './types';

const DRAW: Readonly<Record<DrawStatus, Parameters<typeof t>[0]>> = {
  shown: 'geo.draw.shown',
  notPlaced: 'geo.draw.notPlaced',
  outsideMap: 'geo.draw.outsideMap',
  excluded: 'geo.draw.excluded',
  capped: 'geo.draw.capped',
};

const VALUE: Readonly<Record<ValueStatus, Parameters<typeof t>[0]>> = {
  ok: 'geo.value.ok',
  noValue: 'geo.value.noValue',
  infinite: 'geo.value.infinite',
  outOfRange: 'geo.value.outOfRange',
};

/** A draw status as the table note and the Inspector read it ("Not placed"). */
export function drawStatusText(d: DrawStatus): string {
  return t(DRAW[d]);
}

/** A value status: OK, No value, Infinite, Out of range. */
export function valueStatusText(v: ValueStatus): string {
  return t(VALUE[v]);
}

/** A crossed threshold: only these show the state's colour and glyph on the value (T25 §4.4). */
const CROSSED: readonly State[] = ['watch', 'degraded', 'failing'];

const byKey = (l: Labels): (readonly [string, string])[] =>
  Object.keys(l)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => [k, l[k] ?? ''] as const);

/** A row's own group label (T24-090): its group's, or its own among the aggregate's members. */
export function ownGroupLabel(s: GeoRowSet, r: GeoRow): string {
  const g = s.groups[r.group];
  if (g === undefined) return '';
  if (g.members === null) return g.label;
  const id = JSON.stringify(r.groupId);
  const i = g.members.findIndex((m) => JSON.stringify(m) === id);
  const own = g.memberLabels?.[i] ?? '';
  return t('geo.inspector.inOther', { label: own, other: g.label });
}

/** `min – max` of the rows with a usable value, in `unit`; '' when none has one. */
function valuesText(rows: readonly GeoRow[], unit: Unit): string {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (r.valueStatus !== 'ok') continue;
    if (r.value < min) min = r.value;
    if (r.value > max) max = r.value;
  }
  return min > max ? '' : `${formatValue(min, unit)} – ${formatValue(max, unit)}`;
}

function markerFacts(r: GeoRow, s: GeoRowSet): InspectorFact[] {
  const facts: InspectorFact[] = [
    { label: t('geo.fact.valueStatus'), value: valueStatusText(r.valueStatus) },
  ];
  const l = r.location;
  if (l.status === 'placed') {
    const p = l.place;
    facts.push({
      label: t('geo.fact.location'),
      value: `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
    });
    const code =
      p.source === 'coords'
        ? `${String(p.lat)}, ${String(p.lon)}`
        : `${p.code ?? ''}${p.provider === null ? '' : ` (${p.provider})`}`;
    facts.push({ label: t('geo.fact.source'), value: `${p.key} ${code}` });
  } else {
    facts.push({ label: t('geo.fact.location'), value: l.status });
    const detail = locationDetail(l);
    if (detail !== '') {
      facts.push({ label: t('geo.fact.locationDetail'), value: `${l.status}: ${detail}` });
    }
  }
  facts.push({ label: t('geo.fact.group'), value: ownGroupLabel(s, r) });
  facts.push({ label: t('geo.fact.draw'), value: drawStatusText(r.draw) });
  return facts;
}

/** Worst state and the values (cluster, group). */
function spreadFacts(rows: readonly GeoRow[], unit: Unit): InspectorFact[] {
  const facts: InspectorFact[] = [];
  const worst = worstState(rows);
  if (worst !== null)
    facts.push({ label: t('geo.fact.worst'), value: t(StateEncoding[worst].label) });
  const values = valuesText(rows, unit);
  if (values !== '') facts.push({ label: t('geo.fact.values'), value: values });
  return facts;
}

/** The members section (T25 §4.9): entries 0–7 with parallel labels; `resolve` past eight. */
export function geoMembers(g: GeoInspectorTarget, panelId: string | null): MemberSection | null {
  const m = g.members;
  if (m === null) return null;
  const shown = m.slice(0, MEMBERS_SHOWN);
  return {
    texts: { shown: shown.map((e) => e.text), count: m.length, labels: shown.map((e) => e.labels) },
    runs: null,
    resolve:
      m.length > MEMBERS_SHOWN && panelId !== null ? { panelId, runId: `geo:${g.id}` } : null,
    next: null,
  };
}

/** A cluster's seed place: `near ‹place›`. */
function nearText(g: GeoInspectorTarget): string {
  const seed = seedOf(g.id);
  const r = g.rows.find((x) => x.key === seed) ?? g.rows[0];
  return t('geo.inspector.near', { place: r === undefined ? '' : geoPlace(r) });
}

type GeoParts = Omit<InspectorModel, 'pivots' | 'query' | 'actions'>;

/**
 * The model of a geo target (T24 §4.13), without the pivots, query and actions (`inspectorModel`
 * adds them: the T25 `mark` pivots for a marker, none for the others).
 */
export function geoModel(g: GeoInspectorTarget, unit: Unit, panelId: string | null): GeoParts {
  const base = {
    heading: g.title,
    primaryKind: 'value' as const,
    extraLabels: [],
    members: geoMembers(g, panelId),
  };
  const announce = (parts: readonly string[]): string =>
    t('geo.inspector.announce', { text: parts.join(', ') });
  const worst = worstState(g.rows);
  const worstPart = worst === null ? [] : [t('geo.list.worst', { state: worst })];
  switch (g.kind) {
    case 'marker': {
      const r = g.rows[0];
      if (r === undefined) {
        return {
          ...base,
          subheading: '',
          primary: '',
          primaryState: null,
          facts: [],
          labels: [],
          announce: '',
          copyValue: '',
        };
      }
      const value = Number.isNaN(r.value) ? t('inspector.noValue') : formatValue(r.value, unit);
      const place = geoPlace(r);
      return {
        ...base,
        subheading: place === '' ? r.location.status : place,
        primary: value,
        primaryState: r.state !== null && CROSSED.includes(r.state) ? r.state : null,
        facts: markerFacts(r, g.set),
        labels: byKey(r.labels),
        announce: announce([r.name, value, ...(r.state === null ? [] : [r.state])]),
        copyValue: String(r.value),
      };
    }
    case 'cluster': {
      const near = nearText(g);
      const values = valuesText(g.rows, unit);
      return {
        ...base,
        subheading: near,
        primary: values,
        primaryState: worst !== null && CROSSED.includes(worst) ? worst : null,
        facts: spreadFacts(g.rows, unit),
        labels: [],
        announce: announce([g.title, near, ...worstPart]),
        copyValue: values,
      };
    }
    case 'aggregate': {
      const sub = t('geo.inspector.groups', { n: g.members?.length ?? 0, m: g.rows.length });
      const values = valuesText(g.rows, unit);
      return {
        ...base,
        subheading: sub,
        primary: values,
        primaryState: null,
        facts: [],
        labels: [],
        announce: announce([g.title, sub]),
        copyValue: values,
      };
    }
    case 'group': {
      const sub = t('geo.inspector.series', { m: g.rows.length });
      const values = valuesText(g.rows, unit);
      return {
        ...base,
        subheading: sub,
        primary: values,
        primaryState: worst !== null && CROSSED.includes(worst) ? worst : null,
        facts: spreadFacts(g.rows, unit),
        labels: [],
        announce: announce([g.title, sub, ...worstPart]),
        copyValue: values,
      };
    }
  }
}
