/**
 * A Board list panel's vis from the editor's options (plan #216 Part 2b §3.1; T24 §5.5), written in
 * the stored representation of the panel's head, as `textVis` does, so an edit typed back leaves
 * the draft clean. A key is written when `original.options` has it or its value is not the T24
 * §5.5 default (mode `starred`, query `''`, limit 10, sort `default`); `query` only in search mode
 * and `tag` only in tag mode (with a tag: it has no default). `options` is omitted when `original`
 * had none and no key is written.
 */
import type { VisOptions, WidgetPanelSpec } from '../../api/types';
import { DEFAULT_BOARD_LIMIT, type BoardListOptions } from './options';

export function boardListVis(
  o: BoardListOptions,
  original: WidgetPanelSpec['vis'] | undefined,
): WidgetPanelSpec['vis'] {
  const had: VisOptions | undefined = original?.options;
  const has = (key: keyof BoardListOptions): boolean =>
    had !== undefined && Object.hasOwn(had, key);
  const options: VisOptions = {};
  if (has('mode') || o.mode !== 'starred') options.mode = o.mode;
  if (o.mode === 'search' && (has('query') || o.query !== '')) options.query = o.query;
  if (o.mode === 'tag' && o.tag !== null) options.tag = o.tag;
  if (has('limit') || o.limit !== DEFAULT_BOARD_LIMIT) options.limit = o.limit;
  if (has('sort') || o.sort !== 'default') options.sort = o.sort;
  if (had === undefined && Object.keys(options).length === 0) return { kind: 'boardList' };
  return { kind: 'boardList', options };
}
