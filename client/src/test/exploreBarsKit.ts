/** `byVersion` (T22 §10.2) as an Explore range answer, for the bar chart tests (#173 Part 3b). */
import type { RangeResult } from '../data/decode';
import { EMPTY_COMPLETENESS, plannedAs, range, ser } from './exploreTestKit';

export const BARS_Q = 'sum by (version) (app_version)';

const VERSIONS = ['2.29', '2.30', '2.31', '2.32', '2.33'] as const;
const VALUES = [40, 7, 120, 3, 15] as const;

/** `{version=2.29…2.33}` = 40, 7, 120, 3, 15 at both samples; the keys are `fkey(1…5)`. */
export const BY_VERSION_RANGE: RangeResult = range(
  VERSIONS.map((version, i) => ser(i + 1, { version }, [VALUES[i] ?? 0, VALUES[i] ?? 0])),
  EMPTY_COMPLETENESS,
  plannedAs(BARS_Q),
);
