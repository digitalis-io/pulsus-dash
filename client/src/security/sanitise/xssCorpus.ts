/**
 * Test-only: the XSS corpus payloads and templates (plan #198 Part 2b §5.1). Each payload × template
 * is one case; `scripts/gen-xss-corpus.ts` parses every case and writes its expected output per
 * policy to `__fixtures__/xss-corpus.json`, and the fuzz draws tokens from the same lists. Only
 * reserved `.test` hosts appear.
 *
 * Adding a payload: add it to its group below, run `npm run gen:xss-corpus`, inspect the new
 * entries of the JSON and commit both. `unit:xss-corpus-current` fails until the JSON is current.
 *
 * This module has no imports: the corpus generator loads it in Node.
 */

export interface CorpusCase {
  readonly id: string;
  readonly group: string;
  readonly src: string;
  /** `vars` entries; every case also has `env = prod`. */
  readonly vars: readonly (readonly [string, string])[];
  readonly entity: string | null;
}

/** S: link and image schemes. */
export const SCHEMES: readonly string[] = [
  'javascript:x',
  'JaVaScRiPt:x',
  'java&#x09;script:x',
  '&#106;avascript:x',
  '&#x6A;avascript:x',
  'javascript&#58;x',
  '%6Aavascript:x',
  'vbscript:x',
  'data:text/html,x',
  'data:image/svg+xml,x',
  'blob:x',
  'file:///x',
  '//e.test/x',
  '/\\e.test/x',
  '\\\\e.test\\x',
  '/a/../..//e.test',
  '/.//e.test',
  'ｊavascript:x',
  'java​script:x',
  '﻿javascript:x',
];

const SCHEME_TEMPLATES: readonly ((p: string) => string)[] = [
  (p) => `[a](${p})`,
  (p) => `[a](<${p}>)`,
  (p) => `<${p}>`,
  (p) => `[a]\n\n[a]: ${p}`,
  (p) => `![a](${p})`,
];

/** H: raw HTML. */
export const HTML: readonly string[] = [
  '<script>alert(1)</script>',
  '<SCRIPT>x</SCRIPT>',
  '<scr<script>ipt>x',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<body onload=x>',
  '<details open ontoggle=x>',
  '<a href="javascript:x">a</a>',
  '<object data=x>',
  '<embed src=x>',
  '<form action=x><button>b</button></form>',
  '<base href=x>',
  '<meta http-equiv=refresh content=0>',
  '<link rel=stylesheet href=x>',
  "<style>@import 'x'</style>",
  '<math><mi>x</mi></math>',
  '<svg><script>x</script></svg>',
  '<template><script>x</script></template>',
  '<noscript><img src=x></noscript>',
  '<!-- x -->',
  '<![CDATA[x]]>',
  '<input autofocus onfocus=x>',
  '<iframe src=x></iframe>',
  '<iframe srcdoc="<script>x</script>"></iframe>',
];

const HTML_TEMPLATES: readonly ((p: string) => string)[] = [
  (p) => p,
  (p) => `a ${p} b`,
  (p) => `> ${p}`,
  (p) => `- ${p}`,
];

/** B: attribute and syntax breakouts, each a whole input. */
export const BREAKOUTS: readonly string[] = [
  '[x"><script>](/b)',
  '![x" onerror=y](/l.svg)',
  '```js" onclick=x\ncode\n```',
  '[a](/x "onclick=y")',
  '\\<script>',
  '&lt;script&gt;',
  '999999999. x',
  '0. x',
  '####### x',
  "[a](/x 'y')",
];

/** V: variable and entity values. */
export const VALUES: readonly string[] = [
  '<script>x</script>',
  '](javascript:x)',
  '" onerror=x',
  'javascript:x',
  '\uD800',
  '{{entity}}',
];

const VALUE_TEMPLATES: readonly ((r: string) => string)[] = [
  (r) => `Env ${r}`,
  (r) => `[a](/b?q=${r})`,
  (r) => `[a](${r})`,
  (r) => `![a](${r})`,
];

/** L: image loading. */
export const IMAGES: readonly string[] = [
  'https://i.test/x.png',
  '/api/x',
  '/auth/x',
  '/l.svg',
  '/%61pi/x',
  'data:,x',
];

/** N: nested images and links. */
export const NESTED_DESTS: readonly string[] = [
  '/l.svg',
  'javascript:x',
  'https://i.test/x.png',
  '/api/x',
];

/** D: payloads placed below a deep block quote. */
export const DEEP: readonly string[] = [
  '<b>x</b>',
  '<iframe src="/b"></iframe>',
  '$env',
  '[a](javascript:x)',
  'p1\n\np2 [k](/b)',
  '- a\n- b [l](/b)',
];

export const DEPTHS: readonly number[] = [30, 31, 32, 200];

/** U: Unicode in link text, destinations and text. */
export const UNICODE: readonly string[] = ['‮', ' ', '\u0000', '\uD800', '\uDFFF'];

const UNICODE_TEMPLATES: readonly ((p: string) => string)[] = [
  (p) => `[a${p}b](/b)`,
  (p) => `[a](/b${p})`,
  (p) => `x${p}y`,
];

const ENV: readonly [string, string] = ['env', 'prod'];

function prefixLines(prefix: string, s: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/** Every corpus case, in a fixed order. */
export function corpusCases(): CorpusCase[] {
  const out: CorpusCase[] = [];
  const add = (group: string, src: string, more?: Partial<CorpusCase>): void => {
    out.push({
      id: `${group}${String(out.filter((c) => c.group === group).length + 1)}`,
      group,
      src,
      vars: more?.vars ?? [ENV],
      entity: more?.entity ?? null,
    });
  };
  for (const p of SCHEMES) {
    for (const t of SCHEME_TEMPLATES) add('S', t(p));
    add('S', '[a]($u)', { vars: [ENV, ['u', p]] });
  }
  for (const p of HTML) for (const t of HTML_TEMPLATES) add('H', t(p));
  for (const p of BREAKOUTS) add('B', p);
  for (const v of VALUES) {
    for (const t of VALUE_TEMPLATES) add('V', t('$v'), { vars: [ENV, ['v', v]] });
    for (const t of VALUE_TEMPLATES) add('V', t('{{entity}}'), { entity: v });
  }
  for (const p of IMAGES) add('L', `![a](${p})`);
  for (const p of NESTED_DESTS) {
    add('N', `[![i](${p}) t](/b)`);
    add('N', `![a [l](${p}) *e*](/l.svg)`);
  }
  for (const n of DEPTHS) for (const p of DEEP) add('D', prefixLines('> '.repeat(n), p));
  for (const p of UNICODE) for (const t of UNICODE_TEMPLATES) add('U', t(p));
  return out;
}
