/**
 * Board spec v4 on the client (plan #61 Part B §3.5; v2 by plan #64 Part B §3.2, v3 by plan #173
 * Part 1 §3.2–3.4, v4 by plan #215 §3.7: tags, accepted and kept): the server's validator
 * (`server/internal/spec/shape.go`, `validate.go`) ported to parsed JSON, canonical JSON and panel
 * ids. The two are held together by the shared fixtures `api/fixtures/board-spec/`.
 *
 * Conditions of the JSON text that do not survive `JSON.parse` are not checked here: invalid JSON,
 * a duplicate key, and an integer written as `1e2` or `6.0` (the server rejects those; the client
 * only ever sends `JSON.stringify` output).
 */
import type {
  BoardSpec,
  FieldError,
  GridPos,
  PanelSpec,
  PanelVisKind,
  VisOptions,
} from '../api/types';
import { FILTER_LABEL } from '../state/boardParams';
import { MAX_THRESHOLD_STEPS } from '../vis/thresholds';
import { fits, overlaps } from './layout';
import { MAX_OPTION_ABS, OPTION_KEYS, OPTION_TYPES, OPTION_VALUES } from './options';

export const MAX_PANELS = 200;
export const MAX_SECTIONS = 50;
export const MAX_TITLE = 200;
export const MAX_QUERY_BYTES = 16384;
/** At most this many board tags (T24-029; the Go `maxBoardTags`). */
export const MAX_BOARD_TAGS = 16;
/** A board tag: the OpenAPI `AnnotationTag` (the Go `tagPattern`). */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9_.:/-]{0,63}$/;
/** Stubs until the widgets version (plan #198 Part 1 §3.3). */
export const MAX_CONTENT_BYTES = 0;
export const MAX_ZONES = 0;
export function isRfc3339Offset(_s: string): boolean {
  return false;
}
/** At most this many field errors per spec, in document order. */
export const MAX_FIELD_ERRORS = 50;
/**
 * A threshold value is 0, or finite with `MIN_THRESHOLD_ABS <= |v| <= MAX_THRESHOLD_ABS`: far
 * inside the range where the value-axis ticks are safe at both ends (#97). The Go
 * `minThresholdAbs` and `maxThresholdAbs` have the same values.
 */
export const MIN_THRESHOLD_ABS = 1e-9;
export const MAX_THRESHOLD_ABS = 1e15;

const QUERY_LANGS: readonly string[] = ['promql', 'logql'];
const VIS_KINDS: readonly string[] = [
  'auto',
  'line',
  'bars',
  'heatmap',
  'stat',
  'logs',
  'barchart',
  'pie',
];
const TIME_PATTERN =
  /^(now|now\/d|now-[1-9][0-9]{0,4}[smhdw]|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2}))$/;
const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const DIRECTIONS: readonly string[] = ['above', 'below'];
const STEP_STATES: readonly string[] = ['watch', 'degraded', 'failing'];
const LEGEND_MODES: readonly string[] = ['table', 'hidden'];
/** Only Go's `unicode.IsSpace` characters (what the server's `strings.TrimSpace` trims). */
const BLANK = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

/** `rawObject`: an object checked when the enclosing object closes (vis.options, `shape.go`). */
type Kind = 'string' | 'bool' | 'int' | 'number' | 'array' | 'object' | 'rawObject';

interface ValueType {
  kind: Kind;
  shape?: readonly Field[];
  elem?: ValueType;
}

interface Field {
  name: string;
  required: boolean;
  type: ValueType;
}

const tString: ValueType = { kind: 'string' };
const tBool: ValueType = { kind: 'bool' };
const tInt: ValueType = { kind: 'int' };
const tNumber: ValueType = { kind: 'number' };
const obj = (shape: readonly Field[]): ValueType => ({ kind: 'object', shape });
const req = (name: string, type: ValueType): Field => ({ name, required: true, type });
const opt = (name: string, type: ValueType): Field => ({ name, required: false, type });

const stepShape = [req('value', tNumber), req('state', tString), req('label', tString)];
const visShape = [
  req('kind', tString),
  opt(
    'thresholds',
    obj([req('direction', tString), req('steps', { kind: 'array', elem: obj(stepShape) })]),
  ),
  opt('legend', obj([req('mode', tString)])),
  opt('options', { kind: 'rawObject' }),
];

/** A kind's options shape (`shape.go` `optionShape`): its keys, optional and typed. */
function optionShape(kind: PanelVisKind): readonly Field[] {
  const types = { string: tString, bool: tBool, number: tNumber } as const;
  return OPTION_KEYS[kind].map((k) => opt(k, types[OPTION_TYPES[k]]));
}

