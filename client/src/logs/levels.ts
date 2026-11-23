/** Level glyphs and names (plan #66 Part B §3.6). Stub: implemented in the next commit. */
import type { LogLevel } from '../data/logFrame';
import type { MessageId } from '../i18n/t';

const notImplemented = <T extends object>(): T =>
  new Proxy({} as T, {
    get() {
      throw new Error('not implemented');
    },
  });

export const LEVEL_GLYPH: Readonly<Record<LogLevel, MessageId>> = notImplemented();
export const LEVEL_NAME: Readonly<Record<LogLevel, MessageId>> = notImplemented();
