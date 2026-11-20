/**
 * The only TypeScript path to the state colours (T02-004). Each state has a glyph and a label as well
 * as a colour (T02 §4), so state is never shown by colour alone. Unused by pages until state views
 * arrive.
 */
import type { MessageId } from '../i18n/t';
import styles from './stateEncoding.module.css';

export type State = 'ok' | 'watch' | 'degraded' | 'failing' | 'unknown';

export interface StateStyle {
  readonly className: string;
  readonly glyph: '●' | '◐' | '◉' | '■' | '○';
  readonly label: MessageId;
}

function cls(name: State): string {
  const c = styles[name];
  if (c === undefined) throw new Error(`missing state class ${name}`);
  return c;
}

export const StateEncoding: Readonly<Record<State, StateStyle>> = Object.freeze({
  ok: { className: cls('ok'), glyph: '●', label: 'state.ok' },
  watch: { className: cls('watch'), glyph: '◐', label: 'state.watch' },
  degraded: { className: cls('degraded'), glyph: '◉', label: 'state.degraded' },
  failing: { className: cls('failing'), glyph: '■', label: 'state.failing' },
  unknown: { className: cls('unknown'), glyph: '○', label: 'state.unknown' },
});
