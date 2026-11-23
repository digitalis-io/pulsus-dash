/**
 * `ci:e2e-complete` (#130, T05 §7.1): every test `playwright test --list` names for a project ran in
 * exactly one CI shard of it, and passed (`expected` or `flaky`), or was skipped as
 * `config/e2eSkips.ts` allows. Inputs are Playwright JSON reports: the listing, and one report per
 * shard (from `playwright merge-reports --reporter=json` of the shard's blob).
 *
 * Usage: node scripts/e2e-complete.ts <listed.json> <project> <shard.json>...
 *   (a shard's name is its file name without `.json`)
 * Exit: 0 complete, 1 findings, 2 unreadable or empty input.
 */
import { basename } from 'node:path';
import { ALLOWED_SKIPS, type AllowedSkip } from '../config/e2eSkips.ts';
import { InputError, isRecord, readJson, runCli, type Finding } from './lib/report.ts';

interface Entry {
  key: string;
  file: string;
  title: string;
  status: unknown;
  results: number;
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);

/** The tests of `project` in a JSON report, keyed `file › describe › … › title [project]`. */
function entries(report: unknown, project: string, what: string): Entry[] {
  if (!isRecord(report)) throw new InputError(`${what} is not a JSON report`);
  const out: Entry[] = [];
  const walk = (suite: unknown, path: readonly string[]): void => {
    if (!isRecord(suite)) return;
    for (const spec of list(suite['specs'])) {
      if (!isRecord(spec)) continue;
      const title = String(spec['title']);
      const file = String(spec['file']);
      for (const t of list(spec['tests'])) {
        if (!isRecord(t) || t['projectName'] !== project) continue;
        out.push({
          key: `${file} › ${[...path, title].join(' › ')} [${project}]`,
          file,
          title,
          status: t['status'],
          results: list(t['results']).length,
        });
      }
    }
    for (const child of list(suite['suites'])) {
      walk(child, [...path, isRecord(child) ? String(child['title']) : '']);
    }
  };
  // The top-level suites are files: their title is the file, not part of the title path.
  for (const fileSuite of list(report['suites'])) walk(fileSuite, []);
  return out;
}

const allows = (s: AllowedSkip, e: Pick<Entry, 'file' | 'title'>, project: string): boolean =>
  s.file === e.file && s.title === e.title && s.projects.includes(project);

export function checkE2eComplete(
  listed: unknown,
  shards: readonly { name: string; report: unknown }[],
  project: string,
): Finding[] {
  const want = entries(listed, project, 'the listing');
  if (want.length === 0) throw new InputError(`the listing has no test for ${project}`);
  if (shards.length === 0) throw new InputError('no shard report');
  const ran = new Map<string, { shard: string; e: Entry }[]>();
  for (const s of shards) {
    for (const e of entries(s.report, project, `shard ${s.name}`)) {
      ran.set(e.key, [...(ran.get(e.key) ?? []), { shard: s.name, e }]);
    }
  }
  const findings: Finding[] = [];
  const add = (rule: string, subject: string, message: string): void => {
    findings.push({ rule, file: `e2e (${project})`, subject, message });
  };
  const listedKeys = new Set(want.map((e) => e.key));
  for (const w of want) {
    const runs = ran.get(w.key) ?? [];
    if (runs.length === 0) {
      add('e2e-test-missing', w.key, 'listed, but in no shard report');
      continue;
    }
    if (runs.length > 1) {
      const names = runs.map((r) => r.shard).sort();
      add('e2e-test-duplicate', w.key, `ran ${String(runs.length)} times: ${names.join(', ')}`);
    }
    for (const { shard, e } of runs) {
      if (e.results === 0) add('e2e-test-not-run', w.key, `no result in shard ${shard}`);
      else if (e.status === 'skipped') {
        if (!ALLOWED_SKIPS.some((s) => allows(s, e, project))) {
          add(
            'e2e-test-skipped',
            w.key,
            `skipped in shard ${shard}, and not in config/e2eSkips.ts`,
          );
        }
      } else if (e.status === 'unexpected') add('e2e-test-failed', w.key, `failed in ${shard}`);
      else if (e.status !== 'expected' && e.status !== 'flaky') {
        add('e2e-test-failed', w.key, `status ${JSON.stringify(e.status)} in shard ${shard}`);
      }
    }
  }
  for (const s of ALLOWED_SKIPS.filter((x) => x.projects.includes(project))) {
    const hits = want.filter((w) => allows(s, w, project));
    const skipped = hits.some((w) =>
      (ran.get(w.key) ?? []).some((r) => r.e.status === 'skipped' && r.e.results > 0),
    );
    if (!skipped) {
      const subject = hits[0]?.key ?? `${s.file} › ${s.title} [${project}]`;
      add('e2e-skip-unused', subject, `allowed skip (${s.reason}) not listed or not skipped`);
    }
  }
  for (const [key, runs] of ran) {
    if (!listedKeys.has(key)) {
      add('e2e-test-unexpected', key, `in ${runs.map((r) => r.shard).join(', ')}, not listed`);
    }
  }
  const order = (f: Finding): string => `${f.subject ?? ''}\u0000${f.rule}`;
  return findings.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

if (import.meta.main) {
  await runCli(() => {
    const [listedPath, project, ...shardPaths] = process.argv.slice(2);
    if (listedPath === undefined || project === undefined) {
      throw new InputError(
        'usage: node scripts/e2e-complete.ts <listed.json> <project> <shard.json>...',
      );
    }
    return checkE2eComplete(
      readJson(listedPath),
      shardPaths.map((p) => ({ name: basename(p, '.json'), report: readJson(p) })),
      project,
    );
  });
}
