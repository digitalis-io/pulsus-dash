import { messages, type MessageId } from './messages.en-GB';

export type { MessageId };

/** The catalogue string for `id`, with each `{name}` replaced by `values[name]`. */
export function t(id: MessageId, values?: Readonly<Record<string, string | number>>): string {
  const text: string = messages[id];
  if (values === undefined) return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const v = values[name];
    return v === undefined ? whole : String(v);
  });
}
