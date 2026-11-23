/**
 * `e2e:a11y-rooms` over the keyboard parts (#130, IA-015): every control any part collected was
 * operated by some part, and every required state was visited by some part, over one project's
 * part files (`e2e/keyboardParts.ts`). Every part must have exactly one file; a part that failed
 * writes none. Every `DRAIN_SKIP` key of a part must be operated by a part before it in
 * `SINGLE_TEST_ORDER` and collected by the part itself.
 *
 * Usage: node scripts/keyboard-coverage.ts <dir> <project>
 *   (<dir> is searched at any depth for `keyboard-coverage/<project>-K*.json`)
 * Exit: 0 covered, 1 findings, 2 unreadable or invalid input.
 */
import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  COVERAGE_DIR,
  DRAIN_SKIP,
  KEYBOARD_PARTS,
  REQUIRED_STATES,
  SINGLE_TEST_ORDER,
  type KeyboardPart,
  type PartCoverage,
} from '../e2e/keyboardParts.ts';
import { InputError, readJson, record, runCli, type Finding } from './lib/report.ts';

const isPart = (v: unknown): v is KeyboardPart =>
  typeof v === 'string' && (KEYBOARD_PARTS as readonly string[]).includes(v);

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new InputError(`${what} is not a list of strings`);
  }
  return v;
}

/** A part file's content; anything but version 1 of `project`'s parts is an `InputError`. */
function parsePart(v: unknown, project: string, i: number): PartCoverage {
  const what = `part file ${String(i + 1)}`;
  const r = record(v, what);
  if (r['version'] !== 1) throw new InputError(`${what}: version is not 1`);
  if (r['project'] !== project) {
    throw new InputError(`${what}: project is ${JSON.stringify(r['project'])}, not ${project}`);
  }
  const part = r['part'];
  if (!isPart(part)) throw new InputError(`${what}: part ${JSON.stringify(part)} is unknown`);
  return {
    version: 1,
    project,
    part,
    collected: strings(r['collected'], `${what} collected`),
    operated: strings(r['operated'], `${what} operated`),
    visited: strings(r['visited'], `${what} visited`),
  };
}

export function checkKeyboardCoverage(
  parts: readonly unknown[],
  project: string,
  skip: Readonly<Record<KeyboardPart, readonly string[]>> = DRAIN_SKIP,
): Finding[] {
  const file = `${COVERAGE_DIR}/${project}`;
  const parsed = parts.map((p, i) => parsePart(p, project, i));
  const findings: Finding[] = [];
  for (const id of KEYBOARD_PARTS) {
    const n = parsed.filter((p) => p.part === id).length;
    if (n === 0) {
      findings.push({
        rule: 'keyboard-part-missing',
        file,
        subject: id,
        message: `${project} has no ${id} file: the part did not run or did not pass`,
      });
    } else if (n > 1) {
      findings.push({
        rule: 'keyboard-part-duplicate',
        file,
        subject: id,
        message: `${project} has ${String(n)} ${id} files`,
      });
    }
  }
  const collected = new Set(parsed.flatMap((p) => p.collected));
  const operated = new Set(parsed.flatMap((p) => p.operated));
  const visited = new Set(parsed.flatMap((p) => p.visited));
  if (collected.size === 0) {
    findings.push({
      rule: 'keyboard-empty',
      file,
      subject: project,
      message: `no part of ${project} collected a control`,
    });
  }
  for (const key of [...collected].filter((k) => !operated.has(k)).sort()) {
    findings.push({
      rule: 'keyboard-uncovered',
      file,
      subject: key,
      message: `${key} was collected but no part operated it`,
    });
  }
  for (const state of REQUIRED_STATES.filter((s) => !visited.has(s))) {
    findings.push({
      rule: 'keyboard-unvisited',
      file,
      subject: state,
      message: `no part visited ${state}`,
    });
  }
  // A part's drain skips (`DRAIN_SKIP`): each must be operated by a part before it in the single
  // test's order, and collected by the part itself. Only parts whose file is present.
  for (const id of KEYBOARD_PARTS) {
    const own = parsed.filter((p) => p.part === id);
    if (own.length === 0) continue;
    const earlier = SINGLE_TEST_ORDER.slice(0, SINGLE_TEST_ORDER.indexOf(id));
    const backing = new Set(
      parsed.filter((p) => earlier.includes(p.part)).flatMap((p) => p.operated),
    );
    const mine = new Set(own.flatMap((p) => p.collected));
    for (const key of skip[id]) {
      if (!backing.has(key)) {
        findings.push({
          rule: 'keyboard-skip-unbacked',
          file,
          subject: `${id} ${key}`,
          message: `${id} skips ${key}, but no part before it (${earlier.join(', ') || 'none'}) operated it`,
        });
      }
      if (!mine.has(key)) {
        findings.push({
          rule: 'keyboard-skip-unused',
          file,
          subject: `${id} ${key}`,
          message: `${id} skips ${key}, but did not collect it: remove it from DRAIN_SKIP`,
        });
      }
    }
  }
  return findings;
}

/** The part files of `project` under `dir`, at any depth, sorted. A missing `dir` has none. */
export function partFiles(dir: string, project: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true, encoding: 'utf8' });
  } catch {
    return [];
  }
  return entries
    .map((e) => join(dir, e))
    .filter((p) => {
      const name = basename(p);
      return (
        basename(dirname(p)) === COVERAGE_DIR &&
        name.startsWith(`${project}-K`) &&
        name.endsWith('.json')
      );
    })
    .sort();
}

export function checkKeyboardCoverageDir(dir: string, project: string): Finding[] {
  return checkKeyboardCoverage(
    partFiles(dir, project).map((f) => readJson(f)),
    project,
  );
}

if (import.meta.main) {
  await runCli(() => {
    const [dir, project] = process.argv.slice(2);
    if (dir === undefined || project === undefined) {
      throw new InputError('usage: node scripts/keyboard-coverage.ts <dir> <project>');
    }
    return checkKeyboardCoverageDir(dir, project);
  });
}
