/**
 * unit:classify-url, unit:well-formed (plan #198 Part 2a §5; T24 §10, T24-005, T18-011).
 */
import { describe, expect, it } from 'vitest';
import { classifyUrl, toWellFormed, type UrlClass } from './url';

const APP = 'https://dash.test';

/** The T24 §10 rejections. */
const T24_REJECTED = [
  '/\t/evil.test',
  '/a/../..//evil.test',
  '/.//evil',
  '/\\evil.test',
  '//evil.test',
  ' /x',
  '/x\u0085',
  'https://u:p@x.test/',
  'JaVaScRiPt:x',
  'data:,x',
  'boards/b1',
];

/** The plan's further rejections: other schemes, look-alikes, relative forms and controls. */
const MORE_REJECTED = [
  'vbscript:x',
  'blob:x',
  'blob:https://dash.test/0',
  'file:///etc/passwd',
  'file:x',
  'ｊavascript:x',
  'java​script:x',
  '',
  '#h',
  '/x\u0000',
  '/x\u009F',
  '/a/..//evil.test',
  'https://u@x.test/',
  'https://:p@x.test/',
  'https://x\uD800.test/',
  'https://x\uDC00.test/',
];

describe('unit:classify-url', () => {
  it('rejects the T24 §10 strings', () => {
    for (const raw of T24_REJECTED)
      expect(classifyUrl(raw, APP), raw).toEqual({ kind: 'rejected' });
  });

  it('rejects other schemes, look-alikes, relative forms, controls and invalid hosts', () => {
    for (const raw of MORE_REJECTED)
      expect(classifyUrl(raw, APP), raw).toEqual({ kind: 'rejected' });
  });

  it('keeps local paths path-relative, with the app host', () => {
    expect(classifyUrl('/boards/b1?x=1#h', APP)).toEqual({
      kind: 'local',
      href: '/boards/b1?x=1#h',
      host: 'dash.test',
    });
    expect(classifyUrl('/%5Cevil.test', APP)).toEqual({
      kind: 'local',
      href: '/%5Cevil.test',
      host: 'dash.test',
    });
  });

  it('normalises external URLs and keeps mailto as the parsed href', () => {
    expect(classifyUrl('HTTPS://X.TEST', APP)).toEqual({
      kind: 'external',
      href: 'https://x.test/',
      host: 'x.test',
    });
    expect(classifyUrl('http://x.test:8080/p', APP)).toEqual({
      kind: 'external',
      href: 'http://x.test:8080/p',
      host: 'x.test:8080',
    });
    expect(classifyUrl('mailto:o@x.test', APP)).toEqual({
      kind: 'mailto',
      href: new URL('mailto:o@x.test').href,
    });
    expect(classifyUrl('MAILTO:o@x.test', APP)).toEqual({
      kind: 'mailto',
      href: 'mailto:o@x.test',
    });
  });

  it('turns a lone surrogate in an accepted path into %EF%BF%BD', () => {
    const local = classifyUrl('/a\uD800b', APP);
    expect(local).toEqual({ kind: 'local', href: '/a%EF%BF%BDb', host: 'dash.test' });
    expect(classifyUrl('/x\uDC00', APP)).toEqual({
      kind: 'local',
      href: '/x%EF%BF%BD',
      host: 'dash.test',
    });
    expect(classifyUrl('https://x.test/p\uD800', APP)).toEqual({
      kind: 'external',
      href: 'https://x.test/p%EF%BF%BD',
      host: 'x.test',
    });
  });

  it('never throws', () => {
    const all = [
      ...T24_REJECTED,
      ...MORE_REJECTED,
      '/boards/b1',
      'https://x.test/',
      'mailto:',
      'http://',
      'https://[::1',
      '/\uD800',
      '\uDC00',
      'https://x.test/\uDBFF\uDBFF',
    ];
    const results: UrlClass[] = [];
    for (const raw of all) expect(() => results.push(classifyUrl(raw, APP)), raw).not.toThrow();
    expect(results).toHaveLength(all.length);
    const kinds = new Set(results.map((r) => r.kind));
    expect([...kinds].sort()).toEqual(['external', 'local', 'mailto', 'rejected']);
  });
});

describe('unit:well-formed', () => {
  it('replaces lone surrogates with U+FFFD and keeps pairs', () => {
    expect(toWellFormed('a\uD800')).toBe('a�');
    expect(toWellFormed('\uDC00b')).toBe('�b');
    expect(toWellFormed('\u{1F600}')).toBe('\u{1F600}');
    expect(toWellFormed('')).toBe('');
    expect(toWellFormed('\uDC00\uD800')).toBe('��');
  });
});
