/**
 * The widget gallery (development and stub builds only; plan #198 Part 3b §2; VIZ-069): the Text
 * widget's states on fixed content, the corpus of `golden:widget-gallery`. `?page=widget-text` shows
 * a runbook in Markdown, a PromQL code panel and an empty panel, each through the board's
 * `WidgetBody`; `?page=widget-text-removals` shows the registry's Text editor body on content with
 * one removal of each kind. The board variable `env` is `prod`. The Board list pages (plan #216 Part
 * 2a §4.6) draw `boardListGallery.ts`'s panels, each with its own query client (no retry, always
 * stale) and its own Api (`galleryApi`), the stale panel's cache primed with B.
 *
 * The board's widget modules come from the board route's chunk (`BoardPage` re-exports them), loaded
 * with it: a static import here would make this chunk another importer of them and split the stub
 * build's initial chunks differently, adding about 2.7 KB brotli to its initial JS.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useContext, useId, useState, type ReactElement } from 'react';
import { useLocation } from 'react-router';
import type { WidgetPanelSpec } from '../api/types';
import { ApiContext } from '../app/providers';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { usePageTitle } from '../shell/PageTitle';
import { useShellRoute } from '../shell/useShellRoute';
import { B } from '../widgets/boardList/fixtures';
import {
  boardListGalleryPanels,
  galleryApi,
  GALLERY_STALE_FETCHED_MS,
  isBoardListGalleryPage,
  type BoardListGalleryPage,
  type BoardListGalleryPanel,
} from './boardListGallery';
import styles from './WidgetGalleryPage.module.css';
import {
  WIDGET_GALLERY_VARS,
  widgetGalleryPage,
  widgetGalleryPanels,
  type WidgetGalleryPage as Page,
} from './widgetGallery';

type BoardModule = typeof import('../pages/board/BoardPage');

function GalleryPanel({ m, panel }: { m: BoardModule; panel: WidgetPanelSpec }) {
  const headingId = useId();
  return (
    <section className={cx(styles['panel'])} aria-labelledby={headingId} data-gallery-id={panel.id}>
      <h2 id={headingId} className={cx(styles['title'])}>
        {panel.title}
      </h2>
      <div
        className={cx(
          styles['body'],
          panel.vis.kind === 'boardList' ? styles['listBody'] : undefined,
        )}
      >
        <m.WidgetBody panel={panel} headingId={headingId} editing={false} />
      </div>
    </section>
  );
}

/** A Board list panel with its own query client and Api; the stale panel's cache holds B. */
function ListPanel({ m, item }: { m: BoardModule; item: BoardListGalleryPanel }) {
  const { tenant } = useShellRoute();
  const [client] = useState(() => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    if (item.answer === 'stale') {
      const key = m.boardListKey(tenant, m.boardListOptions(item.panel.vis.options), '');
      qc.setQueryData(key, B, { updatedAt: GALLERY_STALE_FETCHED_MS });
    }
    return qc;
  });
  const [api] = useState(() => galleryApi(item.answer));
  return (
    <QueryClientProvider client={client}>
      <ApiContext.Provider value={api}>
        <GalleryPanel m={m} panel={item.panel} />
      </ApiContext.Provider>
    </QueryClientProvider>
  );
}

function ListPanels({ m, page }: { m: BoardModule; page: BoardListGalleryPage }) {
  return (
    <div className={cx(styles['panels'])}>
      {boardListGalleryPanels(page).map((item) => (
        <ListPanel key={item.panel.id} m={m} item={item} />
      ))}
    </div>
  );
}

function GalleryEditor({ m, initial }: { m: BoardModule; initial: WidgetPanelSpec }) {
  const [panel, setPanel] = useState(initial);
  const Editor = m.WIDGETS.defs.find((d) => d.kind === panel.vis.kind)?.Editor;
  if (Editor === undefined) return null;
  return (
    <div className={cx(styles['editor'])} data-gallery-id={panel.id}>
      <Editor
        panel={panel}
        title={panel.title}
        pointer="/panels/0"
        fields={[]}
        readOnly={false}
        original={initial.vis}
        onVis={(vis) => {
          setPanel((p) => ({ ...p, vis }));
        }}
      />
    </div>
  );
}

/** The page's panels, once the board route's chunk has loaded. */
const Gallery = lazy(async () => {
  const m = await import('../pages/board/BoardPage');
  function Panels({ page }: { page: Page }): ReactElement {
    // Outside a board the run context is its default; only the variables differ.
    const outer = useContext(m.BoardRunContext);
    if (isBoardListGalleryPage(page)) {
      return (
        <div data-widget-gallery={page}>
          <ListPanels m={m} page={page} />
        </div>
      );
    }
    const panels = widgetGalleryPanels(page);
    return (
      <m.BoardRunContext.Provider value={{ ...outer, vars: WIDGET_GALLERY_VARS }}>
        <div data-widget-gallery={page}>
          {page === 'widget-text-removals' ? (
            panels.map((p) => <GalleryEditor key={p.id} m={m} initial={p} />)
          ) : (
            <div className={cx(styles['panels'])}>
              {panels.map((p) => (
                <GalleryPanel key={p.id} m={m} panel={p} />
              ))}
            </div>
          )}
        </div>
      </m.BoardRunContext.Provider>
    );
  }
  return { default: Panels };
});

export function WidgetGalleryPage() {
  usePageTitle(t('widgetGallery.title'));
  const page = widgetGalleryPage(new URLSearchParams(useLocation().search).get('page'));
  return (
    <div className={cx(styles['page'])}>
      <p className={cx(styles['intro'])}>{t('widgetGallery.intro')}</p>
      <Suspense fallback={<p aria-busy="true">{t('panel.loading')}</p>}>
        <Gallery page={page} />
      </Suspense>
    </div>
  );
}
