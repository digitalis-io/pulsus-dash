/**
 * The coverage meter under a categorical chart (VIZ-027, T22-006; plan #173 Part 2 §4.4): one line
 * of `coverageText`.
 */
import type { JSX } from 'react';
import type { Coverage } from '../data/frames';

export function CoverageMeter(p: { coverage: Coverage; onNarrow: () => void }): JSX.Element {
  void p;
  return <p data-coverage-meter="" />;
}
