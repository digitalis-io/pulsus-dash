/**
 * `describe('camera')` of plan #93 §5.1 and Appendix A §A.13 (F1): wheel, pinch, swipe and drag
 * zoom and pan in the Canvas 2D frame, the commit event, the context menu and the scroll latch.
 * The band hold and the value labels are in `Canvas2DEngine.band.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FrameData, VisSpec } from '../api';
import { gesture, key, pointer, wheel, type Harness } from '../../test/engineHarness';
import { mulberry32 } from '../../test/random';
import { brushSnapUnit } from './columns';
import {
  T0,
  T1,
  NONE,
  LINE,
  setup,
  present,
  range,
  last,
  xOf,
  tAt,
  axisOf,
  yOf,
  vAt,
  winOf,
  at,
  lineData,
  measuredX,
} from '../../test/cameraKit';

describe('camera', () => {
  it('unit:camera-controller 100 random wheel steps', () => {
    const h = setup();
    const plot0 = last(h).plot;
    const rnd = mulberry32(93);
    let ta = 0;
    let va = 0;
    let p = { x: 0, y: 0 };
    for (let n = 0; n < 100; n++) {
      const prev = last(h);
      p = at(prev, rnd(), rnd());
      ta = tAt(prev, p.x);
      va = vAt(prev, p.y);
      const d = (rnd() * 2 - 1) * 300;
      const mode = Math.floor(rnd() * 4);
      const init =
        mode === 0
          ? { deltaY: d }
          : mode === 1
            ? { deltaY: d, shiftKey: true }
            : mode === 2
              ? { deltaY: Math.round(d), ctrlKey: true }
              : { deltaY: d + 0.25, ctrlKey: true };
      wheel(h.canvas, p.x, p.y, init);
      h.flush();
      const s = last(h);
      expect(s.plot.x).toBe(plot0.x);
      expect(s.plot.width).toBe(plot0.width);
      expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(0.01);
      expect(Math.abs(yOf(s, va) - p.y)).toBeLessThan(0.01);
    }
    h.advance(300);
    h.flush();
    const s = last(h);
    expect(s.plot).toEqual(plot0);
    expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(1);
    expect(Math.abs(yOf(s, va) - p.y)).toBeLessThan(1);
  });

  it('X and Y zoom independently', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.4);
    wheel(h.canvas, p.x, p.y, { deltaY: -100 });
    h.flush();
    const s1 = last(h);
    expect(s1.fromMs).not.toBe(s0.fromMs);
    expect(s1.toMs).not.toBe(s0.toMs);
    expect(s1.valueAxis?.manual).toBe(false);
    wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
    h.flush();
    const s2 = last(h);
    expect(winOf(s2)).toEqual(winOf(s1));
    expect(s2.valueAxis?.manual).toBe(true);
    expect(s2.valueAxis).not.toEqual(s1.valueAxis);
    wheel(h.canvas, p.x, p.y, { deltaY: -100 });
    h.flush();
    const s3 = last(h);
    expect(winOf(s3)).not.toEqual(winOf(s2));
    expect(s3.valueAxis).toEqual(s2.valueAxis);
  });

  it('wheel commits after 300 ms idle', () => {
    const h = setup();
    const p = at(last(h), 0.3);
    for (let i = 0; i < 3; i++) {
      if (i > 0) h.advance(100);
      wheel(h.canvas, p.x, p.y, { deltaY: -100 });
      h.flush();
    }
    h.advance(299);
    expect(h.commit).toEqual([]);
    h.advance(1);
    expect(h.commit).toHaveLength(1);
    const c = h.commit[0];
    expect(c?.value).toBeNull();
    expect(c?.gesture).toBe('wheel');
    const w = present(c?.window, 'window');
    expect(Number.isInteger(w.fromMs) && Number.isInteger(w.toMs)).toBe(true);
    h.flush();
    expect(winOf(last(h))).toEqual(w);
  });

  it('Ctrl+wheel commits both axes', () => {
    const h = setup();
    const p = at(last(h), 0.3);
    expect(wheel(h.canvas, p.x, p.y, { deltaY: -100, ctrlKey: true }).defaultPrevented).toBe(true);
    h.flush();
    h.advance(300);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.window).not.toBeNull();
    expect(h.commit[0]?.value).not.toBeNull();
  });

  it('pinch zooms time only', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.3);
    const ta = tAt(s0, p.x);
    for (let i = 0; i < 4; i++) wheel(h.canvas, p.x, p.y, { deltaY: -2.5, ctrlKey: true });
    h.flush();
    const s = last(h);
    expect(s.toMs - s.fromMs).toBeLessThan(s0.toMs - s0.fromMs);
    expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(0.01);
    expect(s.valueAxis?.manual).toBe(false);
    h.advance(300);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.value).toBeNull();
  });

  it('⌘+wheel zooms both', () => {
    const h = setup();
    const p = at(last(h), 0.3);
    wheel(h.canvas, p.x, p.y, { deltaY: -2.5, metaKey: true });
    h.flush();
    expect(last(h).valueAxis?.manual).toBe(true);
  });

  it('Safari gesture zooms time', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.3);
    const ta = tAt(s0, p.x);
    const start = gesture(h.canvas, 'gesturestart', p.x, p.y, 1);
    const change = gesture(h.canvas, 'gesturechange', p.x, p.y, 2);
    h.flush();
    const s1 = last(h);
    expect(s1.toMs - s1.fromMs).toBeCloseTo((s0.toMs - s0.fromMs) / 2, 3);
    expect(Math.abs(xOf(s1, ta) - p.x)).toBeLessThan(0.01);
    wheel(h.canvas, p.x, p.y, { deltaY: -100, ctrlKey: true });
    h.flush();
    expect(last(h)).toEqual(s1);
    const end = gesture(h.canvas, 'gestureend', p.x, p.y, 2);
    expect([start, change, end].map((e) => e.defaultPrevented)).toEqual([true, true, true]);
    h.advance(300);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.gesture).toBe('wheel');
  });

  it('swipe pans time', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.3);
    wheel(h.canvas, p.x, p.y, { deltaX: 80, deltaY: 5 });
    h.flush();
    const s = last(h);
    const span = s0.toMs - s0.fromMs;
    expect(s.fromMs - s0.fromMs).toBeCloseTo((80 / s0.plot.width) * span, 3);
    expect(s.toMs - s.fromMs).toBeCloseTo(span, 3);
  });

  it('wheel outside the plot is not consumed', () => {
    const h = setup();
    const s0 = last(h);
    const mid = s0.plot.y + s0.plot.height / 2;
    for (const [x, y] of [
      [s0.plot.x - 10, mid],
      [s0.plot.x + 100, 239],
      [s0.plot.x + s0.plot.width + 4, mid],
    ] as const) {
      expect(wheel(h.canvas, x, y, { deltaY: -100 }).defaultPrevented).toBe(false);
    }
    h.flush();
    expect(last(h)).toEqual(s0);
    h.advance(400);
    expect(h.commit).toEqual([]);
  });

  it('scroll latch', () => {
    const t = 10_000;
    const h = setup({ latch: { lastPageWheel: () => t } });
    const s0 = last(h);
    const p = at(s0, 0.5);
    const first = wheel(h.canvas, p.x, p.y, { deltaY: -100, timeStamp: t + 100 });
    h.flush();
    expect(first.defaultPrevented).toBe(false);
    expect(last(h)).toEqual(s0);
    const second = wheel(h.canvas, p.x, p.y, { deltaY: -100, timeStamp: t + 400 });
    h.flush();
    expect(second.defaultPrevented).toBe(true);
    expect(last(h).toMs - last(h).fromMs).toBeLessThan(s0.toMs - s0.fromMs);
  });

  it('left drag pans and commits on release', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.5);
    const span = s0.toMs - s0.fromMs;
    pointer(h.canvas, 'pointerdown', p.x, p.y, { buttons: 1 });
    expect(h.canvas.dataset['gesture']).toBe('pan');
    pointer(h.canvas, 'pointermove', p.x + 3, p.y, { buttons: 1 });
    h.flush();
    expect(winOf(last(h))).toEqual(winOf(s0));
    pointer(h.canvas, 'pointermove', p.x + 200, p.y, { buttons: 1 });
    h.flush();
    expect(Math.abs(last(h).fromMs - (s0.fromMs - (200 / s0.plot.width) * span))).toBeLessThan(1);
    pointer(h.canvas, 'pointerup', p.x + 200, p.y);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.gesture).toBe('pan');
    expect(h.commit[0]?.value).toBeNull();
    expect(h.brush).toEqual([]);
    expect(h.canvas.dataset['gesture']).toBeUndefined();
  });

  it('middle drag pans', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.5);
    const down = pointer(h.canvas, 'pointerdown', p.x, p.y, { button: 1, buttons: 4 });
    expect(down.defaultPrevented).toBe(true);
    pointer(h.canvas, 'pointermove', p.x + 200, p.y, { button: 1, buttons: 4 });
    h.flush();
    expect(last(h).fromMs).toBeLessThan(s0.fromMs);
    pointer(h.canvas, 'pointerup', p.x + 200, p.y, { button: 1 });
    expect(h.commit.map((c) => c.gesture)).toEqual(['pan']);
  });

  it('right drag and Alt+left drag box-zoom', () => {
    for (const how of ['right', 'alt'] as const) {
      const h = setup({ size: [1_100, 240] });
      const p0 = last(h).plot;
      h.frame.resize(1_100 + 1_000 - p0.width, 240, 1);
      h.flush();
      const plot = last(h).plot;
      expect(plot.width).toBe(1_000);
      const o = how === 'right' ? { button: 2, buttons: 2 } : { altKey: true, buttons: 1 };
      const x = (ms: number): number => plot.x + ((ms - T0) / (T1 - T0)) * plot.width;
      const y = plot.y + plot.height / 2;
      pointer(h.canvas, 'pointerdown', x(T0 + 20 * 60_000 + 1_200), y, o);
      expect(h.canvas.dataset['gesture']).toBe('box');
      pointer(h.canvas, 'pointermove', x(T0 + 22 * 60_000), y, o);
      pointer(h.canvas, 'pointerup', x(T0 + 24 * 60_000 + 58_900), y, o);
      h.flush();
      expect(brushSnapUnit(3_600)).toBe(15_000);
      expect(h.brush).toEqual([
        { fromMs: T0 + 20 * 60_000, toMs: T0 + 25 * 60_000, gesture: 'drag' },
      ]);
      expect(h.commit).toEqual([]);
      pointer(h.canvas, 'pointerdown', 500, y, o);
      pointer(h.canvas, 'pointermove', 503, y, o);
      pointer(h.canvas, 'pointerup', 503, y, o);
      h.advance(10);
      expect(h.brush).toHaveLength(1);
      expect(h.commit).toEqual([]);
    }
  });

  it('context menu rules', () => {
    const menu = (h: Harness): boolean => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      h.canvas.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const R = { button: 2, buttons: 2 };
    const seen: boolean[] = [];
    // (1) contextmenu while the right button is down.
    let h = setup();
    let p = at(last(h), 0.5);
    pointer(h.canvas, 'pointerdown', p.x, p.y, R);
    seen.push(menu(h));
    const brush1 = h.brush.length;
    // (2) moved 50 px, released, then contextmenu.
    h = setup();
    p = at(last(h), 0.4);
    pointer(h.canvas, 'pointerdown', p.x, p.y, R);
    pointer(h.canvas, 'pointermove', p.x + 50, p.y, R);
    pointer(h.canvas, 'pointerup', p.x + 50, p.y, R);
    seen.push(menu(h));
    const brush2 = h.brush.length;
    // (3) no movement, released, then contextmenu.
    h = setup();
    p = at(last(h), 0.4);
    pointer(h.canvas, 'pointerdown', p.x, p.y, R);
    pointer(h.canvas, 'pointerup', p.x, p.y, R);
    seen.push(menu(h));
    const brush3 = h.brush.length;
    // (4) the keyboard menu key: no press.
    h = setup();
    seen.push(menu(h));
    // (5) a right press on the y-axis band.
    h = setup();
    const s = last(h);
    pointer(h.canvas, 'pointerdown', s.plot.x - 10, s.plot.y + 50, R);
    seen.push(menu(h));
    expect(seen).toEqual([true, true, true, false, false]);
    expect([brush1, brush2, brush3]).toEqual([0, 1, 0]);
  });

  it('macOS secondary click and touch ignored', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.5);
    const ctrl = pointer(h.canvas, 'pointerdown', p.x, p.y, { ctrlKey: true, buttons: 1 });
    pointer(h.canvas, 'pointermove', p.x + 100, p.y, { ctrlKey: true, buttons: 1 });
    pointer(h.canvas, 'pointerup', p.x + 100, p.y, { ctrlKey: true });
    const touch = pointer(h.canvas, 'pointerdown', p.x, p.y, { pointerType: 'touch' });
    pointer(h.canvas, 'pointermove', p.x + 100, p.y, { pointerType: 'touch' });
    pointer(h.canvas, 'pointerup', p.x + 100, p.y, { pointerType: 'touch' });
    h.flush();
    expect([ctrl.defaultPrevented, touch.defaultPrevented]).toEqual([false, false]);
    expect(winOf(last(h))).toEqual(winOf(s0));
    expect(h.commit).toEqual([]);
    expect(h.brush).toEqual([]);
  });

  // Code review r1 #2: a page scroll that passes over a plot keeps scrolling there, even while
  // the chart's own wheel gesture has not yet committed (Appendix A §A.10).
  it('scroll latch during a pending wheel gesture', () => {
    let pageAt = -Infinity;
    const h = setup({ latch: { lastPageWheel: () => pageAt } });
    const s0 = last(h);
    const p = at(s0, 0.5);
    const t = 10_000;
    const first = wheel(h.canvas, p.x, p.y, { deltaY: -100, timeStamp: t });
    h.flush();
    expect(first.defaultPrevented).toBe(true);
    const zoomed = last(h);
    // The pointer leaves the plot and the page scrolls (a wheel no chart consumed) …
    h.advance(50);
    pageAt = t + 50;
    // … and comes back over the plot within the idle period and the latch.
    h.advance(50);
    const back = wheel(h.canvas, p.x, p.y, { deltaY: -100, timeStamp: t + 100 });
    h.flush();
    expect(back.defaultPrevented).toBe(false);
    expect(last(h)).toEqual(zoomed);
    h.advance(300);
    expect(h.commit).toHaveLength(1);
  });

  // Code review r1 #3: a cancelled press releases the band hold, so measured labels return.
  it.each(['Escape', 'pointercancel', 'lostpointercapture'] as const)(
    'a cancelled press releases the band (%s)',
    (how) => {
      const target = document.createElement('div');
      const h = setup({ keyTarget: target });
      const s0 = last(h);
      const p = at(s0, 0.5);
      pointer(h.canvas, 'pointerdown', p.x, p.y, { buttons: 1 });
      pointer(h.canvas, 'pointermove', p.x + 150, p.y, { buttons: 1 });
      h.flush();
      // New data whose measured band is wider: kept out by the hold while the press runs.
      const small = lineData(0, 2e-5);
      h.frame.setData(small);
      h.flush();
      expect(last(h).plot.x).toBe(s0.plot.x);
      if (how === 'Escape') key(target, 'Escape');
      else h.canvas.dispatchEvent(new PointerEvent(how, { pointerId: 1 }));
      h.flush();
      const s = last(h);
      expect(winOf(s)).toEqual(winOf(s0));
      expect(s.plot.x).toBe(measuredX(LINE, small, winOf(s0), null));
      expect(s.plot.x).toBeGreaterThan(s0.plot.x);
    },
  );

  it('Escape and pointercancel cancel a press', () => {
    const target = document.createElement('div');
    const h = setup({ keyTarget: target });
    const s0 = last(h);
    const p = at(s0, 0.5);
    pointer(h.canvas, 'pointerdown', p.x, p.y, { buttons: 1 });
    pointer(h.canvas, 'pointermove', p.x + 150, p.y, { buttons: 1 });
    h.flush();
    expect(last(h).fromMs).not.toBe(s0.fromMs);
    const esc = key(target, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    h.flush();
    expect(winOf(last(h))).toEqual(winOf(s0));
    pointer(h.canvas, 'pointerup', p.x + 150, p.y);
    pointer(h.canvas, 'pointerdown', p.x, p.y, { button: 2, buttons: 2 });
    pointer(h.canvas, 'pointermove', p.x + 150, p.y, { button: 2, buttons: 2 });
    pointer(h.canvas, 'pointercancel', p.x + 150, p.y);
    pointer(h.canvas, 'pointerup', p.x + 150, p.y, { button: 2 });
    h.flush();
    expect(winOf(last(h))).toEqual(winOf(s0));
    expect(h.commit).toEqual([]);
    expect(h.brush).toEqual([]);
  });

  it('axis drags', () => {
    const h = setup();
    const s0 = last(h);
    const below = s0.plot.y + s0.plot.height + 10;
    const xa = s0.plot.x + 300;
    pointer(h.canvas, 'pointerdown', xa, below, { buttons: 1 });
    expect(h.canvas.dataset['gesture']).toBe('axis-x');
    pointer(h.canvas, 'pointermove', xa + 100, below, { buttons: 1 });
    pointer(h.canvas, 'pointerup', xa + 100, below);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.gesture).toBe('axis');
    expect(h.commit[0]?.value).toBeNull();
    expect(h.commit[0]?.window?.fromMs).toBeLessThan(s0.fromMs);
    h.flush();
    const s1 = last(h);
    const d0 = axisOf(s1);
    const left = s1.plot.x - 10;
    const ya = s1.plot.y + 100;
    pointer(h.canvas, 'pointerdown', left, ya, { buttons: 1 });
    expect(h.canvas.dataset['gesture']).toBe('axis-y');
    pointer(h.canvas, 'pointermove', left, ya - 50, { buttons: 1 });
    pointer(h.canvas, 'pointerup', left, ya - 50);
    expect(h.commit).toHaveLength(2);
    const c = h.commit[1];
    expect(c?.window).toBeNull();
    expect(c?.gesture).toBe('axis');
    const v = range(c?.value);
    const width = d0.max - d0.min;
    expect(v.min).toBeCloseTo(d0.min - (50 / s1.plot.height) * width, 9);
    expect(v.max).toBeCloseTo(d0.max - (50 / s1.plot.height) * width, 9);
  });

  it('value-axis double-click fits', () => {
    const h = setup({ spec: { ...LINE, valueRange: { min: 10, max: 20 } } });
    const s = last(h);
    expect(s.valueAxis).toEqual({ min: 10, max: 20, manual: true });
    pointer(h.canvas, 'dblclick', s.plot.x - 10, s.plot.y + 50);
    expect(h.commit).toEqual([{ window: null, value: 'auto', gesture: 'fit' }]);
    pointer(h.canvas, 'dblclick', s.plot.x + 100, s.plot.y + 50);
    expect(h.brush.at(-1)?.gesture).toBe('zoomOut');
  });

  it('setTimeWindow during a time gesture keeps the preview', () => {
    const h = setup();
    const p = at(last(h), 0.3);
    wheel(h.canvas, p.x, p.y, { deltaY: -200 });
    h.flush();
    const preview = winOf(last(h));
    h.frame.setTimeWindow({ fromMs: T1, toMs: T1 + 3_600_000 });
    h.flush();
    expect(winOf(last(h))).toEqual(preview);
    h.advance(300);
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.window).toEqual({
      fromMs: Math.round(preview.fromMs),
      toMs: Math.round(preview.toMs),
    });
  });

  it('external time update during a Y zoom', () => {
    for (const how of ['wheel', 'drag'] as const) {
      const h = setup();
      const s0 = last(h);
      const p = at(s0, 0.3);
      const left = s0.plot.x - 10;
      if (how === 'wheel') {
        wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
        wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
      } else {
        pointer(h.canvas, 'pointerdown', left, p.y, { buttons: 1 });
        pointer(h.canvas, 'pointermove', left, p.y - 30, { buttons: 1 });
      }
      h.frame.setTimeWindow({ fromMs: T1, toMs: T1 + 3_600_000 });
      h.flush();
      expect(winOf(last(h))).toEqual({ fromMs: T1, toMs: T1 + 3_600_000 });
      expect(last(h).valueAxis?.manual).toBe(true);
      if (how === 'wheel') {
        wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
        h.advance(300);
      } else {
        pointer(h.canvas, 'pointermove', left, p.y - 40, { buttons: 1 });
        pointer(h.canvas, 'pointerup', left, p.y - 40);
      }
      h.flush();
      expect(h.commit).toHaveLength(1);
      expect(h.commit[0]).toMatchObject({
        window: null,
        gesture: how === 'wheel' ? 'wheel' : 'axis',
      });
      expect(h.commit[0]?.value).toMatchObject({ min: expect.any(Number) as number });
      expect(winOf(last(h))).toEqual({ fromMs: T1, toMs: T1 + 3_600_000 });
    }
  });

  it('Y-only gestures never commit time', () => {
    const h = setup();
    const s0 = last(h);
    const p = at(s0, 0.3);
    for (let i = 0; i < 5; i++) wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true });
    h.advance(300);
    h.flush();
    const left = s0.plot.x - 10;
    pointer(h.canvas, 'pointerdown', left, p.y, { buttons: 1 });
    pointer(h.canvas, 'pointermove', left, p.y - 50, { buttons: 1 });
    pointer(h.canvas, 'pointerup', left, p.y - 50);
    expect(h.commit).toHaveLength(2);
    expect(h.commit.every((c) => c.window === null)).toBe(true);
  });

  it('wide chart commit at the minimum span', () => {
    const h0 = setup({ size: [4_000, 240] });
    const W = last(h0).plot.width;
    expect(W % 2).toBe(0);
    const T = T0;
    const h = setup({ size: [4_000, 240], w: { fromMs: T, toMs: T + 3 * W + 1 } });
    const s0 = last(h);
    const p = { x: s0.plot.x + W / 2, y: s0.plot.y + s0.plot.height / 2 };
    const ta = tAt(s0, p.x);
    for (let i = 0; i < 3; i++) wheel(h.canvas, p.x, p.y, { deltaY: -400 });
    h.flush();
    expect(last(h).fromMs).toBeCloseTo(T + W + 0.5, 6);
    h.advance(300);
    h.flush();
    expect(h.commit[0]?.window).toEqual({ fromMs: T + W + 1, toMs: T + 2 * W + 1 });
    expect(Math.abs(xOf(last(h), ta) - p.x)).toBeCloseTo(0.5, 6);
  });

  it('sub-minimum window: swipe, zoom-in, commit', () => {
    const T = T0;
    const h = setup({ size: [4_000, 240], w: { fromMs: T, toMs: T + 2_000 } });
    const s0 = last(h);
    expect(2_000).toBeLessThan(Math.ceil(s0.plot.width));
    const p = { x: s0.plot.x + 0.3 * s0.plot.width, y: s0.plot.y + s0.plot.height / 2 };
    wheel(h.canvas, p.x, p.y, { deltaX: 37 });
    h.flush();
    const v1 = winOf(last(h));
    const ta = tAt(last(h), p.x);
    expect(v1.fromMs - T).toBe(Math.round((37 / s0.plot.width) * 2_000));
    expect(Number.isInteger(v1.fromMs) && Number.isInteger(v1.toMs)).toBe(true);
    expect(v1.toMs - v1.fromMs).toBe(2_000);
    for (let i = 0; i < 2; i++) {
      wheel(h.canvas, p.x, p.y, { deltaY: -400 });
      h.flush();
      expect(winOf(last(h))).toEqual(v1);
    }
    h.advance(300);
    h.flush();
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.window).toEqual(v1);
    expect(Math.abs(xOf(last(h), ta) - p.x)).toBeLessThan(1e-6);
  });

  it('heatmap: no value zoom', () => {
    const spec: VisSpec = { kind: 'heatmap', title: 'T', unit: NONE, countUnit: NONE };
    const data: FrameData = {
      kind: 'heatmap',
      heatmap: {
        timestamps: new Float64Array([T0, T0 + 1_800_000]),
        bounds: new Float64Array([5, 10, Infinity]),
        counts: new Float64Array([0, 5, 10, 10, 0, 1]),
      },
    };
    const h = setup({ spec, data });
    const s0 = last(h);
    expect(s0.valueAxis).toBeNull();
    const p = at(s0, 0.5);
    expect(wheel(h.canvas, p.x, p.y, { deltaY: -100, shiftKey: true }).defaultPrevented).toBe(true);
    h.flush();
    expect(last(h)).toEqual(s0);
    pointer(h.canvas, 'pointerdown', s0.plot.x - 10, p.y, { buttons: 1 });
    pointer(h.canvas, 'pointermove', s0.plot.x - 10, p.y - 50, { buttons: 1 });
    pointer(h.canvas, 'pointerup', s0.plot.x - 10, p.y - 50);
    h.advance(300);
    h.flush();
    expect(last(h)).toEqual(s0);
    expect(h.commit).toEqual([]);
  });

  it('zones in the dataset', () => {
    const h = setup();
    const s = last(h);
    const seen: (string | undefined)[] = [];
    for (const [x, y] of [
      [s.plot.x + 50, s.plot.y + 50],
      [s.plot.x + 50, s.plot.y + s.plot.height + 10],
      [s.plot.x - 10, s.plot.y + 50],
      [s.plot.x + s.plot.width + 4, s.plot.y + 50],
    ] as const) {
      pointer(h.canvas, 'pointermove', x, y);
      seen.push(h.canvas.dataset['zone']);
    }
    expect(seen).toEqual(['plot', 'x-axis', 'y-axis', undefined]);
  });

  it('dispose during a wheel gesture', () => {
    const h = setup();
    const off = vi.spyOn(h.canvas, 'removeEventListener');
    const p = at(last(h), 0.5);
    wheel(h.canvas, p.x, p.y, { deltaY: -100 });
    h.frame.dispose();
    h.advance(400);
    expect(h.commit).toEqual([]);
    expect(off).toHaveBeenCalledTimes(12);
  });

  it('sub-minimum preview survives a wider external window', () => {
    const T = T0;
    const h = setup({ size: [4_000, 240], w: { fromMs: T, toMs: T + 2_000 } });
    const s0 = last(h);
    expect(2_000).toBeLessThan(Math.ceil(s0.plot.width));
    const p = { x: s0.plot.x + 0.3 * s0.plot.width, y: s0.plot.y + s0.plot.height / 2 };
    wheel(h.canvas, p.x, p.y, { deltaX: 37 });
    h.flush();
    const v1 = winOf(last(h));
    expect(Number.isInteger(v1.fromMs) && Number.isInteger(v1.toMs)).toBe(true);
    expect(v1.toMs - v1.fromMs).toBe(2_000);
    h.frame.setTimeWindow({ fromMs: T, toMs: T + 3_600_000 });
    h.flush();
    expect(Number.isInteger((13 / s0.plot.width) * 2_000)).toBe(false);
    wheel(h.canvas, p.x, p.y, { deltaX: 13 });
    h.flush();
    const v2 = winOf(last(h));
    const ta = tAt(last(h), p.x);
    expect(Number.isInteger(v2.fromMs) && Number.isInteger(v2.toMs)).toBe(true);
    expect(v2.toMs - v2.fromMs).toBe(2_000);
    for (let i = 0; i < 2; i++) {
      wheel(h.canvas, p.x, p.y, { deltaY: -400 });
      h.flush();
      expect(winOf(last(h))).toEqual(v2);
    }
    h.advance(300);
    h.flush();
    expect(h.commit).toHaveLength(1);
    expect(h.commit[0]?.window).toEqual(v2);
    expect(Math.abs(xOf(last(h), ta) - p.x)).toBeLessThan(1e-6);
    h.frame.setTimeWindow(v2);
    h.flush();
    expect(winOf(last(h))).toEqual(v2);
  });
});
