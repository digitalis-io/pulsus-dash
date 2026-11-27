/**
 * The geomap host's status texts (T24 §4.12, §4.13; plan #234 Part 3 §4.6). The value and draw
 * status texts live with the Inspector's geo model (the board route holds it) and are re-exported
 * here for the host.
 */
import type { FrameDataIssue } from '../../data/frames';
import { t } from '../../i18n/t';

export { drawStatusText, valueStatusText } from '../../inspector/geoModel';

/** "Invalid map data (‹detail›)": the failing `validateGeoRows` check, or the issue's code. */
export function invalidText(issue: FrameDataIssue): string {
  return t('geo.state.invalid', { detail: issue.code === 'geo' ? issue.detail : issue.code });
}
