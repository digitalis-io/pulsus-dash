/**
 * The chart gallery (development and stub builds only; plan #58 §4.5): every interim chart kind on
 * seeded synthetic data for the Context window. The corpus of `golden:interim-gallery`.
 */
import { useMemo } from 'react';
import { ChartFrame } from '../charts/ChartFrame';
import { t } from '../i18n/t';
import { Card } from '../kit/Card';
import { cx } from '../kit/cx';
import { ContextSummary } from '../shell/ContextSummary';
import { usePageTitle } from '../shell/PageTitle';
import { useTimeContext } from '../state/useTimeContext';
import styles from './GalleryPage.module.css';
import { GALLERY_SEED, galleryEntries } from './gallery';

export function GalleryPage() {
  usePageTitle(t('gallery.title'));
  const { fromMs, toMs } = useTimeContext().window;
  const entries = useMemo(() => galleryEntries({ fromMs, toMs }), [fromMs, toMs]);
  return (
    <div className={cx(styles['page'])}>
      <p className={cx(styles['intro'])}>{t('gallery.intro', { seed: GALLERY_SEED })}</p>
      <ContextSummary />
      <div className={cx(styles['charts'])}>
        {entries.map((e) => (
          <Card key={e.id} title={e.spec.title}>
            <div data-gallery-id={e.id}>
              <ChartFrame spec={e.spec} data={e.data} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
