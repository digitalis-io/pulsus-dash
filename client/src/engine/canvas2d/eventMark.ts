/**
 * The event mark of line, bars and heatmap (plan #64 Part C §4.2, ADR-0023), called by `draw.ts`:
 * a solid 1 px line per event in view through the frame's time transform, over the series and the
 * thresholds, and labels in a band above the plot. Labels are placed left to right, each at its
 * line or right-aligned against the next; one that does not fit is truncated, then gathered with
 * its neighbours into a `+N` chip. No event in view is ever dropped: each is in exactly one label
 * box, which the summary reports for the DOM's focusable tooltips. Colour `text-muted` only
 * (T02-004, `ThemeColours.event`); text through `fillText` only (T02-019).
 */
import { border, size, space } from '../../styles/tokens';
import { EventGlyph } from '../../theme/glyphs';
import type { EventLabelBox, EventMarker, PlotRect, TimeWindow, VisKind } from '../api';
import type { Ctx2D } from './ctx';
import type { LayerInput } from './draw';
import { AXIS_FONT, EVENT_BAND, LABEL_HEIGHT } from './layout';
import { fitText } from './text';

/**
 * The label band of a frame: present once `setEvents` held one event, in view or not (§4.2 step 1);
 * none for stat and the geomap (its `setEvents` is a no-op, ADR-0027).
 */
export function eventBandOf(kind: VisKind, events: readonly EventMarker[] | undefined): number {
  return kind !== 'stat' && kind !== 'geomap' && (events?.length ?? 0) > 0 ? EVENT_BAND : 0;
}

/** `${glyph} ${title}`, or the title of a kind without a glyph (T02-008). */
export function eventLabel(e: Pick<EventMarker, 'kind' | 'title'>): string {
  const g = EventGlyph[e.kind];
  return g === null ? e.title : `${g} ${e.title}`;
}

interface Member {
  readonly id: string;
  readonly x: number;
  readonly full: string;
  /** The glyph, else the first code point and `…`. */
  readonly short: string;
}

/** A laid-out event label: what `layoutEventLabels` returns. */
export type LaidOutEvent = EventLabelBox & {
  /** The text painted at the box's left edge; null when no form fits (§4.2 step 6d). */
  readonly drawn: string | null;
};

export interface EventLayout {
  /** The x of each event line in view, CSS px, in (atMs, id) order. */
  readonly lines: readonly number[];
  readonly labels: readonly LaidOutEvent[];
}

const byTimeThenId = (a: EventMarker, b: EventMarker): number =>
  a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The members in view, in (atMs, id) order, at `Math.round(x) + 0.5` (§4.2 step 2). */
function membersInView(plot: PlotRect, w: TimeWindow, events: readonly EventMarker[]): Member[] {
  const span = w.toMs - w.fromMs;
  return events
    .filter((e) => Number.isFinite(e.atMs) && e.atMs >= w.fromMs && e.atMs <= w.toMs)
    .sort(byTimeThenId)
    .map((e) => {
      const glyph = EventGlyph[e.kind];
      const first = Array.from(e.title)[0] ?? '';
      return {
        id: e.id,
        x: Math.round(plot.x + ((e.atMs - w.fromMs) / span) * plot.width) + 0.5,
        full: eventLabel(e),
        short: glyph ?? `${first}…`,
      };
    });
}

interface Candidate {
  readonly members: readonly Member[];
  readonly anchor: number;
  /** The index of the last original group it holds. */
  readonly last: number;
}

/**
 * Step 6 (a) and (b) for one group: at its anchor, the full label then `fitText`; else
 * right-aligned at `limit`, every form. Chips (two or more members) have one form, `+N`.
 */
function place(ctx: Ctx2D, c: Candidate, limit: number, lo: number): LaidOutEvent | null {
  const width = (s: string): number => ctx.measureText(s).width;
  const [one, ...more] = c.members;
  if (one === undefined) return null;
  const single = more.length === 0;
  const n = c.members.length;
  const chip = n <= 99 ? `+${String(n)}` : '99+';
  const out = (drawn: string, x: number): LaidOutEvent => ({
    box: { x, y: space['2'], width: width(drawn), height: LABEL_HEIGHT },
    x: one.x,
    ids: c.members.map((m) => m.id),
    text: c.members.map((m) => m.full).join('; '),
    clipped: !(single && drawn === one.full),
    drawn,
  });
  const roomA = limit - c.anchor;
  for (const f of single ? [one.full, fitText(ctx, one.full, roomA)] : [chip]) {
    if (f !== null && width(f) <= roomA) return out(f, c.anchor);
  }
  const roomB = limit - lo;
  for (const f of single ? [one.full, fitText(ctx, one.full, roomB), one.short] : [chip]) {
    if (f !== null && width(f) <= roomB) return out(f, limit - width(f));
  }
  return null;
}

