/**
 * `ci:token-lint` (T01-010, T02-004, VL-021): no colour, size or duration literal and no state
 * colour outside the generated tokens and `theme/stateEncoding`. Parsers only, no regex over
 * source text: CSS through `postcss` and `scripts/lib/tokenValue.ts`; TypeScript through ESLint with
 * the rules of `eslint/tokens-plugin.ts`.
 *
 * Usage: node scripts/token-lint.ts [root]   (root defaults to the client directory)
 * Exit: 0 no findings, 1 findings, 2 a file does not parse.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import postcss from 'postcss';
import tseslint from 'typescript-eslint';
import tokens, { TOKEN_RULE_IDS } from '../eslint/tokens-plugin.ts';
import { InputError, runCli, type Finding } from './lib/report.ts';
import { classifyValue, TOKEN_MESSAGES, type TokenRule } from './lib/tokenValue.ts';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const GENERATED = new Set(['src/styles/tokens.css', 'src/styles/tokens.ts']);
const STATE_ENCODING_CSS = 'src/theme/stateEncoding.module.css';
const UI_DIRS = /^src\/(?:app|shell|kit|pages|theme)\//;
const AT_RULE_RULES: ReadonlySet<TokenRule> = new Set(['state-token', 'colour-literal']);

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

/** Source files under `<root>/src`, relative to root with `/` separators. */
export function sourceFiles(root: string): string[] {
  const all: string[] = [];
  walk(join(root, 'src'), all);
  return all
    .map((p) => relative(root, p).split(sep).join('/'))
    .filter((p) => /\.(?:css|ts|tsx)$/.test(p))
    .filter((p) => !GENERATED.has(p) && !/\.test\.tsx?$/.test(p))
    .sort();
}

/** The CSS pass: every declaration value and every at-rule's params. */
export function lintCss(file: string, text: string): Finding[] {
  let root;
  try {
    root = postcss.parse(text, { from: file });
  } catch (e) {
    throw new InputError(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const findings: Finding[] = [];
  const add = (
    rules: Set<TokenRule>,
    line: number | undefined,
    only?: ReadonlySet<TokenRule>,
  ): void => {
    for (const rule of rules) {
      if (only !== undefined && !only.has(rule)) continue;
      if (rule === 'state-token' && file === STATE_ENCODING_CSS) continue;
      findings.push({
        rule,
        file,
        ...(line === undefined ? {} : { line }),
        message: TOKEN_MESSAGES[rule],
      });
    }
  };
  root.walkDecls((d) => {
    add(classifyValue(d.value), d.source?.start?.line);
  });
  root.walkAtRules((a) => {
    add(classifyValue(a.params), a.source?.start?.line, AT_RULE_RULES);
  });
  return findings;
}

/** The TypeScript pass: ESLint with only the token rules, inline configuration ignored. */
export async function lintTs(root: string, files: readonly string[]): Promise<Finding[]> {
  if (files.length === 0) return [];
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
        },
        linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
        plugins: { tokens },
        rules: Object.fromEntries(TOKEN_RULE_IDS.map((id) => [id, 'error'])),
      },
    ],
  });
  const results = await eslint.lintFiles(files.map((f) => join(root, f)));
  const findings: Finding[] = [];
  for (const r of results) {
    const file = relative(root, r.filePath).split(sep).join('/');
    for (const m of r.messages) {
      if (m.fatal === true) throw new InputError(`${file}:${String(m.line)}: ${m.message}`);
      if (m.ruleId?.startsWith('tokens/') !== true) continue;
      const rule = m.ruleId.slice('tokens/'.length);
      if ((rule === 'size-literal' || rule === 'duration-literal') && !UI_DIRS.test(file)) continue;
      findings.push({ rule, file, line: m.line, message: m.message });
    }
  }
  return findings;
}

export async function lintTokens(rootDir: string): Promise<Finding[]> {
  const root = resolve(rootDir);
  const files = sourceFiles(root);
  const findings: Finding[] = [];
  for (const f of files.filter((x) => x.endsWith('.css'))) {
    findings.push(...lintCss(f, readFileSync(join(root, f), 'utf8')));
  }
  findings.push(
    ...(await lintTs(
      root,
      files.filter((x) => !x.endsWith('.css')),
    )),
  );
  return findings.sort((a, b) =>
    a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file < b.file ? -1 : 1,
  );
}

if (import.meta.main) await runCli(() => lintTokens(resolve(process.argv[2] ?? CLIENT_ROOT)));
