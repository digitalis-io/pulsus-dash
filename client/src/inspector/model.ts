/**
 * `inspectorModel` (T25-003, T25-004, T25-009, T25-010, T25-015): one pure function renders every
 * target into the Inspector's fixed sections — header, value, details, labels, members, pivots,
 * query and actions — with the texts of T25 and mockup 41. Times are in the page's zone; a log time
 * is also its exact nanoseconds.
 */
import { exploreHrefFor } from '../boards/exploreLink';
import type { Unit, VisKind } from '../engine/api';
import {
  formatClockMs,
  formatLogTime,
  formatTime,
  formatValue,
  formatZoneShort,
} from '../i18n/format';
import { t } from '../i18n/t';
import { LEVEL_NAME } from '../logs/levels';
import { contextSearchString } from '../state/contextSearch';
import { writeLogsParams } from '../state/logsParams';
import { printTimeExpr } from '../state/timeExpr';
import { StateEncoding, type State } from '../theme/stateEncoding';
import { geoModel } from './geoModel';
import { logsSelector, pivotWindow } from './pivots';
import type {
  InspectorAction,
  InspectorEnv,
  InspectorFact,
  InspectorModel,
  InspectorTarget,
  InspectRequest,
  Labels,
  Pivot,
} from './types';

const NONE: Unit = { kind: 'none' };

/** The value in its unit; NaN reads "no value" (T25-004). */
const shown = (v: number, unit: Unit): string =>
  Number.isNaN(v) ? t('inspector.noValue') : formatValue(v, unit);

const byKey = (l: Labels): (readonly [string, string])[] =>
  Object.keys(l)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => [k, l[k] ?? ''] as const);

/** `2026-11-19 13:41:20.000 UTC`. */
const stamp = (ms: number, tz: string): string =>
  `${formatLogTime(ms, tz)} ${formatZoneShort(tz, ms)}`;

/** A crossed threshold: only these show the state's colour and glyph on the value (T25 §4.4). */
const CROSSED: readonly State[] = ['watch', 'degraded', 'failing'];

type Body = Omit<InspectorModel, 'heading' | 'members' | 'pivots' | 'query' | 'actions'>;

