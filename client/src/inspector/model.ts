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

export function inspectorModel(req: InspectRequest, env: InspectorEnv): InspectorModel {
  const q = req.origin.query;
  return {
    heading: req.origin.title,
    ...body(req, env.timeZone),
    members: null,
    pivots: pivots(req, env),
    query: q === null ? null : { lang: q.lang === 'promql' ? 'PromQL' : 'LogQL', text: q.text },
    actions: actions(env),
  };
}
