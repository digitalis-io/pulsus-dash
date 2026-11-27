/**
 * The Text widget's editor body (plan #198 Part 3a §4.3; T24-007, T24-014), inside `WidgetEditor`:
 * the live preview (`TextBody` with the draft), Format, Language (code mode only), Content and,
 * once the preview shows content, what the panel does not show. Each change writes the vis through
 * `textVis`, in the head's stored representation. A field shows the draft's live error first (the
 * same rules as a save, `widgetVisErrors`), else the last save's.
 */
import { lazy, Suspense, useContext, useDeferredValue, useMemo } from 'react';
import type { CodeLanguage } from '../../api/types';
import { BoardRunContext } from '../../boards/boardRunContext';
import { fieldMessage } from '../../boards/fieldMessages';
import { OPTION_VALUES } from '../../boards/options';
import { widgetVisErrors } from '../../boards/spec';
import { t, type MessageId } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { SegmentedControl } from '../../kit/SegmentedControl';
import { Select } from '../../kit/Select';
import { TextArea } from '../../kit/TextArea';
import type { WidgetEditorBodyProps } from '../registry';
import { textOptions, type TextOptions } from '../spec';
import { ChunkBoundary } from './ChunkBoundary';
import { loadTextMarkdown, TextBody, textVars } from './TextBody';
import styles from './Text.module.css';
import { textVis } from './textVis';

const TextRemovals = lazy(async () => ({ default: (await loadTextMarkdown()).TextRemovals }));

const LANGUAGES = OPTION_VALUES.language as readonly CodeLanguage[];

const MODES: readonly { id: TextOptions['mode']; label: MessageId }[] = [
  { id: 'markdown', label: 'widget.text.markdown' },
  { id: 'code', label: 'widget.text.code' },
];

export function TextEditorBody({
  panel,
  title,
  pointer,
  fields,
  readOnly,
  original,
  onVis,
}: WidgetEditorBodyProps) {
  const o = useMemo(() => textOptions(panel.vis.options), [panel.vis.options]);
  const live = useMemo(() => widgetVisErrors(panel), [panel]);
  const vars = textVars(useContext(BoardRunContext).displayVars, o);
  const deferredOptions = useDeferredValue(o);
  const deferredVars = useDeferredValue(vars);
  const errorAt = (suffix: string): string | null => {
    const f =
      live.find((x) => x.pointer === suffix) ??
      fields.find((x) => x.pointer === `${pointer}${suffix}`);
    return f === undefined ? null : fieldMessage(f.messageKey);
  };
  const set = (next: TextOptions): void => {
    onVis(textVis(next, original));
  };
  const name = t('widget.text.previewLabel', {
    title: title === '' ? t('widget.kind.text') : title,
  });
  // The removals of what the preview shows: only once it renders content.
  const rendered = live.length === 0 && o.content.trim() !== '';
  return (
    <>
      <div className={cx(styles['preview'])}>
        <TextBody panel={panel} name={{ label: name }} editing context="preview" />
      </div>
      <div className={cx(styles['fields'])}>
        <SegmentedControl
          label={t('widget.text.format')}
          options={MODES.map((m) => ({ id: m.id, label: t(m.label) }))}
          value={o.mode}
          onChange={(mode) => {
            // Markdown drops the language; code starts at plain text.
            set({ ...o, mode, language: 'plaintext' });
          }}
        />
        {o.mode === 'code' ? (
          <Select
            label={t('widget.text.language')}
            value={o.language}
            options={LANGUAGES.map((id) => ({ id, label: t(`widget.text.lang.${id}`) }))}
            onChange={(language) => {
              set({ ...o, language });
            }}
            error={errorAt('/vis/options/language')}
            isDisabled={readOnly}
          />
        ) : (
          <div />
        )}
        <div className={cx(styles['wide'])}>
          <TextArea
            label={t('widget.text.content')}
            value={o.content}
            onChange={(content) => {
              set({ ...o, content });
            }}
            error={errorAt('/vis/options/content')}
            isReadOnly={readOnly}
            mono
            rows={12}
          />
        </div>
        {rendered && (
          <div className={cx(styles['wide'])}>
            <ChunkBoundary fallback={null}>
              <Suspense fallback={null}>
                <TextRemovals options={deferredOptions} vars={deferredVars} />
              </Suspense>
            </ChunkBoundary>
          </div>
        )}
      </div>
    </>
  );
}
