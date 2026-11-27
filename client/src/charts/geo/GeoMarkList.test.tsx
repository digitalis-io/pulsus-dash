/**
 * `unit:geo-list`, `unit:geo-list-keys` and `unit:geo-list-repair` (T24-093, T24 §10.5; plan #234
 * Part 3 §3.4, §4.3): the hidden mark list's names, positions and sizes, the placeholder, the keys
 * (the amended §10.5 keys block: Shift+← pans 256 px, Shift+→ is held by containment at G's fit) and
 * the repair order on new marks. The marks come from the real scene at each view.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChartFrame as EngineFrame, GeoMarksEvent, GeoView } from '../../engine/api';
import { camOf, panPx, viewOf } from '../../engine/controller/geo/camera';
import { worldPx } from '../../engine/controller/geo/project';
import type { Selection } from '../../inspector/types';
import { ctlKit, frameOf, H as PH, pxOf, sceneKit, W } from '../../test/geoKit';
import { MS } from '../../test/geoHostKit';
import { G, G3, TH } from '../../vis/geo/fixtures/series';
import type { GeoFrame } from '../../vis/geo/frame';
import { GeoMarkList, type GeoMarkListProps } from './GeoMarkList';

afterEach(cleanup);

const G_FIT: GeoView = {
  lat: 33.388480626497824,
  lon: 31.996999999999986,
  zoom: 2.6218728064801105,
};
const G3_FIT: GeoView = { lat: 30.733727227695173, lon: 65.875, zoom: 3.1774065828117646 };

/** The marks the scene of `f` sends at `view` (null: fit). */
function marksAt(f: GeoFrame, view: GeoView | null = null): GeoMarksEvent['marks'] {
  const k = sceneKit({ frame: f, spec: { view, motion: 'cut' } });
  const m = k.marks.at(-1);
  if (m === undefined) throw new Error('no geoMarks');
  return m.marks;
}

interface Kit {
  readonly ul: () => HTMLElement;
  readonly buttons: () => HTMLButtonElement[];
  readonly names: () => string[];
  readonly props: GeoMarkListProps;
  rerender(p: Partial<GeoMarkListProps>): void;
  readonly onInspect: ReturnType<typeof vi.fn>;
  readonly onActive: ReturnType<typeof vi.fn>;
  readonly announce: ReturnType<typeof vi.fn>;
  readonly camera: string[];
}

function fakeFrame(camera: string[]): EngineFrame {
  return {
    cameraKey: (k: string) => {
      camera.push(k);
    },
    setFocusMark: () => undefined,
  } as unknown as EngineFrame;
}

function list(f: GeoFrame, o: Partial<GeoMarkListProps> = {}): Kit {
  const onInspect = vi.fn();
  const onActive = vi.fn();
  const announce = vi.fn();
  const camera: string[] = [];
  let props: GeoMarkListProps = {
    title: 'Latency map',
    marks: marksAt(f),
    rows: new Map(f.rows.map((r) => [r.key, r])),
    unit: MS,
    complete: false,
    selection: null,
    frame: fakeFrame(camera),
    seq: f.seq,
    rowSet: f,
    onInspect,
    onActive,
    announce,
    ...o,
  };
  const view = render(
    <div data-parent="">
      <GeoMarkList {...props} />
    </div>,
  );
  const ul = (): HTMLElement => {
    const el = document.querySelector<HTMLElement>('ul[aria-label]');
    expect(el, 'the mark list').not.toBeNull();
    if (el === null) throw new Error('no list');
    return el;
  };
  const buttons = (): HTMLButtonElement[] => [...ul().querySelectorAll('button')];
  return {
    ul,
    buttons,
    names: () => buttons().map((b) => b.textContent),
    get props() {
      return props;
    },
    rerender(p) {
      props = { ...props, ...p };
      view.rerender(
        <div data-parent="">
          <GeoMarkList {...props} />
        </div>,
      );
    },
    onInspect,
    onActive,
    announce,
    camera,
  };
}

