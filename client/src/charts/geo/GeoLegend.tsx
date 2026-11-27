/**
 * The geomap legend (T24-090, T24-092, T24-093; plan #234 Part 3 §4.2): with two groups or more, one
 * button per entry with its swatch and label, "(not shown)" when none of its rows is on the map;
 * the aggregate reads `other (n): ‹first 8 member labels›, +k more`. An own group selects its keys
 * (`member`); the aggregate inspects (an `aggregate` target). In the Tab order after the list.
 */
import type { JSX, MouseEvent } from 'react';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import type { GeoGroup, GeoRowSet } from '../../vis/geo/frame';
import styles from '../GeoMapFrame.module.css';

/** The aggregate entry names this many members before "+k more". */
const MEMBER_NAMES = 8;

export interface GeoLegendProps {
  readonly title: string;
  readonly rows: GeoRowSet;
  /** An own group: its rows' keys. */
  readonly onGroup: (keys: readonly string[]) => void;
  /** The aggregate `other (n)`. */
  readonly onAggregate: (source: 'pointer' | 'keyboard', el: HTMLElement) => void;
}

/** A legend entry's text (T24-090). */
export function legendText(g: GeoGroup, shown: boolean): string {
  if (g.members !== null) {
    const labels = g.memberLabels ?? [];
    const names = labels.slice(0, MEMBER_NAMES);
    const more = labels.length - names.length;
    const list = more > 0 ? [...names, t('geo.legend.more', { k: more })] : names;
    return t('geo.legend.other', { label: g.label, members: list.join(', ') });
  }
  return shown ? g.label : t('geo.legend.notShown', { label: g.label });
}

const SWATCHES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'] as const;

export function GeoLegend({
  title,
  rows,
  onGroup,
  onAggregate,
}: GeoLegendProps): JSX.Element | null {
  if (rows.groups.length < 2) return null;
  return (
    <ul
      className={cx(styles['legend'])}
      aria-label={t('geo.legend.label', { title })}
      data-geo-legend=""
    >
      {rows.groups.map((g, j) => {
        const own = rows.rows.filter((r) => r.group === j);
        const shown = own.some((r) => r.draw === 'shown');
        const swatch =
          g.colourIndex === null ? styles['other'] : styles[SWATCHES[g.colourIndex % 8] ?? 's1'];
        const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
          if (g.members !== null)
            onAggregate(e.detail === 0 ? 'keyboard' : 'pointer', e.currentTarget);
          else onGroup(own.map((r) => r.key));
        };
        return (
          <li key={JSON.stringify(g.id)}>
            <button
              type="button"
              className={cx(styles['entry'])}
              data-geo-legend-entry=""
              data-pattern={g.pattern}
              onClick={onClick}
            >
              <span className={cx(styles['swatch'], swatch)} aria-hidden="true" />
              <span className={cx(styles['entryText'])}>{legendText(g, shown)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
