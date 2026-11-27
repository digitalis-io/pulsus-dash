/**
 * The engine mode banner (plan #68 C2d2 §4.4; T03 §9.2): one status line under the header while
 * the chart engine runs single-threaded, with the text for its reason. Nothing in any other mode,
 * or before the page's first frame booted an engine. No close button: the condition is the page's.
 */
import type { EngineMode } from '../engine/mode';
import { t } from '../i18n/t';
import styles from './EngineModeBanner.module.css';
import { cx } from '../kit/cx';

const KEY = {
  isolation: 'engine.st.isolation',
  waitAsync: 'engine.st.waitAsync',
  forced: 'engine.st.forced',
} as const;

export function EngineModeBanner({ mode }: { readonly mode: EngineMode | null }) {
  if (mode?.mode !== 'st') return null;
  return (
    <p className={cx(styles['banner'])} role="status" data-engine-mode-banner={mode.reason}>
      {t(KEY[mode.reason])}
    </p>
  );
}
