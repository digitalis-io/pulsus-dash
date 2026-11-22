import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installIntersectionObserver,
  observedCount,
  setVisible,
  uninstallIntersectionObserver,
} from '../test/fakeIntersectionObserver';
import { renderRouted } from '../test/routedHarness';
import { BoardRunProvider } from './boardRun';
import { createVisibilityTracker, useInViewport } from './visibility';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visibility tracker', () => {
  it('callbacks per target; unobserve on cleanup', () => {
    installIntersectionObserver();
    const tracker = createVisibilityTracker();
    const a = document.createElement('div');
    const b = document.createElement('div');
    const seenA: boolean[] = [];
    const seenB: boolean[] = [];
    const offA = tracker.observe(a, (v) => seenA.push(v));
    tracker.observe(b, (v) => seenB.push(v));
    expect(observedCount()).toBe(2);
    expect(seenA).toEqual([]);
    setVisible(a, true);
    setVisible(b, true);
    setVisible(a, false);
    expect(seenA).toEqual([true, false]);
    expect(seenB).toEqual([true]);
    offA();
    expect(observedCount()).toBe(1);
    setVisible(a, true);
    expect(seenA).toEqual([true, false]);
    tracker.disconnect();
    expect(observedCount()).toBe(0);
  });

  it('absent observer: visible at once', () => {
    uninstallIntersectionObserver();
    const tracker = createVisibilityTracker();
    const seen: boolean[] = [];
    tracker.observe(document.createElement('div'), (v) => seen.push(v));
    expect(seen).toEqual([true]);
  });

  it('useInViewport: false until reported, then follows', () => {
    installIntersectionObserver();
    const states: boolean[] = [];
    function Probe({ el }: { el: Element | null }) {
      states.push(useInViewport(el));
      return null;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const { view } = renderRouted(
      <BoardRunProvider tenant="demo" vars={new Map()} timeReady={false}>
        <Probe el={host} />
      </BoardRunProvider>,
      { url: '/?from=now-1h&to=now&refresh=off' },
    );
    expect(states.at(-1)).toBe(false);
    expect(observedCount()).toBe(1);
    setVisible(host, true);
    expect(states.at(-1)).toBe(true);
    view.unmount();
    expect(observedCount()).toBe(0);
    host.remove();
  });
});
