// STUB (tests first, plan #198 Part 2a): replaced by the implementation.
export type UrlClass =
  | { kind: 'local'; href: string; host: string }
  | { kind: 'external'; href: string; host: string }
  | { kind: 'mailto'; href: string }
  | { kind: 'rejected' };
// eslint-disable-next-line no-control-regex
export const URL_FORBIDDEN = /[\u0000- \u007F-\u009F\\]/;
export function classifyUrl(_raw: string, _appOrigin: string): UrlClass {
  return { kind: 'external', href: '', host: '' };
}
export function toWellFormed(s: string): string {
  return s;
}