/**
 * Lays out the event lines and labels (§4.2 steps 2 and 4–7) without painting. Events join a group
 * while they are less than `target-min` right of its first line; each group's label is placed in
 * the band `[plot.x, plot.x + plot.width]` between the previous box and the next group's anchor,
 * merged into the previous group when it does not fit, or, with no previous group, gathered with
 * every other into one chip (or one box without text when even that does not fit).
 */
export function layoutEventLabels(
  ctx: Ctx2D,
  plot: PlotRect,
  w: TimeWindow,
  events: readonly EventMarker[],
): EventLayout {
  const members = membersInView(plot, w, events);
  if (members.length === 0) return { lines: [], labels: [] };
  ctx.font = AXIS_FONT;
  const g = space['1'];
  const L = plot.x;
  const R = plot.x + plot.width;
  const groups: { first: number; members: Member[] }[] = [];
  for (const m of members) {
    const cur = groups.at(-1);
    if (cur !== undefined && m.x - cur.first < size['target-min']) cur.members.push(m);
    else groups.push({ first: m.x, members: [m] });
  }
  const anchors = groups.map((x) => Math.max(L, x.first - g));
  const limitOf = (last: number): number => {
    const next = anchors[last + 1];
    return next === undefined ? R : next - g;
  };
  const placed: { c: Candidate; label: LaidOutEvent }[] = [];
  for (let k = 0; k < groups.length; k++) {
    let c: Candidate = { members: groups[k]?.members ?? [], anchor: anchors[k] ?? L, last: k };
    for (;;) {
      const prev = placed.at(-1);
      const lo = prev === undefined ? L : prev.label.box.x + prev.label.box.width + g;
      const label = place(ctx, c, limitOf(c.last), lo);
      if (label !== null) {
        placed.push({ c, label });
        break;
      }
      if (prev !== undefined) {
        // (c) Into the previous placed group, as a chip, placed again from (a).
        placed.pop();
        c = { members: [...prev.c.members, ...c.members], anchor: prev.c.anchor, last: c.last };
        continue;
      }
      // (d) Every group in one chip; else one box without text, with every id.
      const all: Candidate = { members, anchor: anchors[0] ?? L, last: groups.length - 1 };
      const one = place(ctx, all, R, L);
      placed.length = 0;
      placed.push({
        c: all,
        label: one ?? {
          box: { x: L, y: space['2'], width: Math.max(0, R - L), height: LABEL_HEIGHT },
          x: members[0]?.x ?? L,
          ids: members.map((m) => m.id),
          text: members.map((m) => m.full).join('; '),
          clipped: true,
          drawn: null,
        },
      });
      k = groups.length;
      break;
    }
  }
  return { lines: members.map((m) => m.x), labels: placed.map((p) => p.label) };
}

/** Step 3: a solid 1 px line per event in view, across the plot, in `colours.event`. */
export function drawEventLines(i: LayerInput, plot: PlotRect, lines: readonly number[]): void {
  const { ctx, colours } = i;
  for (const x of lines) {
    ctx.strokeStyle = colours.event;
    ctx.lineWidth = border.hairline;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.height);
    ctx.stroke();
  }
}

/** Steps 5–7: the label text in the band, then the summary's boxes. */
export function drawEventLabels(
  i: LayerInput,
  labels: readonly LaidOutEvent[],
): readonly EventLabelBox[] {
  const { ctx, colours } = i;
  ctx.font = AXIS_FONT;
  ctx.fillStyle = colours.axisText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (const l of labels) if (l.drawn !== null) ctx.fillText(l.drawn, l.box.x, l.box.y);
  return labels.map(({ box, x, ids, text, clipped }) => ({ box, x, ids, text, clipped }));
}
