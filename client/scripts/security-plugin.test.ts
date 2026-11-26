/**
 * unit:security-lint (plan #198 Part 2a §3.5, §5): the `security` ESLint plugin. `security/no-iframe`
 * is `ci:no-iframe` (T08-009, VIZ-056); `security/markdown-boundary` keeps the ADR-0024 packages
 * inside `src/security/sanitise/`.
 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import security from '../eslint/security-plugin.ts';

const cwd = fileURLToPath(new URL('..', import.meta.url));

function eslint(): ESLint {
  return new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { security },
        rules: {
          'security/no-iframe': 'error',
          'security/no-html-sink': 'error',
          'security/markdown-boundary': 'error',
        },
      },
    ],
  });
}

async function rules(code: string, filePath: string): Promise<(string | null)[]> {
  const [r] = await eslint().lintText(code, { filePath });
  expect(r?.messages.filter((m) => m.fatal === true)).toEqual([]);
  return r?.messages.map((m) => m.ruleId) ?? [];
}

const NO_IFRAME = 'security/no-iframe';
const BOUNDARY = 'security/markdown-boundary';
const HTML_SINK = 'security/no-html-sink';

describe('unit:security-lint: security/no-iframe', () => {
  it('reports the embedding elements in JSX and allows a link', async () => {
    for (const tag of ['iframe', 'frame', 'frameset', 'object', 'embed']) {
      expect(await rules(`export const x = <${tag} />;\n`, 'src/x.tsx'), tag).toEqual([NO_IFRAME]);
    }
    expect(await rules('export const x = <a href="/b">b</a>;\n', 'src/x.tsx')).toEqual([]);
  });

  it('reports createElement of those names in any case, and in e2e', async () => {
    for (const name of ['iframe', 'IFRAME', 'Object', 'embed', 'frame', 'frameset']) {
      expect(
        await rules(`export const e = document.createElement('${name}');\n`, 'src/x.ts'),
        name,
      ).toEqual([NO_IFRAME]);
    }
    expect(
      await rules("export const f = () => document.createElement('iframe');\n", 'e2e/x.spec.ts'),
    ).toEqual([NO_IFRAME]);
    expect(await rules("export const e = document.createElement('div');\n", 'src/x.ts')).toEqual(
      [],
    );
  });

  it('reports srcDoc, new DOMParser and createContextualFragment', async () => {
    expect(await rules('export const x = <div srcDoc="a" />;\n', 'src/x.tsx')).toEqual([NO_IFRAME]);
    expect(await rules('export const p = new DOMParser();\n', 'src/x.ts')).toEqual([NO_IFRAME]);
    expect(
      await rules(
        'export const f = (r: Range, s: string) => r.createContextualFragment(s);\n',
        'src/x.ts',
      ),
    ).toEqual([NO_IFRAME]);
  });
});

describe('unit:security-lint: static computed keys and qualified constructors (review r1)', () => {
  const ts = 'src/x.ts';

  it('reports createElement and createContextualFragment through a static computed key', async () => {
    for (const code of [
      "export const e = document['createElement']('iframe');\n",
      'export const e = document[`createElement`](`IFRAME`);\n',
      "export const e = document['createElementNS']('http://www.w3.org/1999/xhtml', 'embed');\n",
      "export const f = (r: Range, s: string) => r['createContextualFragment'](s);\n",
    ]) {
      expect(await rules(code, ts), code).toEqual([NO_IFRAME]);
    }
    for (const code of [
      "export const e = document['createElement']('div');\n",
      "const k = 'createElement';\nexport const e = document[k]('div');\n",
    ]) {
      expect(await rules(code, ts), code).toEqual([]);
    }
  });

  it('reports a member-qualified DOMParser', async () => {
    for (const code of [
      'export const p = new window.DOMParser();\n',
      'export const p = new globalThis.DOMParser();\n',
      "export const p = new self['DOMParser']();\n",
    ]) {
      expect(await rules(code, ts), code).toEqual([NO_IFRAME]);
    }
    expect(await rules('export const p = new window.URL("/a", "http://x.test");\n', ts)).toEqual(
      [],
    );
  });

  it('reports srcdoc assignments and setAttribute, in any spelling', async () => {
    for (const code of [
      "export const f = (el: HTMLIFrameElement) => { el['srcdoc'] = 'x'; };\n",
      "export const f = (el: HTMLIFrameElement) => { el.srcdoc = 'x'; };\n",
      "export const f = (el: Element) => { el.setAttribute('srcdoc', 'x'); };\n",
      "export const f = (el: Element) => { el['setAttribute']('SRCDOC', 'x'); };\n",
    ]) {
      expect(await rules(code, ts), code).toEqual([NO_IFRAME]);
    }
    expect(
      await rules("export const f = (el: Element) => { el.setAttribute('title', 'x'); };\n", ts),
    ).toEqual([]);
  });

  it('security/no-html-sink reports innerHTML, outerHTML and insertAdjacentHTML in any spelling', async () => {
    for (const code of [
      "export const f = (el: Element) => { el['innerHTML'] = 'x'; };\n",
      "export const f = (el: Element) => { el[`outerHTML`] = 'x'; };\n",
      "export const f = (el: Element) => { el.innerHTML = 'x'; };\n",
      "export const f = (el: Element) => { el['insertAdjacentHTML']('beforeend', 'x'); };\n",
      "export const f = (el: Element) => { el.insertAdjacentHTML('beforeend', 'x'); };\n",
    ]) {
      expect(await rules(code, ts), code).toEqual([HTML_SINK]);
    }
    for (const code of [
      "export const f = (el: Element) => { el['textContent'] = 'x'; };\n",
      'export const f = (el: Element) => el.innerHTML;\n',
    ]) {
      expect(await rules(code, ts), code).toEqual([]);
    }
  });
});

describe('unit:security-lint: security/markdown-boundary', () => {
  it('commonmark only inside src/security/sanitise/', async () => {
    const code = "import { Parser } from 'commonmark';\nexport const p = new Parser();\n";
    expect(await rules(code, 'src/boards/x.ts')).toEqual([BOUNDARY]);
    expect(await rules(code, 'src/security/sanitise/markdown.tsx')).toEqual([]);
  });

  it('parse5 and the feedback alias only in findIframes.ts and the sanitise tests', async () => {
    const p5 = "import { parse } from 'parse5';\nexport const d = parse('');\n";
    expect(await rules(p5, 'src/boards/x.ts')).toEqual([BOUNDARY]);
    expect(await rules(p5, 'src/security/sanitise/url.ts')).toEqual([BOUNDARY]);
    expect(await rules(p5, 'src/security/sanitise/findIframes.ts')).toEqual([]);
    expect(await rules(p5, 'src/security/sanitise/importText.test.ts')).toEqual([]);
    const fb =
      "import { ParserFeedbackSimulator } from 'parse5-sax-parser/feedback';\nexport { ParserFeedbackSimulator };\n";
    expect(await rules(fb, 'src/security/sanitise/importText.ts')).toEqual([BOUNDARY]);
    expect(await rules(fb, 'src/security/sanitise/findIframes.ts')).toEqual([]);
    expect(await rules("export const m = import('parse5');\n", 'src/x.ts')).toEqual([BOUNDARY]);
  });

  it('no HTML or XML renderer, no minimist, and the bare SAX package only in its test', async () => {
    expect(
      await rules(
        "import { HtmlRenderer } from 'commonmark';\nexport const r = new HtmlRenderer();\n",
        'src/security/sanitise/markdown.tsx',
      ),
    ).toEqual([BOUNDARY, BOUNDARY]);
    expect(
      await rules(
        "import * as cm from 'commonmark';\nexport const r = new cm.XmlRenderer();\n",
        'src/security/sanitise/markdown.tsx',
      ),
    ).toEqual([BOUNDARY]);
    expect(
      await rules("import m from 'minimist';\nexport { m };\n", 'src/security/sanitise/x.ts'),
    ).toEqual([BOUNDARY]);
    const sax = "import { SAXParser } from 'parse5-sax-parser';\nexport { SAXParser };\n";
    expect(await rules(sax, 'src/security/sanitise/findIframes.ts')).toEqual([BOUNDARY]);
    expect(await rules(sax, 'src/security/sanitise/findIframes.test.ts')).toEqual([]);
  });
});

describe('unit:security-lint: configuration', () => {
  it('the full config applies security/* to src/x.tsx and e2e/x.spec.ts', async () => {
    const full = new ESLint({ cwd });
    const src = (await full.calculateConfigForFile('src/x.tsx')) as {
      rules?: Record<string, unknown>;
    };
    expect(src.rules?.[NO_IFRAME]).toEqual([2]);
    expect(src.rules?.[BOUNDARY]).toEqual([2]);
    expect(src.rules?.[HTML_SINK]).toEqual([2]);
    const e2e = (await full.calculateConfigForFile('e2e/x.spec.ts')) as {
      rules?: Record<string, unknown>;
    };
    expect(e2e.rules?.[NO_IFRAME]).toEqual([2]);
    expect(e2e.rules?.[HTML_SINK]).toEqual([2]);
  });
});