function body(req: InspectRequest, tz: string): Body {
  const { origin, target } = req;
  const unit = origin.unit ?? NONE;
  const title = origin.title;
  const announce = (value: string, at: number | null): string =>
    at === null
      ? t('inspector.announceNoTime', { title, value })
      : t('inspector.announce', { title, value, time: formatTime(at, tz) });
  const base = { primaryKind: 'value' as const, primaryState: null, extraLabels: [] };
  switch (target.type) {
    case 'point': {
      const primary = shown(target.value, unit);
      return {
        ...base,
        subheading: formatClockMs(target.tMs, tz),
        primary,
        facts: [
          { label: t('inspector.fact.raw'), value: String(target.value) },
          { label: t('inspector.fact.time'), value: stamp(target.tMs, tz) },
        ],
        labels: byKey(target.labels),
        announce: announce(primary, target.tMs),
        copyValue: String(target.value),
      };
    }
    case 'bucket': {
      const primary = shown(target.count, target.countUnit);
      const range =
        target.upper === Infinity
          ? t('inspector.range.gt', { lo: formatValue(target.lower ?? NaN, unit) })
          : target.lower === null
            ? t('inspector.range.le', { hi: formatValue(target.upper, unit) })
            : t('inspector.range.between', {
                lo: formatValue(target.lower, unit),
                hi: formatValue(target.upper, unit),
              });
      return {
        ...base,
        subheading: formatClockMs(target.tMs, tz),
        primary,
        facts: [
          { label: t('inspector.fact.range'), value: range },
          { label: t('inspector.fact.rawCount'), value: String(target.count) },
          {
            label: t('inspector.fact.interval'),
            value: `${formatClockMs(target.tMs, tz)} – ${formatClockMs(target.toMs, tz)}`,
          },
        ],
        labels: [],
        announce: announce(primary, target.tMs),
        copyValue: String(target.count),
      };
    }
    case 'value': {
      const primary = shown(target.value, unit);
      const facts: InspectorFact[] = [
        { label: t('inspector.fact.raw'), value: String(target.value) },
      ];
      if (target.tMs !== null) {
        facts.push({ label: t('inspector.fact.time'), value: stamp(target.tMs, tz) });
      }
      if (target.state !== null) {
        facts.push({
          label: t('inspector.fact.state'),
          value: t(StateEncoding[target.state].label),
        });
      }
      return {
        ...base,
        subheading: target.tMs === null ? '' : formatClockMs(target.tMs, tz),
        primary,
        primaryState: target.state !== null && CROSSED.includes(target.state) ? target.state : null,
        facts,
        labels: byKey(target.labels),
        announce: announce(primary, target.tMs),
        copyValue: String(target.value),
      };
    }
    case 'mark': {
      // A bar is reduced over the window: no instant, its value in the target's unit (T25-002).
      const { mark, unit: u, window: w } = target.target;
      const primary = Number.isFinite(mark.value)
        ? formatValue(mark.value, u)
        : t('chart.bar.noData');
      const facts: InspectorFact[] = [
        { label: t('inspector.fact.raw'), value: String(mark.value) },
      ];
      if (mark.baseline !== null && Number.isFinite(mark.baseline)) {
        facts.push({ label: t('inspector.fact.baseline'), value: formatValue(mark.baseline, u) });
      }
      if (mark.state !== null) {
        facts.push({ label: t('inspector.fact.state'), value: t(StateEncoding[mark.state].label) });
      }
      facts.push({ label: t('inspector.fact.seriesKey'), value: mark.key });
      facts.push({
        label: t('inspector.fact.reducedOver'),
        value: `${formatClockMs(w.fromMs, tz)} – ${formatClockMs(w.toMs, tz)}`,
      });
      return {
        ...base,
        subheading: '',
        primary,
        primaryState: mark.state !== null && CROSSED.includes(mark.state) ? mark.state : null,
        facts,
        labels: byKey(mark.labels),
        announce: announce(primary, null),
        copyValue: String(mark.value),
      };
    }
    case 'geo': {
      // `inspectorModel` renders geo targets through `geoModel` (T24 §4.13).
      const g = geoModel(target.target, unit, origin.panelId);
      return {
        subheading: g.subheading,
        primary: g.primary,
        primaryKind: g.primaryKind,
        primaryState: g.primaryState,
        facts: g.facts,
        labels: g.labels,
        extraLabels: g.extraLabels,
        announce: g.announce,
        copyValue: g.copyValue,
      };
    }
    case 'logLine': {
      const ms = Number(target.tsNs / 1_000_000n);
      const level = t(LEVEL_NAME[target.level]);
      const extra: { title: 'Metadata' | 'Parsed'; labels: (readonly [string, string])[] }[] = [];
      if (target.metadata !== null) {
        extra.push({ title: 'Metadata', labels: byKey(target.metadata) });
      }
      if (target.parsed !== null) extra.push({ title: 'Parsed', labels: byKey(target.parsed) });
      return {
        subheading: formatClockMs(ms, tz),
        primary: target.line,
        primaryKind: 'line',
        primaryState: null,
        facts: [
          { label: t('inspector.fact.level'), value: level },
          {
            label: t('inspector.fact.time'),
            value: t('inspector.timeNs', { ns: target.tsNs.toString() }),
          },
          { label: t('inspector.fact.localTime'), value: stamp(ms, tz) },
        ],
        labels: byKey(target.labels),
        extraLabels: extra,
        announce: t('inspector.announceLog', {
          title,
          level: level.toLowerCase(),
          time: formatTime(ms, tz),
        }),
        copyValue: target.line,
      };
    }
  }
}

/** The vis Explore opens the target's query with. */
function visOf(target: InspectorTarget): VisKind | 'auto' {
  switch (target.type) {
    case 'point':
      return target.vis;
    case 'bucket':
      return 'heatmap';
    case 'value':
      return 'stat';
    case 'logLine':
      return 'auto';
    case 'mark':
      return 'barchart';
    case 'geo':
      return 'auto';
  }
}

const absolute = (ms: number): string => printTimeExpr({ kind: 'absolute', ms });

/** "Carried: time[, filters] · Not carried yet: baseline" (plan #192 §3, §10 reading 1). */
const carried = (dropsFilters: boolean): string =>
  t('inspector.context.carried', {
    list: dropsFilters ? t('inspector.context.time') : t('inspector.context.timeFilters'),
  });

