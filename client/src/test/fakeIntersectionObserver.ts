/**
 * An `IntersectionObserver` stand-in for jsdom (plan #64 A.7): targets start not intersecting;
 * `setVisible(el, visible)` reports a change to every observer of `el`.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';

type Callback = (entries: IntersectionObserverEntry[], o: IntersectionObserver) => void;

const live = new Set<FakeIntersectionObserver>();

class FakeIntersectionObserver {
  readonly targets = new Set<Element>();
  readonly root = null;
  readonly rootMargin: string;
  readonly thresholds: readonly number[];
  constructor(
    private readonly cb: Callback,
    o: IntersectionObserverInit = {},
  ) {
    this.rootMargin = o.rootMargin ?? '0px';
    this.thresholds = [typeof o.threshold === 'number' ? o.threshold : 0];
    live.add(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
    live.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(el: Element, visible: boolean): void {
    if (!this.targets.has(el)) return;
    const entry = { target: el, isIntersecting: visible } as unknown as IntersectionObserverEntry;
    this.cb([entry], this as unknown as IntersectionObserver);
  }
}

export function installIntersectionObserver(): void {
  live.clear();
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
}

export function uninstallIntersectionObserver(): void {
  live.clear();
  vi.stubGlobal('IntersectionObserver', undefined);
}

export function setVisible(el: Element, visible: boolean): void {
  act(() => {
    for (const o of [...live]) o.fire(el, visible);
  });
}

/** The targets observed now, over every live observer. */
export function observedCount(): number {
  let n = 0;
  for (const o of live) n += o.targets.size;
  return n;
}
