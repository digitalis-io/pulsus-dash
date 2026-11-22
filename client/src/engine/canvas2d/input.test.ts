import { describe, expect, it } from 'vitest';
import {
  isPinch,
  PINCH_ZOOM_PER_PX,
  pressKind,
  WHEEL_ZOOM_PER_PX,
  wheelIntent,
  windowWheelLatch,
  zoneOf,
} from './input';

const PLOT = { x: 50, y: 8, width: 740, height: 200 };
const K = WHEEL_ZOOM_PER_PX;
const W = (o: Partial<WheelEvent>) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...o,
});

describe('wheelIntent table', () => {
  it('pinch: ctrl with a fractional deltaY zooms time only', () => {
    expect(wheelIntent(W({ ctrlKey: true, deltaY: -2.5 }), PLOT)).toEqual({
      kind: 'zoom',
      x: true,
      y: false,
      factor: Math.exp(-2.5 * PINCH_ZOOM_PER_PX),
    });
  });
  it('ctrl or meta with whole steps zooms both axes', () => {
    expect(wheelIntent(W({ ctrlKey: true, deltaY: -100 }), PLOT)).toEqual({
      kind: 'zoom',
      x: true,
      y: true,
      factor: Math.exp(-100 * K),
    });
    expect(wheelIntent(W({ metaKey: true, deltaY: -2.5 }), PLOT)).toEqual({
      kind: 'zoom',
      x: true,
      y: true,
      factor: Math.exp(-2.5 * K),
    });
  });
  it('shift zooms values, from deltaX when deltaY is 0', () => {
    expect(wheelIntent(W({ shiftKey: true, deltaY: 100 }), PLOT)).toEqual({
      kind: 'zoom',
      x: false,
      y: true,
      factor: Math.exp(100 * K),
    });
    expect(wheelIntent(W({ shiftKey: true, deltaX: -50 }), PLOT)).toEqual({
      kind: 'zoom',
      x: false,
      y: true,
      factor: Math.exp(-50 * K),
    });
  });
  it('a horizontal swipe pans time', () => {
    expect(wheelIntent(W({ deltaX: 80, deltaY: 5 }), PLOT)).toEqual({
      kind: 'panX',
      fraction: 80 / PLOT.width,
    });
  });
  it('a plain wheel zooms time; no delta is no intent', () => {
    expect(wheelIntent(W({ deltaY: -100 }), PLOT)).toEqual({
      kind: 'zoom',
      x: true,
      y: false,
      factor: Math.exp(-100 * K),
    });
    expect(wheelIntent(W({}), PLOT)).toBeNull();
  });
});

describe('documented pinch misclassifications', () => {
  it('a fractional mouse step is a pinch; a whole-step pinch zooms both', () => {
    expect(isPinch(W({ ctrlKey: true, deltaY: -100.5 }))).toBe(true);
    expect(wheelIntent(W({ ctrlKey: true, deltaY: -100.5 }), PLOT)).toMatchObject({
      kind: 'zoom',
      x: true,
      y: false,
    });
    expect(isPinch(W({ ctrlKey: true, deltaY: -3 }))).toBe(false);
    expect(wheelIntent(W({ ctrlKey: true, deltaY: -3 }), PLOT)).toMatchObject({
      kind: 'zoom',
      x: true,
      y: true,
    });
  });
});

describe('delta modes and clamp', () => {
  it('lines are 16 px, pages the plot height, and |px| ≤ 400', () => {
    const f = (o: Partial<WheelEvent>): number => {
      const i = wheelIntent(W(o), PLOT);
      return i?.kind === 'zoom' ? i.factor : NaN;
    };
    expect(f({ deltaMode: 1, deltaY: 3 })).toBeCloseTo(Math.exp(48 * K), 12);
    expect(f({ deltaMode: 2, deltaY: 1 })).toBeCloseTo(Math.exp(PLOT.height * K), 12);
    expect(f({ deltaMode: 0, deltaY: 5_000 })).toBeCloseTo(Math.exp(400 * K), 12);
    expect(f({ deltaMode: 0, deltaY: -5_000 })).toBeCloseTo(Math.exp(-400 * K), 12);
  });
});

describe('zoneOf and pressKind', () => {
  it('zones: plot, the bands below and left of it, else none', () => {
    expect(zoneOf({ x: 50, y: 8 }, PLOT, 'line')).toBe('plot');
    expect(zoneOf({ x: 790, y: 208 }, PLOT, 'line')).toBe('plot');
    expect(zoneOf({ x: 300, y: 220 }, PLOT, 'line')).toBe('x-axis');
    expect(zoneOf({ x: 20, y: 100 }, PLOT, 'line')).toBe('y-axis');
    expect(zoneOf({ x: 20, y: 100 }, PLOT, 'bars')).toBe('y-axis');
    expect(zoneOf({ x: 20, y: 100 }, PLOT, 'heatmap')).toBeNull();
    expect(zoneOf({ x: 795, y: 100 }, PLOT, 'line')).toBeNull();
    expect(zoneOf({ x: 20, y: 220 }, PLOT, 'line')).toBeNull();
    expect(zoneOf({ x: 300, y: 2 }, PLOT, 'line')).toBeNull();
  });
  it('press kinds by button, modifiers and zone', () => {
    const P = (o: Partial<PointerEvent>) => ({
      button: 0,
      pointerType: 'mouse',
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      ...o,
    });
    expect(pressKind(P({}), 'plot')).toBe('pan');
    expect(pressKind(P({ button: 1 }), 'plot')).toBe('pan');
    expect(pressKind(P({ button: 2 }), 'plot')).toBe('box');
    expect(pressKind(P({ altKey: true }), 'plot')).toBe('box');
    expect(pressKind(P({}), 'x-axis')).toBe('pan');
    expect(pressKind(P({ button: 1 }), 'x-axis')).toBe('pan');
    expect(pressKind(P({ button: 2 }), 'x-axis')).toBeNull();
    expect(pressKind(P({}), 'y-axis')).toBe('pan-y');
    expect(pressKind(P({ button: 2 }), 'y-axis')).toBeNull();
    expect(pressKind(P({ ctrlKey: true }), 'plot')).toBeNull();
    expect(pressKind(P({ ctrlKey: true, metaKey: true }), 'plot')).toBe('pan');
    expect(pressKind(P({ pointerType: 'touch' }), 'plot')).toBeNull();
    expect(pressKind(P({}), null)).toBeNull();
  });
});

describe('windowWheelLatch', () => {
  it('records the time of the last wheel no listener prevented', () => {
    const latch = windowWheelLatch(globalThis);
    const div = document.createElement('div');
    document.body.append(div);
    const first = new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true });
    Object.defineProperty(first, 'timeStamp', { value: 1_234 });
    div.dispatchEvent(first);
    expect(latch.lastPageWheel()).toBe(1_234);
    const stop = (e: Event): void => {
      e.preventDefault();
    };
    div.addEventListener('wheel', stop);
    const second = new WheelEvent('wheel', { deltaY: 10, bubbles: true, cancelable: true });
    Object.defineProperty(second, 'timeStamp', { value: 2_000 });
    div.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(true);
    expect(latch.lastPageWheel()).toBe(1_234);
    div.removeEventListener('wheel', stop);
    div.remove();
  });
});
