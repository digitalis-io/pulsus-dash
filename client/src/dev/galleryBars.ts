/**
 * The gallery's bar charts (plan #173 Part 2 §4.5; T22 §10.3): five `barchartModel`s drawn through
 * `CategoryChart`, `size.chart` high and horizontal. Kept apart from `gallery.ts`, whose frame
 * entries the engine-fixture generator loads in Node.
 */
import type { ExploreResult } from '../vis/autovis';
import { barchartModel, type BarchartModel } from '../vis/barchart';
import type { Thresholds } from '../vis/thresholds';
import type { VisOptions } from '../api/types';
import { t } from '../i18n/t';
import { BY_VERSION, dupes, fkey, instant, many } from './categorySynth';

export type BarchartGalleryId =
  'barchart' | 'barchart-thresholds' | 'barchart-dupes' | 'barchart-subset' | 'barchart-cap';

export interface BarchartGalleryEntry {
  readonly id: BarchartGalleryId;
  readonly model: BarchartModel;
}

const WATCH_FAILING: Thresholds = {
  direction: 'above',
  steps: [
    { value: 30, state: 'watch', label: '' },
    { value: 100, state: 'failing', label: '' },
  ],
};

function model(
  r: ExploreResult,
  title: string,
  o: { options?: VisOptions; thresholds?: Thresholds } = {},
): BarchartModel {
  if (r.kind === 'string') throw new Error('a gallery bar chart needs series');
  return barchartModel(r, {
    title,
    rateApplied: false,
    options: o.options,
    thresholds: o.thresholds ?? null,
  });
}

/** `many` (T22 §10.2) as a model: 250 rows 250…1, states set directly (only the 10 is failing). */
function manyModel(): BarchartModel {
  const rows = many();
  const r = instant(rows.map((x) => ({ key: x.key, labels: x.labels, value: x.value })));
  return { ...model(r, t('gallery.barchartCap')), all: rows };
}

/** The five entries in table order. */
export function galleryBarcharts(): BarchartGalleryEntry[] {
  return [
    { id: 'barchart', model: model(instant(BY_VERSION), t('gallery.barchart')) },
    {
      id: 'barchart-thresholds',
      model: model(
        instant([...BY_VERSION, { labels: { version: '2.28' }, value: -20 }]),
        t('gallery.barchartThresholds'),
        { thresholds: WATCH_FAILING },
      ),
    },
    {
      id: 'barchart-dupes',
      model: model(dupes(), t('gallery.barchartDupes'), { options: { categoryBy: 'version' } }),
    },
    {
      id: 'barchart-subset',
      model: model(
        instant([
          { key: fkey(1), labels: { version: '2.31' }, value: 40 },
          { key: fkey(2), labels: { version: '2.31', region: '∅' }, value: 60 },
        ]),
        t('gallery.barchartSubset'),
        { options: { categoryBy: 'version' } },
      ),
    },
    { id: 'barchart-cap', model: manyModel() },
  ];
}