function disabled(id: Pivot['id'], label: string, reason: string): Pivot {
  return { id, label, href: null, reason, notCarried: [], context: [] };
}

function pivots(req: InspectRequest, env: InspectorEnv): Pivot[] {
  const { origin, target } = req;
  const { tenant, ctx } = env;
  const keys = [...new Set(ctx.filters.map((f) => f.key))];
  const out: Pivot[] = [];
  // Explore applies to a board only; it carries no `f=` until I3 (T25-010).
  if (origin.surface === 'board') {
    const label = t('inspector.pivot.explore');
    const q = origin.query;
    out.push(
      q === null
        ? disabled('explore', label, t('inspector.reason.explore'))
        : {
            id: 'explore',
            label,
            href: exploreHrefFor(tenant, q.lang, visOf(target), ctx.search, q.text),
            reason: null,
            notCarried: keys,
            context:
              keys.length === 0
                ? [carried(false)]
                : [carried(true), t('inspector.context.explore', { keys: keys.join(', ') })],
          },
    );
  }
  const logsLabel = t('inspector.pivot.logs');
  const sel = logsSelector(target, ctx.filters);
  if (sel.q === null) {
    out.push(disabled('logs', logsLabel, t('inspector.reason.logs')));
  } else {
    const w = pivotWindow(target, origin.window);
    const search = {
      ...ctx.search,
      from: absolute(w.fromMs),
      to: absolute(w.toMs),
      refresh: 'off' as const,
    };
    const rest = writeLogsParams([], { q: sel.q, dir: 'backward', wrap: false });
    const context = [carried(sel.notCarried.length > 0)];
    if (sel.notCarried.length > 0) {
      context.push(t('inspector.context.logs', { keys: sel.notCarried.join(', ') }));
    }
    for (const c of sel.conflicts) {
      const at = c.indexOf('=');
      context.push(
        t('inspector.context.conflict', { key: c.slice(0, at), value: c.slice(at + 1) }),
      );
    }
    out.push({
      id: 'logs',
      label: logsLabel,
      href: `/t/${tenant}/explore/logs${contextSearchString(search, rest)}`,
      reason: null,
      notCarried: sel.notCarried,
      context,
    });
  }
  out.push(disabled('traces', t('inspector.pivot.traces'), t('inspector.reason.traces')));
  out.push(disabled('profiles', t('inspector.pivot.profiles'), t('inspector.reason.profiles')));
  out.push(disabled('entity', t('inspector.pivot.entity'), t('inspector.reason.entity')));
  out.push(
    disabled('labelFilter', t('inspector.pivot.labelFilter'), t('inspector.reason.labelFilter')),
  );
  return out;
}

function actions(env: InspectorEnv): InspectorAction[] {
  const c = env.capabilities;
  return [
    {
      id: 'pin',
      label: t('inspector.action.pin'),
      reason: c.investigations ? null : t('inspector.actionReason.pin'),
    },
    {
      id: 'alert',
      label: t('inspector.action.alert'),
      reason: c.alerting ? null : t('inspector.actionReason.alert'),
    },
    {
      id: 'ai',
      label: t('inspector.action.ai'),
      reason: c.ai ? null : t('inspector.actionReason.ai'),
    },
  ];
}

/**
 * The sheet's model of `req` (T25 §5). `depth` is the view's place in the navigation stack (T25
 * §4.8): a geo view at depth d > 0 announces `Level ‹d + 1›: ` first (T25 §4.9); nothing else
 * depends on it.
 */
export function inspectorModel(req: InspectRequest, env: InspectorEnv, depth = 0): InspectorModel {
  // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator -- a stub until Part 4 lands
  void depth;
  const q = req.origin.query;
  const query =
    q === null ? null : ({ lang: q.lang === 'promql' ? 'PromQL' : 'LogQL', text: q.text } as const);
  const target = req.target;
  if (target.type === 'geo') {
    // T24 §4.13: a marker gets the T25 `mark` pivots over the origin window; the others none.
    const g = target.target;
    return {
      ...geoModel(g, req.origin.unit ?? NONE, req.origin.panelId, depth),
      pivots: g.kind === 'marker' ? pivots(req, env) : [],
      query,
      actions: actions(env),
    };
  }
  return {
    heading: req.origin.title,
    ...body(req, env.timeZone),
    members: null,
    pivots: pivots(req, env),
    query,
    actions: actions(env),
  };
}
