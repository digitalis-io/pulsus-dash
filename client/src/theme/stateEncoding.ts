/**
 * The only TypeScript path to the state colours (T02-004). Each state has a glyph and a label as well
 * as a colour (T02 §4), so state is never shown by colour alone. The DOM takes the class (its
 * `--state-colour`); chart marks take `colour` (threshold lines and labels, #64 Part B, ADR-0022).
 */
import type { ThemeName, ThresholdState } from '../engine/api';
import type { MessageId } from '../i18n/t';
import { colour } from '../styles/tokens';
import styles from './stateEncoding.module.css';

export type State = 'ok' | ThresholdState | 'unknown';

export interface StateStyle {
  readonly className: string;
  readonly glyph: '●' | '◐' | '◉' | '■' | '○';
  readonly label: MessageId;
  /** The state's token colour per theme, for marks (T02-004: marks read state colours only here). */
  readonly colour: Readonly<Record<ThemeName, string>>;
  /** The state's text colour per theme (#284): glyphs, names and values drawn as text. */
  readonly textColour: Readonly<Record<ThemeName, string>>;
}

const tokenColour = (s: State): Readonly<Record<ThemeName, string>> =>
  Object.freeze({ dark: colour.dark[s], light: colour.light[s] });

const textColour = (s: State): Readonly<Record<ThemeName, string>> => tokenColour(s);

function cls(name: State): string {
  const c = styles[name];
  if (c === undefined) throw new Error(`missing state class ${name}`);
  return c;
}

export const StateEncoding: Readonly<Record<State, StateStyle>> = Object.freeze({
  ok: {
    className: cls('ok'),
    glyph: '●',
    label: 'state.ok',
    colour: tokenColour('ok'),
    textColour: textColour('ok'),
  },
  watch: {
    className: cls('watch'),
    glyph: '◐',
    label: 'state.watch',
    colour: tokenColour('watch'),
    textColour: textColour('watch'),
  },
  degraded: {
    className: cls('degraded'),
    glyph: '◉',
    label: 'state.degraded',
    colour: tokenColour('degraded'),
    textColour: textColour('degraded'),
  },
  failing: {
    className: cls('failing'),
    glyph: '■',
    label: 'state.failing',
    colour: tokenColour('failing'),
    textColour: textColour('failing'),
  },
  unknown: {
    className: cls('unknown'),
    glyph: '○',
    label: 'state.unknown',
    colour: tokenColour('unknown'),
    textColour: textColour('unknown'),
  },
});
