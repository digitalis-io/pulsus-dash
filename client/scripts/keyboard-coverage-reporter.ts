/**
 * The `e2e:a11y-rooms` check inside `playwright test` (#130): at the end of a full run (no filter) it
 * checks each project's keyboard part files (`scripts/keyboard-coverage.ts`) and fails the run on any
 * finding, so a local `npm run e2e` still enforces the coverage rule. A filtered run (a CI shard, a
 * grep, a file or line argument) cannot hold every part: it prints why it is not checked and leaves
 * the status alone; CI checks the merged shards in the `e2e-report` job.
 */
import type {
  FullConfig,
  FullProject,
  FullResult,
  Reporter,
  Suite,
} from '@playwright/test/reporter';
import { partOfTitle, type KeyboardPart } from '../e2e/keyboardParts.ts';
import { checkKeyboardCoverageDir } from './keyboard-coverage.ts';
import { formatFinding, InputError } from './lib/report.ts';

/** CLI flags that select tests (bare, or `--flag=value`). */
const FILTER_FLAGS = [
  '-g',
  '--grep',
  '--grep-invert',
  '--shard',
  '--last-failed',
  '--only-changed',
  '--test-list',
  '--test-list-invert',
  '--list',
];
/** CLI flags whose space-form value is the next token (not a file filter). */
const VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '--project',
  '--reporter',
  '-j',
  '--workers',
  '--output',
  '--trace',
  '--retries',
  '--timeout',
  '--global-timeout',
  '--repeat-each',
  '--max-failures',
  '--tsconfig',
]);

type Grep = RegExp | RegExp[] | null | undefined;

/** `grep` other than Playwright's default `/.*\/`. */
const filtersGrep = (g: Grep): boolean =>
  g !== null &&
  g !== undefined &&
  !(g instanceof RegExp && g.source === '.*' && g.flags === '') &&
  !(Array.isArray(g) && g.length === 1 && g[0]?.source === '.*' && g[0].flags === '');
const filtersGrepInvert = (g: Grep): boolean =>
  g !== null && g !== undefined && !(Array.isArray(g) && g.length === 0);

/** Why the run is filtered (the first matching rule), or undefined for a full run. */
export function runFilter(
  config: FullConfig,
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): string | undefined {
  const shard = env['E2E_SHARD'];
  if (shard !== undefined && shard !== '') return `E2E_SHARD=${shard}`;
  if (config.shard !== null) return 'shard';
  const projects: Pick<FullProject, 'grep' | 'grepInvert'>[] = config.projects;
  if (
    filtersGrep(config.grep) ||
    filtersGrepInvert(config.grepInvert) ||
    projects.some((p) => filtersGrep(p.grep) || filtersGrepInvert(p.grepInvert))
  ) {
    return 'grep';
  }
  const at = argv.indexOf('test');
  const args = at === -1 ? [] : argv.slice(at + 1);
  for (const a of args) {
    const flag = FILTER_FLAGS.find((f) => a === f || a.startsWith(`${f}=`));
    if (flag !== undefined) return flag;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (VALUE_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('-')) return `files ${a}`;
  }
  return undefined;
}

interface ProjectRun {
  name: string;
  outputDir: string;
  parts: KeyboardPart[];
}

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export default class KeyboardCoverageReporter implements Reporter {
  private filter: string | undefined;
  private projects: ProjectRun[] = [];

  onBegin(config: FullConfig, suite: Suite): void {
    this.filter = runFilter(config, process.env, process.argv);
    this.projects = suite.suites.flatMap((s) => {
      const p = s.project();
      if (p === undefined) return [];
      const parts = s
        .allTests()
        .map((t) => partOfTitle(t.title))
        .filter((x): x is KeyboardPart => x !== undefined);
      return [{ name: p.name, outputDir: p.outputDir, parts: [...new Set(parts)].sort() }];
    });
  }

  onEnd(): Promise<{ status?: FullResult['status'] } | undefined> {
    let failed = false;
    for (const p of this.projects) {
      const tag = `keyboard-coverage ${p.name}:`;
      if (this.filter !== undefined) {
        const has = p.parts.length === 0 ? 'no part' : p.parts.join(', ');
        say(`${tag} not checked (${this.filter}; run has ${has})`);
        continue;
      }
      try {
        const findings = checkKeyboardCoverageDir(p.outputDir, p.name);
        for (const f of findings) {
          say(`${tag} ${f.rule} ${f.subject ?? ''}`);
          say(`  ${formatFinding(f)}`);
        }
        if (findings.length > 0) failed = true;
      } catch (e) {
        if (!(e instanceof InputError)) throw e;
        say(`${tag} error[input] ${e.message}`);
        failed = true;
      }
    }
    return Promise.resolve(failed ? { status: 'failed' } : undefined);
  }

  printsToStdio(): boolean {
    return false;
  }
}
