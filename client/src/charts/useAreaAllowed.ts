/**
 * Whether a chart may draw its area (#282 Part 2b §4.3; ADR-0036, T08-019): false while forced
 * colours are active or reduced transparency is asked for, true otherwise and without
 * `matchMedia`. It follows each query's `change`. The area repeats the series hue and encodes
 * nothing, so greyscale needs nothing, and nothing animates.
 */
import { useEffect, useState } from 'react';

const QUERIES = ['(forced-colors: active)', '(prefers-reduced-transparency: reduce)'] as const;

function allowed(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return true;
  return QUERIES.every((q) => !globalThis.matchMedia(q).matches);
}

export function useAreaAllowed(): boolean {
  const [ok, setOk] = useState(allowed);
  useEffect(() => {
    if (typeof globalThis.matchMedia !== 'function') return undefined;
    const lists = QUERIES.map((q) => globalThis.matchMedia(q));
    const on = (): void => {
      setOk(allowed());
    };
    for (const l of lists) l.addEventListener('change', on);
    on();
    return () => {
      for (const l of lists) l.removeEventListener('change', on);
    };
  }, []);
  return ok;
}
