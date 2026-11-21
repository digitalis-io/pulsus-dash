/**
 * A `ResizeObserver` stand-in for jsdom: tests trigger `resizeAll(width, height)`, or `resizeOf(el,
 * width, height)` for the observers of one element.
 */
type Callback = (entries: ResizeObserverEntry[], o: ResizeObserver) => void;

const live = new Set<FakeResizeObserver>();

export class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly cb: Callback) {
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
  fire(width: number, height: number, only?: Element): void {
    const targets =
      only === undefined ? [...this.targets] : [...this.targets].filter((t) => t === only);
    const entries = targets.map(
      (target) => ({ target, contentRect: { width, height } }) as unknown as ResizeObserverEntry,
    );
    if (entries.length > 0) this.cb(entries, this);
  }
}

export function installResizeObserver(): void {
  live.clear();
  globalThis.ResizeObserver = FakeResizeObserver;
}

export function resizeAll(width: number, height: number): void {
  for (const o of [...live]) o.fire(width, height);
}

export function liveObservers(): number {
  return live.size;
}

/** Fires only the observers whose targets include `el`, with an entry for `el`. */
export function resizeOf(el: Element, width: number, height: number): void {
  for (const o of [...live]) if (o.targets.has(el)) o.fire(width, height, el);
}
