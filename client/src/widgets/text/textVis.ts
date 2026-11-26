/**
 * A Text panel's vis from the editor's options (plan #198 Part 3a §3.2; review r3 #1), written in
 * the stored representation of the panel's head, so an edit typed back leaves the draft clean:
 * `{kind: 'text', options: {mode, content, language iff code}}`, where a key that `original.options`
 * lacks and whose value is its default (T24 §5.1: mode `markdown`, content `''`, language
 * `plaintext`) is omitted, and `options` is omitted when `original` had none and every key is.
 */
import type { VisOptions, WidgetPanelSpec } from '../../api/types';
import type { TextOptions } from '../spec';

const DEFAULTS: Readonly<TextOptions> = { mode: 'markdown', content: '', language: 'plaintext' };

export function textVis(
  o: TextOptions,
  original: WidgetPanelSpec['vis'] | undefined,
): WidgetPanelSpec['vis'] {
  const had: VisOptions | undefined = original?.options;
  const keep = (key: keyof TextOptions): boolean =>
    (had !== undefined && Object.hasOwn(had, key)) || o[key] !== DEFAULTS[key];
  const options: VisOptions = {};
  if (keep('mode')) options.mode = o.mode;
  if (keep('content')) options.content = o.content;
  // A language is a code-mode key: Markdown drops it (the validator refuses it there).
  if (o.mode === 'code' && keep('language')) options.language = o.language;
  if (had === undefined && Object.keys(options).length === 0) return { kind: 'text' };
  return { kind: 'text', options };
}