const press = (el: Element, key: string, o: KeyboardEventInit = {}): boolean =>
  fireEvent.keyDown(el, { key, ...o });

const posOf = (b: HTMLElement): [string | null, string | null] => {
  const li = b.closest('li');
  return [li?.getAttribute('aria-posinset') ?? null, li?.getAttribute('aria-setsize') ?? null];
};

const G_TH = (): GeoFrame => frameOf(G(), { th: TH });

const LIST = [
  'Cluster of 5, near Mons, worst degraded',
  'Cluster of 2, near 40.7128, -74.0060, worst failing',
  '{geo_country_iso_code="jp"}, 60 ms, ok, Japan',
  '{iata="sin"}, 40 ms, ok, Singapore',
  '{lat="0", lon="0"}, -30 ms, ok, 0.0000, 0.0000',
];

describe('unit:geo-list', () => {
  it('G at fit: the §10.5 list block, one roving tab stop, setsize −1', () => {
    const k = list(G_TH());
    expect(k.ul()).toHaveAttribute('aria-label', 'Latency map: map marks');
    expect(k.names()).toEqual(LIST);
    expect(k.buttons().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(k.buttons().map(posOf)).toEqual([
      ['1', '-1'],
      ['2', '-1'],
      ['3', '-1'],
      ['4', '-1'],
      ['5', '-1'],
    ]);
    const sel = (keys: string[]): Selection => ({ keys, fromMs: null, toMs: null });
    k.rerender({ selection: sel(['k03']) });
    expect(k.names()[0]).toBe('Cluster of 5, near Mons, worst degraded, 1 selected');
    k.rerender({ selection: sel(['k05']) });
    expect(k.names()[2]).toBe('{geo_country_iso_code="jp"}, 60 ms, ok, Japan, selected');
    expect(k.names()[0]).toBe(LIST[0]);
  });

  it('G3: fit, a pan north and a pan to no marks', () => {
    const f = frameOf(G3(), { th: TH });
    const k = list(f, { complete: true, marks: marksAt(f, G3_FIT) });
    expect(k.names().map((n) => n.split(',')[0])).toEqual([
      '{cloud_region="eu-west-1"}',
      '{geo_country_iso_code="jp"}',
      '{iata="sin"}',
    ]);
    expect(k.buttons().map((b) => posOf(b)[1])).toEqual(['3', '3', '3']);
    expect(pxOf(f, 'k01', G3_FIT).x).toBeCloseTo(48, 2);
    const north = viewOf(panPx(camOf(G3_FIT), 0, -200, W, PH));
    k.rerender({ marks: marksAt(f, north) });
    expect(k.names().map((n) => n.split(',')[0])).toEqual([
      '{cloud_region="eu-west-1"}',
      '{geo_country_iso_code="jp"}',
    ]);
    expect(k.buttons().map((b) => posOf(b)[1])).toEqual(['-1', '-1']);
    k.rerender({ marks: marksAt(f, { lat: 70, lon: -150, zoom: 6 }) });
    expect(k.names()).toEqual(['No marks in view · Fit']);
    expect(posOf(k.buttons()[0] as HTMLElement)).toEqual([null, null]);
  });

  it('the placeholder: focused, marks return and it stays, ↓ → k01; Enter fits', () => {
    const f = frameOf(G3(), { th: TH });
    const k = list(f, { complete: true, marks: marksAt(f, { lat: 70, lon: -150, zoom: 6 }) });
    const ph = k.buttons()[0] as HTMLButtonElement;
    act(() => {
      ph.focus();
    });
    press(ph, 'Enter');
    expect(k.camera).toEqual(['fit']);
    k.rerender({ marks: marksAt(f, G3_FIT) });
    expect(k.names()).toEqual(['No marks in view · Fit']);
    expect(document.activeElement).toBe(k.buttons()[0]);
    press(k.buttons()[0] as HTMLElement, 'ArrowDown');
    expect(document.activeElement?.textContent).toMatch(/^\{cloud_region="eu-west-1"\}/);
    expect(k.names()).toHaveLength(3);
  });
});

describe('unit:geo-list-keys', () => {
  it('↓, End, Home, PageDown, Enter; handled keys stop, Esc propagates', () => {
    const k = list(G_TH());
    const parent = vi.fn();
    document.querySelector('[data-parent]')?.addEventListener('keydown', (e) => {
      parent((e as KeyboardEvent).key);
    });
    const b = k.buttons();
    act(() => {
      b[0]?.focus();
    });
    expect(k.onActive).toHaveBeenLastCalledWith('cluster:k03');
    press(b[0] as HTMLElement, 'ArrowDown');
    expect(document.activeElement).toBe(k.buttons()[1]);
    expect(k.onActive).toHaveBeenLastCalledWith('cluster:k07');
    expect(k.buttons().map((x) => x.tabIndex)).toEqual([-1, 0, -1, -1, -1]);
    press(document.activeElement as HTMLElement, 'End');
    expect(document.activeElement).toBe(k.buttons()[4]);
    expect(k.onActive).toHaveBeenLastCalledWith('k14');
    press(document.activeElement as HTMLElement, 'Home');
    expect(document.activeElement).toBe(k.buttons()[0]);
    press(document.activeElement as HTMLElement, 'PageDown');
    expect(document.activeElement).toBe(k.buttons()[4]);
    press(document.activeElement as HTMLElement, 'ArrowRight');
    expect(document.activeElement).toBe(k.buttons()[4]);
    press(document.activeElement as HTMLElement, 'PageUp');
    expect(document.activeElement).toBe(k.buttons()[0]);
    expect(parent).not.toHaveBeenCalled();
    press(document.activeElement as HTMLElement, 'Enter');
    expect(k.onInspect).toHaveBeenCalledTimes(1);
    const [t, el] = k.onInspect.mock.calls[0] as [
      { kind: string; id: string; rows: { key: string }[] },
      HTMLElement,
    ];
    expect(t.kind).toBe('cluster');
    expect(t.id).toBe('cluster:k03');
    expect(t.rows.map((r) => r.key)).toEqual(['k01', 'k02', 'k03', 'k04', 'k08']);
    expect(el).toBe(k.buttons()[0]);
    press(document.activeElement as HTMLElement, ' ');
    expect(k.onInspect).toHaveBeenCalledTimes(2);
    const escape = press(document.activeElement as HTMLElement, 'Escape');
    expect(escape).toBe(true);
    expect(parent).toHaveBeenCalledWith('Escape');
    press(document.activeElement as HTMLElement, 'a');
    expect(parent).toHaveBeenCalledWith('a');
  });

  it('the camera keys on k05 (the amended §10.5 keys block); a parent sees none', () => {
    const c = ctlKit({ frame: G_TH(), spec: { motion: 'cut' } });
    const frame = {
      cameraKey: (x: Parameters<EngineFrame['cameraKey']>[0]) => {
        c.ctl.cameraKey(x);
      },
      setFocusMark: (id: string | null) => {
        c.ctl.setFocusMark(id);
      },
    } as unknown as EngineFrame;
    const k = list(G_TH(), {
      frame,
      onActive: (id) => {
        frame.setFocusMark(id);
      },
    });
    const parent = vi.fn();
    document.querySelector('[data-parent]')?.addEventListener('keydown', parent);
    const k05 = k.buttons()[2] as HTMLButtonElement;
    act(() => {
      k05.focus();
    });
    const centreX = (v: GeoView): number => camOf(v).u * worldPx(v.zoom);
    const x0 = centreX(c.ctl.view);
    expect(press(k05, 'ArrowLeft', { shiftKey: true })).toBe(false);
    expect(centreX(c.ctl.view) - x0).toBeCloseTo(-256, 6);
    press(k05, '0');
    expect(c.ctl.view.zoom).toBeCloseTo(G_FIT.zoom, 9);
    press(k05, 'ArrowRight', { shiftKey: true });
    expect(centreX(c.ctl.view) - x0).toBeCloseTo(135.84385347584475, 6);
    press(k05, '0');
    const at = pxOf(c.frame, 'k05', c.ctl.view);
    press(k05, '+');
    expect(c.ctl.view.zoom).toBeCloseTo(3.6218728064801105, 12);
    const after = pxOf(c.frame, 'k05', c.ctl.view);
    expect(Math.abs(after.x - at.x) + Math.abs(after.y - at.y)).toBeLessThan(1e-6);
    press(k05, '-');
    expect(c.ctl.view.zoom).toBeCloseTo(G_FIT.zoom, 9);
    press(k05, '=');
    press(k05, '0');
    expect(c.ctl.view.lat).toBeCloseTo(G_FIT.lat, 9);
    expect(c.ctl.view.lon).toBeCloseTo(G_FIT.lon, 9);
    expect(c.ctl.view.zoom).toBeCloseTo(G_FIT.zoom, 9);
    expect(parent).not.toHaveBeenCalled();
  });
});

describe('unit:geo-list-repair', () => {
  const VIEW_A: GeoView = { lat: 50.45, lon: 3.94, zoom: 5 };

  it('(a) active cluster:k03, view → (50.45, 3.94, 5): k01, k04, k02, k03, active k03', () => {
    const f = G_TH();
    const k = list(f);
    act(() => {
      k.buttons()[0]?.focus();
    });
    k.rerender({ marks: marksAt(f, VIEW_A) });
    expect(k.names().map((n) => n.split(',')[0])).toEqual([
      '{cloud_region="eu-west-1"}',
      '{cloud_region="westeurope"}',
      '{cloud_region="eu-west-2"}',
      '{cloud_provider="gcp"',
    ]);
    expect(document.activeElement).toBe(k.buttons()[3]);
    expect(k.onActive).toHaveBeenLastCalledWith('k03');
    expect(k.announce).not.toHaveBeenCalled();
  });

  it('(b) active k01 at that view, view → fit: active cluster:k03 (holds k01)', () => {
    const f = G_TH();
    const k = list(f, { marks: marksAt(f, VIEW_A) });
    act(() => {
      k.buttons()[0]?.focus();
    });
    k.rerender({ marks: marksAt(f) });
    expect(document.activeElement).toBe(k.buttons()[0]);
    expect(document.activeElement?.textContent).toBe(LIST[0]);
    expect(k.announce).not.toHaveBeenCalled();
  });

  it('(c) active k06, a refetch without k06: k14 (the old index clamped), announced once', () => {
    const f = G_TH();
    const k = list(f);
    act(() => {
      k.buttons()[3]?.focus();
    });
    const next = frameOf(
      G().filter((s) => s.key !== 'k06'),
      { th: TH, seq: 2 },
    );
    k.rerender({
      marks: marksAt(next, G_FIT),
      rows: new Map(next.rows.map((r) => [r.key, r])),
      rowSet: next,
      seq: 2,
    });
    expect(k.names().map((n) => n.split(',')[0])).toEqual([
      'Cluster of 5',
      'Cluster of 2',
      '{geo_country_iso_code="jp"}',
      '{lat="0"',
    ]);
    expect(document.activeElement).toBe(k.buttons()[3]);
    expect(k.announce).toHaveBeenCalledTimes(1);
    expect(k.announce).toHaveBeenCalledWith(
      '{iata="sin"}, 40 ms, ok, Singapore is no longer shown',
    );
  });

  it('(d) (c) with focus outside the list: the same active item, focus unmoved', () => {
    const f = G_TH();
    const k = list(f);
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => {
      k.buttons()[3]?.focus();
    });
    act(() => {
      outside.focus();
    });
    const next = frameOf(
      G().filter((s) => s.key !== 'k06'),
      { th: TH, seq: 2 },
    );
    k.rerender({
      marks: marksAt(next, G_FIT),
      rows: new Map(next.rows.map((r) => [r.key, r])),
      rowSet: next,
      seq: 2,
    });
    expect(document.activeElement).toBe(outside);
    expect(k.buttons().map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0]);
    outside.remove();
  });
});
