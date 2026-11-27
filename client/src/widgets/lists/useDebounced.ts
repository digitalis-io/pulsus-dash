/**
 * A value that follows `value` `ms` after its last change (plan #216 Part 2b §3.1): the first value
 * at once, then each new one once `value` has held for `ms`. The Board list editor's preview reads
 * the draft through it, so typing costs one request per pause, not one per key. The timer is
 * cleared on every change and on unmount.
 */
import { useEffect, useState } from 'react';

export function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setShown(() => value);
    }, ms);
    return () => {
      clearTimeout(id);
    };
  }, [value, ms]);
  return shown;
}
