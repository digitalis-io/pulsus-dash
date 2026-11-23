/**
 * The level glyph and name of the stream's severity gutter (plan #66 Part B §3.6; VIZ-067): a
 * three-letter glyph beside the level colour, so a level is never told by colour alone, and the
 * name screen readers announce. `critical` shares the `error` hue (`level-*` tokens) and is told
 * apart by `CRT` and its name.
 */
import type { LogLevel } from '../data/logFrame';
import type { MessageId } from '../i18n/t';

export const LEVEL_GLYPH: Readonly<Record<LogLevel, MessageId>> = {
  unknown: 'logs.glyph.unknown',
  trace: 'logs.glyph.trace',
  debug: 'logs.glyph.debug',
  info: 'logs.glyph.info',
  warn: 'logs.glyph.warn',
  error: 'logs.glyph.error',
  critical: 'logs.glyph.critical',
};

export const LEVEL_NAME: Readonly<Record<LogLevel, MessageId>> = {
  unknown: 'logs.level.unknown',
  trace: 'logs.level.trace',
  debug: 'logs.level.debug',
  info: 'logs.level.info',
  warn: 'logs.level.warn',
  error: 'logs.level.error',
  critical: 'logs.level.critical',
};
