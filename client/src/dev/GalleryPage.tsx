/**
 * The chart gallery (development and stub builds only; plan #58 §4.5): every interim chart kind on
 * seeded synthetic data for the Context window, then the bar charts through `CategoryChart`
 * (plan #173 Part 2 §4.5). The corpus of `golden:interim-gallery` and `golden:greyscale`.
 * `&bench=categories` shows only `barchart-cap`, 600 px wide with a 2 800 px category extent (200
 * bars), for `bench:frame-interim-categories`.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation } from 'react-router';
import { CategoryChart } from '../charts/CategoryChart';
import { ChartFrame } from '../charts/ChartFrame';
import { BOTTOM } from '../engine/canvas2d/layout';
import { t } from '../i18n/t';
import { Card } from '../kit/Card';
import { cx } from '../kit/cx';
import { ContextSummary } from '../shell/ContextSummary';
import { usePageTitle } from '../shell/PageTitle';
import { useTimeContext } from '../state/useTimeContext';
import { size, space } from '../styles/tokens';
import styles from './GalleryPage.module.css';
import { GALLERY_SEED, galleryEntries } from './gallery';
import { galleryBarcharts, type BarchartGalleryEntry } from './galleryBars';

const NARROW = (): void => undefined;

/** The bench cell: 600 × (2 800 + the plot's top gap + the axis below) and the meter line. */
const BENCH_W = 600;
const BENCH_H = 2_800 + space['2'] + BOTTOM + size.control;

function BarchartCard({ e, bench }: { e: BarchartGalleryEntry; bench: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // CSSOM, not inline styles (CSP style-src, T01-010).
    const el = ref.current;
    if (el === null || !bench) return;
    el.style.width = `${String(BENCH_W)}px`;
    el.style.height = `${String(BENCH_H)}px`;
  }, [bench]);
  return (
    <Card title={e.model.spec.title}>
      <div ref={ref} data-gallery-id={e.id} className={cx(styles['barchart'])}>
        <CategoryChart model={e.model} title={e.model.spec.title} onNarrow={NARROW} />
      </div>
    </Card>
  );
}

export function GalleryPage() {
  usePageTitle(t('gallery.title'));
  const { fromMs, toMs } = useTimeContext().window;
  const bench = new URLSearchParams(useLocation().search).get('bench') === 'categories';
  const entries = useMemo(() => galleryEntries({ fromMs, toMs }), [fromMs, toMs]);
  const bars = useMemo(() => galleryBarcharts(), []);
  return (
    <div className={cx(styles['page'])}>
      <p className={cx(styles['intro'])}>{t('gallery.intro', { seed: GALLERY_SEED })}</p>
      <ContextSummary />
      <div className={cx(styles['charts'])}>
        {!bench &&
          entries.map((e) => (
            <Card key={e.id} title={e.spec.title}>
              <div data-gallery-id={e.id}>
                <ChartFrame
                  spec={e.spec}
                  data={e.data}
                  {...(e.events === undefined ? {} : { events: e.events })}
                />
              </div>
            </Card>
          ))}
        {bars
          .filter((e) => !bench || e.id === 'barchart-cap')
          .map((e) => (
            <BarchartCard key={e.id} e={e} bench={bench} />
          ))}
      </div>
    </div>
  );
}
