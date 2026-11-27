/**
 * The geomap gallery (development and stub builds only; plan #234 Part 3 §2, §5; VIZ-069): the map
 * host on fixture results at 1024 × 512, `?page=` geomap-markers (G), geomap-groups (H),
 * geomap-states (G with thresholds, colour by group and by state), geomap-offline (no rows, the
 * bundled basemap at Dublin) and geomap-bench (Cap: 5 000 drawn). Gazetteer T places the fixtures.
 * The host is the lazy board chunk's own (`GeoMapFrame`), imported dynamically here too.
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { usePageTitle } from '../shell/PageTitle';
import { size as tokenSize } from '../styles/tokens';
import { loadGeoData } from '../vis/geo/assets';
import { gazT } from '../vis/geo/fixtures/series';
import type { GeoData } from '../vis/geo/types';
import {
  galleryRun,
  GEO_GALLERY_H,
  GEO_GALLERY_UNIT,
  GEO_GALLERY_W,
  geoGalleryEntries,
  geoGalleryPage,
  type GeoGalleryEntry,
} from './galleryGeo';
import styles from './GeoGalleryPage.module.css';

const GeoMapFrame = lazy(() => import('../charts/GeoMapFrame'));

const px = (n: number): string => `${String(n)}px`;

function GalleryMap({ e, geoData }: { e: GeoGalleryEntry; geoData: GeoData }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useRef({ width: GEO_GALLERY_W, height: GEO_GALLERY_H });
  const run = useMemo(() => galleryRun(e.series), [e.series]);
  // Placed through CSSOM (CSP style-src, T01-010).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.width = px(GEO_GALLERY_W);
    // The plot is 1024 × 512; the legend and meter line sits under it.
    el.style.height = px(GEO_GALLERY_H + tokenSize['control']);
  }, []);
  return (
    <section className={cx(styles['entry'])} data-geo-gallery={e.id} aria-label={e.title}>
      <h2 className={cx(styles['title'])}>{e.title}</h2>
      <div ref={ref} className={cx(styles['map'])}>
        <GeoMapFrame
          panelId={e.id}
          title={e.title}
          unit={GEO_GALLERY_UNIT}
          options={e.options}
          thresholds={e.thresholds}
          run={run}
          geoData={geoData}
          sizeMemo={size}
          fill
        />
      </div>
    </section>
  );
}

export function GeoGalleryPage() {
  usePageTitle(t('geoGallery.title'));
  const page = geoGalleryPage(new URLSearchParams(useLocation().search).get('page'));
  const [geoData, setGeoData] = useState<GeoData | null>(null);
  useEffect(() => {
    let live = true;
    void loadGeoData().then((d) => {
      // The fixtures are placed by gazetteer T (T24 §10.3); the basemap is the bundled one.
      if (live) setGeoData({ basemap: d.basemap, gazetteer: gazT() });
    });
    return () => {
      live = false;
    };
  }, []);
  const entries = geoGalleryEntries(page);
  return (
    <div className={cx(styles['page'])} data-geo-gallery-page={page}>
      <p className={cx(styles['intro'])}>{t('geoGallery.intro')}</p>
      {geoData === null ? (
        <p aria-busy="true">{t('panel.loading')}</p>
      ) : (
        <Suspense fallback={<p aria-busy="true">{t('panel.loading')}</p>}>
          {entries.map((e) => (
            <GalleryMap key={e.id} e={e} geoData={geoData} />
          ))}
        </Suspense>
      )}
    </div>
  );
}
