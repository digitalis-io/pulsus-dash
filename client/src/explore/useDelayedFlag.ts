/** True once `on` has been true for `delayMs` (the Explore shimmer, plan #63 Part C §4.1). */
import { useEffect, useState } from 'react';

export function useDelayedFlag(on: boolean, delayMs: number): boolean {
  const [late, setLate] = useState(false);
  const [wasOn, setWasOn] = useState(on);
  // Adjusted while rendering (not in an effect): each new `on` period starts not late.
  if (on !== wasOn) {
    setWasOn(on);
    setLate(false);
  }
  useEffect(() => {
    if (!on) return;
    const id = setTimeout(() => {
      setLate(true);
    }, delayMs);
    return () => {
      clearTimeout(id);
    };
  }, [on, delayMs]);
  return on && late;
}
