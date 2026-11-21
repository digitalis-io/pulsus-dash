/**
 * Board spec v1 on the client (plan #61 Part B §3.5): the server's validator
 * (`server/internal/spec/shape.go`, `validate.go`) ported to parsed JSON, canonical JSON and panel
 * ids. The two are held together by the shared fixtures `api/fixtures/board-spec/`.
 *
 * Conditions of the JSON text that do not survive `JSON.parse` are not checked here: invalid JSON,
 * a duplicate key, and an integer written as `1e2` or `6.0` (the server rejects those; the client
 * only ever sends `JSON.stringify` output).
 */
import type { BoardSpec, FieldError, GridPos, PanelSpec } from '../api/types';
import { fits, overlaps } from './layout';

export const MAX_PANELS = 200;
export const MAX_SECTIONS = 50;
export const MAX_TITLE = 200;
export const MAX_QUERY_BYTES = 16384;
/** At most this many field errors per spec, in document order. */
export const MAX_FIELD_ERRORS = 50;

const QUERY_LANGS: readonly string[] = ['promql', 'logql'];
const VIS_KINDS: readonly string[] = ['auto', 'line', 'bars', 'heatmap', 'stat', 'logs'];
const TIME_PATTERN =
  /^(now|now\/d|now-[1-9][0-9]{0,4}[smhdw]|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2}))$/;
const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
/** Only Go's `unicode.IsSpace` characters (what the server's `strings.TrimSpace` trims). */
const BLANK = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

type Kind = 'string' | 'bool' | 'int' | 'array' | 'object';

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
const obj = (shape: readonly Field[]): ValueType => ({ kind: 'object', shape });
const req = (name: string, type: ValueType): Field => ({ name, required: true, type });

const gridShape = [req('x', tInt), req('y', tInt), req('w', tInt), req('h', tInt)];
const panelShape = [
  req('id', tString),
  req('title', tString),
  req('grid', obj(gridShape)),
  req('query', obj([req('lang', tString), req('text', tString)])),
  req('vis', obj([req('kind', tString)])),
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
  { name: 'time', required: false, type: obj([req('from', tString), req('to', tString)]) },
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
    case 'object': {
      if (!isRecord(value)) {
        c.add(pointer, 'board.json.type');
        return;
      }
      const shape = t.shape ?? [];
      for (const [key, v] of Object.entries(value)) {
        const p = `${pointer}/${escapePointer(key)}`;
        const f = shape.find((x) => x.name === key);
        if (f === undefined) c.add(p, 'board.json.unknownKey');
        else checkShape(c, p, v, f.type);
      }
      for (const f of shape) {
        if (f.required && !Object.hasOwn(value, f.name)) {
          c.add(`${pointer}/${escapePointer(f.name)}`, 'board.json.required');
        }
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
    });
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

/** Stub (plan #61 Part C §2). */
export function nextId(spec: BoardSpec, prefix: string): string {
  return prefix === 'p' ? nextPanelId(spec) : 's-1';
}

/** Stub. */
export function nextSectionId(spec: BoardSpec): string {
  return nextId(spec, 's');
}

/**
 * `p-<n>` with n one more than the largest `p-<n>` id of the board. Ids are unique across panels
 * and sections, so section ids count too; n is a BigInt, so a suffix past 2^53 does not round onto
 * an id in use. When n + 1 no longer fits an id (40 characters), the lowest free `p-<n>` is used.
 */
export function nextPanelId(spec: BoardSpec): string {
  const used = new Set<string>(spec.sections.map((s) => s.id));
  for (const p of [...spec.panels, ...spec.sections.flatMap((s) => s.panels)]) used.add(p.id);
  let max = 0n;
  for (const id of used) {
    const m = /^p-(\d+)$/.exec(id);
    if (m?.[1] !== undefined) {
      const n = BigInt(m[1]);
      if (n > max) max = n;
    }
  }
  const next = `p-${String(max + 1n)}`;
  if (ID_PATTERN.test(next) && !used.has(next)) return next;
  // At most `used.size` ids are taken, so this ends within `used.size + 1` steps.
  for (let n = 1; ; n++) {
    const id = `p-${String(n)}`;
    if (!used.has(id)) return id;
  }
}
