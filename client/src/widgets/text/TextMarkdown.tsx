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
 */
import { useEffect, useId, type ReactElement } from 'react';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import {
  logRemovals,
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

/** The board's render of Markdown content (memoised by the renderer, LRU 32). */
function render(o: TextOptions, vars: ReadonlyMap<string, string>): MarkdownResult {
  return renderMarkdown(
    o.content,
    { vars, entity: null },
    { policy: 'board', appOrigin: location.origin },
  );
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
  return <>{md === null ? renderCode(options.content, options.language) : md.node}</>;
}

export function TextRemovals({ options, vars }: Props): ReactElement | null {
  const id = useId();
  if (options.mode !== 'markdown') return null;
  const { removals } = render(options, vars);
  if (removals.length === 0) return null;
  return (
    <div className={cx(styles['removals'])}>
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
