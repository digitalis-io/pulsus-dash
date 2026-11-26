// STUB (tests first, plan #198 Part 2a): replaced by the implementation.
export type ImportNote =
  | { kind: 'iframeToLink'; line: number; host: string }
  | { kind: 'iframeNoLink'; line: number }
  | { kind: 'htmlNotRendered'; count: number };
export interface TextImportError {
  kind: 'textTooLargeForLinks';
  panelIndex: number;
  sourceId?: number;
  links: number;
}
export function convertImportedText(
  _content: string,
  _mode: 'markdown' | 'code',
  _appOrigin: string,
):
  | {
      ok: true;
      content: string;
      notes: readonly ImportNote[];
      inserted: readonly { offset: number; text: string }[];
    }
  | { ok: false; reason: 'sizeLimit'; links: number } {
  return { ok: false, reason: 'sizeLimit', links: -1 };
}
export function markdownLink(_label: string, _href: string): string {
  return '';
}
export function importNoteMessage(_n: ImportNote): string {
  return '';
}
export function textImportErrorMessage(_e: TextImportError): string {
  return '';
}
export const embeddedLinkLabel = (host: string): string => `Open embedded page (${host})`;
