/**
 * The widget gallery (development and stub builds only; plan #198 Part 3b §2; VIZ-069): the Text
 * widget's states on fixed content, the corpus of `golden:widget-gallery`. `?page=widget-text` shows
 * a runbook in Markdown, a PromQL code panel and an empty panel; `?page=widget-text-removals` shows
 * the widget editor's Text body on content with one removal of each kind. The board variable `env`
 * is `prod`.
 */
import { useContext, useId, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import type { WidgetPanelSpec } from '../api/types';
import { BoardRunContext } from '../boards/boardRunContext';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { usePageTitle } from '../shell/PageTitle';
import { TextBody } from '../widgets/text/TextBody';
import { TextEditorBody } from '../widgets/text/TextEditorBody';
import styles from './WidgetGalleryPage.module.css';
import { WIDGET_GALLERY_VARS, widgetGalleryPage, widgetGalleryPanels } from './widgetGallery';

function GalleryPanel({ panel }: { panel: WidgetPanelSpec }) {
  const headingId = useId();
  return (
    <section className={cx(styles['panel'])} aria-labelledby={headingId} data-gallery-id={panel.id}>
      <h2 id={headingId} className={cx(styles['title'])}>
        {panel.title}
      </h2>
      <div className={cx(styles['body'])}>
        <TextBody panel={panel} name={{ labelledBy: headingId }} editing={false} context="board" />
      </div>
    </section>
  );
}

function GalleryEditor({ initial }: { initial: WidgetPanelSpec }) {
  const [panel, setPanel] = useState(initial);
  return (
    <div className={cx(styles['editor'])} data-gallery-id={panel.id}>
      <TextEditorBody
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

export function WidgetGalleryPage() {
  usePageTitle(t('widgetGallery.title'));
  const page = widgetGalleryPage(new URLSearchParams(useLocation().search).get('page'));
  const outer = useContext(BoardRunContext);
  const run = useMemo(() => ({ ...outer, vars: WIDGET_GALLERY_VARS }), [outer]);
  const panels = widgetGalleryPanels(page);
  return (
    <div className={cx(styles['page'])}>
      <p className={cx(styles['intro'])}>{t('widgetGallery.intro')}</p>
      <BoardRunContext.Provider value={run}>
        <div data-widget-gallery={page}>
          {page === 'widget-text-removals' ? (
            panels.map((p) => <GalleryEditor key={p.id} initial={p} />)
          ) : (
            <div className={cx(styles['panels'])}>
              {panels.map((p) => (
                <GalleryPanel key={p.id} panel={p} />
              ))}
            </div>
          )}
        </div>
      </BoardRunContext.Provider>
    </div>
  );
}
