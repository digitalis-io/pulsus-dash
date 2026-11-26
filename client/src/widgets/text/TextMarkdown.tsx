/**
 * The Text widget's one dynamic entry (plan #198 Part 3a §3.1): the only module that imports the
 * Markdown renderer, so commonmark, parse5 and the sanitiser load with the first Text panel that
 * shows content, never with the board route (`markdown-in-route`, ADR-0014 §8).
 *
 * - `TextContent`: Markdown through `renderMarkdown` under the `board` policy (T24-004, T24-018),
 *   with the panel's set variables (T24-008) and no entity; its removals go to `logRemovals` once
 *   per distinct result (T24-007). Code mode: the source verbatim (`renderCode`).
 * - `TextRemovals`: the editor's "Not shown in the panel" list, from the same (memoised) render;
 *   each line names a kind and a line only.
 *
 * Stub and dev builds only (plan #198 Part 3b §4.3): each render that misses the memo leaves a
 * `markdown:render:<bucket>` measure (`le4k`, `le16k` or `le64k` by the content's UTF-8 bytes), for
 * `bench:text-widget-render`. The condition is static, so http builds drop the measure.
 */
import { useEffect, useId, type ReactElement } from 'react';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import {
  logRemovals,
  memoStats,
  removalMessage,
  renderCode,
  renderMarkdown,
  type MarkdownResult,
} from '../../security/sanitise/markdown';
import type { TextOptions } from '../spec';
import styles from './Text.module.css';

interface Props {
  readonly options: TextOptions;
  readonly vars: ReadonlyMap<string, string>;
}

const KIB = 1024;

/** The bench bucket of a content: its UTF-8 size. */
function bucket(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  return bytes <= 4 * KIB ? 'le4k' : bytes <= 16 * KIB ? 'le16k' : 'le64k';
}

/** The board's render of Markdown content (memoised by the renderer, LRU 32). */
function render(o: TextOptions, vars: ReadonlyMap<string, string>): MarkdownResult {
  const run = (): MarkdownResult =>
    renderMarkdown(
      o.content,
      { vars, entity: null },
      { policy: 'board', appOrigin: location.origin },
    );
  if (import.meta.env.VITE_API_MODE === 'http') return run();
  const misses = memoStats().misses;
  const start = performance.now();
  const r = run();
  if (memoStats().misses > misses) {
    performance.measure(`markdown:render:${bucket(o.content)}`, { start, end: performance.now() });
  }
  return r;
}

export function TextContent({
  panelId,
  options,
  vars,
}: Props & { readonly panelId: string }): ReactElement {
  const md = options.mode === 'markdown' ? render(options, vars) : null;
  useEffect(() => {
    if (md !== null) logRemovals(panelId, md.removals);
  }, [panelId, md]);
  return (
    <div data-text-content="">
      {md === null ? renderCode(options.content, options.language) : md.node}
    </div>
  );
}

export function TextRemovals({ options, vars }: Props): ReactElement | null {
  const id = useId();
  if (options.mode !== 'markdown') return null;
  const { removals } = render(options, vars);
  if (removals.length === 0) return null;
  return (
    <div className={cx(styles['removals'])} data-text-removals="">
      <p id={id} className={cx(styles['removalsTitle'])}>
        {t('widget.text.removals')}
      </p>
      <ul aria-labelledby={id} className={cx(styles['removalsList'])}>
        {removals.map((r, i) => (
          // Removals carry only a kind and a line, so two can be equal: the index keeps keys unique.
          <li key={`${String(i)}:${r.kind}:${String(r.line)}`}>{removalMessage(r)}</li>
        ))}
      </ul>
    </div>
  );
}