const gridShape = [req('x', tInt), req('y', tInt), req('w', tInt), req('h', tInt)];
const panelShape = [
  req('id', tString),
  req('title', tString),
  req('grid', obj(gridShape)),
  req('query', obj([req('lang', tString), req('text', tString)])),
  req('vis', obj(visShape)),
];
const tPanels: ValueType = { kind: 'array', elem: obj(panelShape) };
const sectionShape = [
  req('id', tString),
  req('title', tString),
  req('collapsed', tBool),
  req('panels', tPanels),
];
const tBoard = obj([
  req('title', tString),
  req('panels', tPanels),
  req('sections', { kind: 'array', elem: obj(sectionShape) }),
  opt('time', obj([req('from', tString), req('to', tString)])),
  // Board spec v4 (plan #215, T24-029): tags.
  opt('tags', { kind: 'array', elem: tString }),
]);

/** Collects field errors in document order, at most `MAX_FIELD_ERRORS`. */
class Collector {
  readonly fields: FieldError[] = [];

  add(pointer: string, messageKey: string): void {
    if (this.fields.length < MAX_FIELD_ERRORS) this.fields.push({ pointer, messageKey });
  }
}

/** RFC 6901: `~` → `~0`, `/` → `~1`. */
function escapePointer(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isInt32(v: number): boolean {
  return Number.isInteger(v) && v >= -(2 ** 31) && v <= 2 ** 31 - 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The shape pass (`shape.go`): exact keys, required keys, no null, types, int32 grid values. */
function checkShape(c: Collector, pointer: string, value: unknown, t: ValueType): void {
  if (value === null) {
    c.add(pointer, 'board.json.null');
    return;
  }
  switch (t.kind) {
    case 'string':
      if (typeof value !== 'string') c.add(pointer, 'board.json.type');
      return;
    case 'bool':
      if (typeof value !== 'boolean') c.add(pointer, 'board.json.type');
      return;
    case 'int':
      if (typeof value !== 'number' || !isInt32(value)) c.add(pointer, 'board.json.type');
      return;
    case 'number':
      // The editor's draft can hold NaN (plan #64 Part B §4.6); JSON has no such number.
      if (typeof value !== 'number' || !Number.isFinite(value)) c.add(pointer, 'board.json.type');
      return;
    case 'array': {
      if (!Array.isArray(value)) {
        c.add(pointer, 'board.json.type');
        return;
      }
      const elem = t.elem;
      if (elem === undefined) return;
      value.forEach((v: unknown, i) => {
        checkShape(c, `${pointer}/${String(i)}`, v, elem);
      });
      return;
    }
    case 'rawObject':
      // Checked by the enclosing object (below); a non-object is reported here.
      if (!isRecord(value)) c.add(pointer, 'board.json.type');
      return;
    case 'object': {
      if (!isRecord(value)) {
        c.add(pointer, 'board.json.type');
        return;
      }
      const shape = t.shape ?? [];
      let deferred: { pointer: string; value: Record<string, unknown> } | null = null;
      for (const [key, v] of Object.entries(value)) {
        const p = `${pointer}/${escapePointer(key)}`;
        const f = shape.find((x) => x.name === key);
        if (f === undefined) c.add(p, 'board.json.unknownKey');
        else {
          checkShape(c, p, v, f.type);
          if (f.type.kind === 'rawObject' && isRecord(v)) deferred = { pointer: p, value: v };
        }
      }
      for (const f of shape) {
        if (f.required && !Object.hasOwn(value, f.name)) {
          c.add(`${pointer}/${escapePointer(f.name)}`, 'board.json.required');
        }
      }
      // vis.options: the shape of the sibling kind, only when it is a valid kind (the rules pass
      // reports any other), after this object's own problems.
      const tag = value['kind'];
      if (deferred !== null && typeof tag === 'string' && VIS_KINDS.includes(tag)) {
        checkShape(c, deferred.pointer, deferred.value, obj(optionShape(tag as PanelVisKind)));
      }
    }
  }
}

/** Code points, as Go's `utf8.RuneCountInString`. */
function runes(s: string): number {
  return Array.from(s).length;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** 0 (-0 included), or `MIN_THRESHOLD_ABS <= |v| <= MAX_THRESHOLD_ABS`; v is finite. */
export function inThresholdRange(v: number): boolean {
  const a = Math.abs(v);
  return v === 0 || (a >= MIN_THRESHOLD_ABS && a <= MAX_THRESHOLD_ABS);
}

/** The semantic pass (`validate.go`), on a spec whose shape is clean. */
function checkRules(c: Collector, b: BoardSpec): void {
  const ids = new Set<string>();
  const str = (pointer: string, s: string, rule: (s: string) => string | null): void => {
    if (s.includes('\u0000')) {
      c.add(pointer, 'board.string.nul');
      return;
    }
    const key = rule(s);
    if (key !== null) c.add(pointer, key);
  };
  const maxRunes =
    (key: string) =>
    (s: string): string | null =>
      runes(s) > MAX_TITLE ? key : null;
  const oneOf =
    (set: readonly string[], key: string) =>
    (s: string): string | null =>
      set.includes(s) ? null : key;
  const id = (pointer: string, s: string): void => {
    str(pointer, s, (x) => {
      if (!ID_PATTERN.test(x)) return 'board.id.invalid';
      if (ids.has(x)) return 'board.id.duplicate';
      ids.add(x);
      return null;
    });
  };
  const panels = (pointer: string, list: readonly PanelSpec[]): void => {
    const placed: GridPos[] = [];
    list.forEach((p, i) => {
      const pp = `${pointer}/${String(i)}`;
      id(`${pp}/id`, p.id);
      str(`${pp}/title`, p.title, maxRunes('board.panel.title.tooLong'));
      if (!fits(p.grid)) c.add(`${pp}/grid`, 'board.grid.outOfBounds');
      else if (placed.some((g) => overlaps(g, p.grid))) c.add(`${pp}/grid`, 'board.grid.overlap');
      else placed.push(p.grid);
      str(`${pp}/query/lang`, p.query.lang, oneOf(QUERY_LANGS, 'board.query.lang.invalid'));
      str(`${pp}/query/text`, p.query.text, (s) =>
        utf8Bytes(s) > MAX_QUERY_BYTES ? 'board.query.text.tooLong' : null,
      );
      str(`${pp}/vis/kind`, p.vis.kind, oneOf(VIS_KINDS, 'board.vis.kind.invalid'));
      vis(`${pp}/vis`, p.vis);
    });
  };
  // Thresholds and legend (`validate.go` `vis`), after vis.kind; every step is checked, even past 8.
  const vis = (pointer: string, v: PanelSpec['vis']): void => {
    const th = v.thresholds;
    if (th !== undefined) {
      const tp = `${pointer}/thresholds`;
      str(`${tp}/direction`, th.direction, oneOf(DIRECTIONS, 'board.thresholds.direction.invalid'));
      if (th.steps.length === 0 || th.steps.length > MAX_THRESHOLD_STEPS) {
        c.add(`${tp}/steps`, 'board.thresholds.steps.count');
      }
      th.steps.forEach((s, k) => {
        const sp = `${tp}/steps/${String(k)}`;
        if (!inThresholdRange(s.value)) c.add(`${sp}/value`, 'board.thresholds.value.range');
        else if (th.steps.slice(0, k).some((e) => e.value === s.value)) {
          c.add(`${sp}/value`, 'board.thresholds.value.duplicate');
        }
        str(`${sp}/state`, s.state, oneOf(STEP_STATES, 'board.thresholds.state.invalid'));
        str(`${sp}/label`, s.label, maxRunes('board.thresholds.label.tooLong'));
      });
    }
    if (v.legend !== undefined) {
      str(
        `${pointer}/legend/mode`,
        v.legend.mode,
        oneOf(LEGEND_MODES, 'board.legend.mode.invalid'),
      );
    }
    if (v.options !== undefined && VIS_KINDS.includes(v.kind)) {
      options(`${pointer}/options`, v.kind, v.options);
    }
  };
  // The option values (`validate.go` `options`, plan #173 Part 1 §3.4): each present key in
  // OPTION_ORDER; min ≥ max is reported at max, only when min is valid.
  const options = (pointer: string, kind: PanelVisKind, o: VisOptions): void => {
    const invalid = (k: string): string => `board.options.${k}.invalid`;
    const enumOf = (k: string, s: string | undefined, set: readonly string[]): void => {
      if (s !== undefined) str(`${pointer}/${k}`, s, oneOf(set, invalid(k)));
    };
    const bound = (x: number): boolean => Math.abs(x) <= MAX_OPTION_ABS;
    enumOf('reducer', o.reducer, OPTION_VALUES.reducer);
    enumOf('baselineOffset', o.baselineOffset, OPTION_VALUES.baselineOffset);
    if (o.categoryBy !== undefined) {
      str(`${pointer}/categoryBy`, o.categoryBy, (s) =>
        s !== '' && !FILTER_LABEL.test(s) ? invalid('categoryBy') : null,
      );
    }
    enumOf('sort', o.sort, OPTION_VALUES.sort);
    enumOf(
      'orientation',
      o.orientation,
      kind === 'stat' ? OPTION_VALUES.statOrientation : OPTION_VALUES.orientation,
    );
    const minValid = o.min !== undefined && bound(o.min);
    if (o.min !== undefined && !minValid) c.add(`${pointer}/min`, invalid('min'));
    if (o.max !== undefined && (!bound(o.max) || (minValid && (o.min ?? 0) >= o.max))) {
      c.add(`${pointer}/max`, invalid('max'));
    }
    enumOf('labels', o.labels, OPTION_VALUES.labels);
    enumOf('layout', o.layout, OPTION_VALUES.layout);
    enumOf('colourMode', o.colourMode, OPTION_VALUES.colourMode);
    if (o.textMode !== undefined) {
      const grid = o.layout === 'grid';
      str(`${pointer}/textMode`, o.textMode, (s) =>
        !(OPTION_VALUES.textMode as readonly string[]).includes(s) || (grid && s === 'value')
          ? invalid('textMode')
          : null,
      );
    }
    enumOf('graphMode', o.graphMode, OPTION_VALUES.graphMode);
  };

  str('/title', b.title, (s) =>
    BLANK.test(s) ? 'board.title.required' : maxRunes('board.title.tooLong')(s),
  );
  if (b.time !== undefined) {
    const valid = (s: string): string | null =>
      TIME_PATTERN.test(s) ? null : 'board.time.invalid';
    str('/time/from', b.time.from, valid);
    str('/time/to', b.time.to, valid);
  }
  // Tags (`validate.go` `tags`): more than 16 at /tags, then each item, unique in order.
  const tags = b.tags ?? [];
  if (tags.length > MAX_BOARD_TAGS) c.add('/tags', 'board.tags.invalid');
  tags.forEach((tag, i) => {
    str(`/tags/${String(i)}`, tag, (s) => {
      if (!TAG_PATTERN.test(s)) return 'board.tags.invalid';
      if (tags.slice(0, i).includes(s)) return 'board.tags.duplicate';
      return null;
    });
  });
  const total = b.panels.length + b.sections.reduce((n, s) => n + s.panels.length, 0);
  if (total > MAX_PANELS) c.add('/panels', 'board.panels.tooMany');
  panels('/panels', b.panels);
  if (b.sections.length > MAX_SECTIONS) c.add('/sections', 'board.sections.tooMany');
  b.sections.forEach((s, j) => {
    const p = `/sections/${String(j)}`;
    id(`${p}/id`, s.id);
    str(`${p}/title`, s.title, maxRunes('board.section.title.tooLong'));
    panels(`${p}/panels`, s.panels);
  });
}

/**
 * The problems of a parsed spec, in the server's order and pointer format, at most 50 (empty when
 * the spec is valid). The semantic rules run only when the shape is clean, as on the server.
 */
export function checkBoardSpec(value: unknown): FieldError[] {
  const c = new Collector();
  checkShape(c, '', value, tBoard);
  if (c.fields.length === 0) checkRules(c, value as BoardSpec);
  return c.fields;
}

/** JSON with object keys sorted (UTF-16 code unit order) and no spaces. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
  return out;
}

/**
 * `<prefix>-<n>` with n one more than the largest `<prefix>-<n>` id of the board. Ids are unique
 * across panels and sections, so both count; n is a BigInt, so a suffix past 2^53 does not round
 * onto an id in use. When n + 1 no longer fits an id (40 characters), the lowest free
 * `<prefix>-<n>` is used.
 */
export function nextId(spec: BoardSpec, prefix: string): string {
  const used = new Set<string>(spec.sections.map((s) => s.id));
  for (const p of [...spec.panels, ...spec.sections.flatMap((s) => s.panels)]) used.add(p.id);
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0n;
  for (const id of used) {
    const m = pattern.exec(id);
    if (m?.[1] !== undefined) {
      const n = BigInt(m[1]);
      if (n > max) max = n;
    }
  }
  const next = `${prefix}-${String(max + 1n)}`;
  if (ID_PATTERN.test(next) && !used.has(next)) return next;
  // At most `used.size` ids are taken, so this ends within `used.size + 1` steps.
  for (let n = 1; ; n++) {
    const id = `${prefix}-${String(n)}`;
    if (!used.has(id)) return id;
  }
}

/** `p-<n>`: see `nextId`. */
export function nextPanelId(spec: BoardSpec): string {
  return nextId(spec, 'p');
}

/** `s-<n>`: see `nextId`. */
export function nextSectionId(spec: BoardSpec): string {
  return nextId(spec, 's');
}
