/**
 * `ci:dep-audit` (T01-002, ADR-0014 §7), the policy half (`npm audit` runs after it):
 * - every `dependencies` entry is on `runtimeAllowlist`;
 * - the runtime closure in the lockfile equals the categorised `runtimeClosure` lists, and no
 *   category is a forbidden one;
 * - every runtime package's licence satisfies `licenceAllowlist` (SPDX; `WITH` needs an exact pair
 *   in `licenceExceptionAllowlist`).
 *
 * Usage: node scripts/check-deps.ts [dir]   (dir holds package.json, package-lock.json and
 * dependency-policy.json). Exit: 0 no findings, 1 findings, 2 unreadable input.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InputError, isRecord, readJson, record, runCli, type Finding } from './lib/report.ts';
import { satisfies } from './lib/spdx.ts';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface DependencyPolicy {
  forbiddenCategories: string[];
  runtimeAllowlist: string[];
  runtimeClosure: Record<string, string[]>;
  licenceAllowlist: string[];
  licenceExceptionAllowlist: string[];
  buildUrlAllowlist: { url: string; reason: string }[];
  installScripts: string[];
}

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === 'string')) {
    throw new InputError(`${what} must be an array of strings`);
  }
  return v;
}

export function parsePolicy(v: unknown): DependencyPolicy {
  const p = record(v, 'dependency-policy.json');
  const closure = record(p['runtimeClosure'], 'runtimeClosure');
  const urls = p['buildUrlAllowlist'] ?? [];
  if (!Array.isArray(urls)) throw new InputError('buildUrlAllowlist must be an array');
  return {
    forbiddenCategories: strings(p['forbiddenCategories'], 'forbiddenCategories'),
    runtimeAllowlist: strings(p['runtimeAllowlist'], 'runtimeAllowlist'),
    runtimeClosure: Object.fromEntries(
      Object.entries(closure).map(([k, list]) => [k, strings(list, `runtimeClosure.${k}`)]),
    ),
    licenceAllowlist: strings(p['licenceAllowlist'], 'licenceAllowlist'),
    licenceExceptionAllowlist: strings(
      p['licenceExceptionAllowlist'] ?? [],
      'licenceExceptionAllowlist',
    ),
    buildUrlAllowlist: urls.map((u: unknown, i) => {
      const r = record(u, `buildUrlAllowlist[${String(i)}]`);
      if (typeof r['url'] !== 'string' || typeof r['reason'] !== 'string') {
        throw new InputError(`buildUrlAllowlist[${String(i)}] needs url and reason`);
      }
      return { url: r['url'], reason: r['reason'] };
    }),
    installScripts: strings(p['installScripts'] ?? [], 'installScripts'),
  };
}

/** Runtime packages of the lockfile: name → licence (as written). */
export function runtimeClosure(lockJson: unknown): Map<string, unknown> {
  const lock = record(lockJson, 'package-lock.json');
  const packages = isRecord(lock['packages']) ? lock['packages'] : {};
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(packages)) {
    if (!key.includes('node_modules/')) continue;
    const entry = record(value, `packages["${key}"]`);
    if (entry['dev'] === true || entry['devOptional'] === true) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    out.set(name, entry['license']);
  }
  return out;
}

export function checkDeps(pkgJson: unknown, lockJson: unknown, policyJson: unknown): Finding[] {
  const pkg = record(pkgJson, 'package.json');
  const policy = parsePolicy(policyJson);
  const findings: Finding[] = [];
  const allow = new Set(policy.runtimeAllowlist);

  const deps = pkg['dependencies'] === undefined ? {} : record(pkg['dependencies'], 'dependencies');
  for (const name of Object.keys(deps)) {
    if (!allow.has(name)) {
      findings.push({
        rule: 'not-allowlisted',
        file: 'package.json',
        subject: name,
        message: `runtime dependency ${name} is not on runtimeAllowlist in dependency-policy.json`,
      });
    }
  }

  const forbidden = new Set(policy.forbiddenCategories);
  const listed = new Map<string, string>();
  for (const [category, names] of Object.entries(policy.runtimeClosure)) {
    if (forbidden.has(category)) {
      findings.push({
        rule: 'forbidden-category',
        file: 'dependency-policy.json',
        subject: category,
        message: `runtimeClosure category ${category} is forbidden (ADR-0014 §7)`,
      });
    }
    for (const n of names) listed.set(n, category);
  }

  const closure = runtimeClosure(lockJson);
  const licences = new Set(policy.licenceAllowlist);
  const exceptions = new Set(policy.licenceExceptionAllowlist);
  for (const [name, licence] of [...closure].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!listed.has(name)) {
      findings.push({
        rule: 'not-in-closure',
        file: 'package-lock.json',
        subject: name,
        message: `runtime package ${name} is not listed in runtimeClosure`,
      });
    }
    if (typeof licence !== 'string' || !satisfies(licence, licences, exceptions)) {
      findings.push({
        rule: 'licence',
        file: 'package-lock.json',
        subject: name,
        message: `runtime package ${name} has licence ${JSON.stringify(licence ?? null)}, not on licenceAllowlist`,
      });
    }
  }
  for (const name of [...listed.keys()].sort()) {
    if (!closure.has(name)) {
      findings.push({
        rule: 'stale-closure',
        file: 'dependency-policy.json',
        subject: name,
        message: `runtimeClosure lists ${name}, which is not in the runtime closure`,
      });
    }
  }
  return findings;
}

export function checkDepsDir(dir: string): Finding[] {
  return checkDeps(
    readJson(join(dir, 'package.json')),
    readJson(join(dir, 'package-lock.json')),
    readJson(join(dir, 'dependency-policy.json')),
  );
}

if (import.meta.main) await runCli(() => checkDepsDir(process.argv[2] ?? CLIENT_ROOT));
