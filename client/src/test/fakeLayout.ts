/**
 * Layout for `LogStream` in jsdom (plan #66 Part B §2): jsdom lays nothing out, so the scroller
 * (`[data-log-scroller]`) gets fixed `offsetWidth`/`offsetHeight` and `clientWidth`/`clientHeight`
 * (the virtualiser reads the client box). Other elements keep jsdom's 0. Returns a restore function.
 */
export function installLayout(size: { width: number; height: number }): () => void {
  const names = ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const;
  const saved = names.map(
    (n) => [n, Object.getOwnPropertyDescriptor(HTMLElement.prototype, n)] as const,
  );
  for (const n of names) {
    const base =
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, n) ??
      Object.getOwnPropertyDescriptor(Element.prototype, n);
    Object.defineProperty(HTMLElement.prototype, n, {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.hasAttribute('data-log-scroller')) {
          return n.endsWith('Width') ? size.width : size.height;
        }
        const v: unknown = base?.get?.call(this);
        return typeof v === 'number' ? v : 0;
      },
    });
  }
  return () => {
    for (const [n, d] of saved) {
      if (d === undefined) Reflect.deleteProperty(HTMLElement.prototype, n);
      else Object.defineProperty(HTMLElement.prototype, n, d);
    }
  };
}

/**
 * Layout for `PanelTable` in jsdom (plan #173 Part 3b): every grid (`[role=grid]`, the virtualiser's
 * scroller) is `size`; other elements keep jsdom's 0. Returns a restore function.
 */
export function installGridLayout(
  size: { width: number; height: number } = { width: 600, height: 280 },
): () => void {
  const names = ['offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const;
  const saved = names.map(
    (n) => [n, Object.getOwnPropertyDescriptor(HTMLElement.prototype, n)] as const,
  );
  for (const n of names) {
    const base =
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, n) ??
      Object.getOwnPropertyDescriptor(Element.prototype, n);
    Object.defineProperty(HTMLElement.prototype, n, {
      configurable: true,
      get(this: HTMLElement): number {
        if (this.getAttribute('role') === 'grid') {
          return n.endsWith('Width') ? size.width : size.height;
        }
        const v: unknown = base?.get?.call(this);
        return typeof v === 'number' ? v : 0;
      },
    });
  }
  return () => {
    for (const [n, d] of saved) {
      if (d === undefined) Reflect.deleteProperty(HTMLElement.prototype, n);
      else Object.defineProperty(HTMLElement.prototype, n, d);
    }
  };
}
