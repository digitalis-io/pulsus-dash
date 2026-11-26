/** A board list's summary facts (plan #216 Part 1 §4.3; T24-026). */
import type { BoardListMode } from '../../api/types';
import type { SummaryFacts } from '../../engine/api';
import { t } from '../../i18n/t';
import type { ListSnapshot } from '../lists/snapshot';
import type { BoardRow } from './rows';

const counts = new Intl.NumberFormat('en-GB');

/**
 * `current` = `‹N›[+] boards` (`+` when truncated) with ` (coverage unknown)`, ` (stale)` or both,
 * and the mode's label as its series; `subject` the title; the other members null. Null without a
 * snapshot.
 */
export function boardListFacts(
  title: string,
  mode: BoardListMode,
  s: ListSnapshot<BoardRow> | null,
): SummaryFacts | null {
  if (s === null) return null;
  const c = s.coverage;
  const n = counts.format(s.rows.length);
  const unknown = c.unknown !== undefined;
  const stale = c.staleAtMs !== undefined && c.staleAtMs !== null;
  let text = t(c.query.truncated ? 'boardList.factsMore' : 'boardList.facts', { n });
  if (unknown && stale) text += t('boardList.factsUnknownStale');
  else if (unknown) text += t('boardList.factsUnknown');
  else if (stale) text += t('boardList.factsStale');
  return {
    subject: title,
    current: { text, series: t(`boardList.mode.${mode}`) },
    change: null,
    extent: null,
    baselineRatio: null,
  };
}
