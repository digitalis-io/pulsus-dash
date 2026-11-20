/**
 * `ci:lockfile` (ADR-0014 §7): exact versions in package.json; lockfile v3; every locked package
 * resolved from the npm registry with an sha512 integrity hash.
 *
 * Usage: node scripts/check-lockfile.ts [dir]   (dir holds package.json and package-lock.json)
 * Exit: 0 no findings, 1 findings, 2 unreadable input.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, readJson, record, runCli, type Finding } from './lib/report.ts';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXACT = /^\d+\.\d+\.\d+$/;
const REGISTRY = 'https://registry.npmjs.org/';

export function checkLockfile(pkgJson: unknown, lockJson: unknown): Finding[] {
  const pkg = record(pkgJson, 'package.json');
  const lock = record(lockJson, 'package-lock.json');
  const findings: Finding[] = [];

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = pkg[field];
    if (deps === undefined) continue;
    for (const [name, version] of Object.entries(record(deps, `package.json ${field}`))) {
      if (typeof version !== 'string' || !EXACT.test(version)) {
        findings.push({
          rule: 'non-exact-version',
          file: 'package.json',
          subject: name,
          message: `${name} must be an exact version, not ${JSON.stringify(version)}`,
        });
      }
    }
  }

  if (lock['lockfileVersion'] !== 3) {
    findings.push({
      rule: 'lockfile-version',
      file: 'package-lock.json',
      subject: String(lock['lockfileVersion']),
      message: 'lockfileVersion must be 3',
    });
  }

  const packages = isRecord(lock['packages']) ? lock['packages'] : {};
  for (const [key, value] of Object.entries(packages)) {
    if (key === '') continue;
    const entry = record(value, `package-lock.json packages["${key}"]`);
    if (entry['link'] === true) continue;
    const resolved = entry['resolved'];
    if (typeof resolved !== 'string' || !resolved.startsWith(REGISTRY)) {
      findings.push({
        rule: 'non-registry-resolved',
        file: 'package-lock.json',
        subject: key,
        message: `${key} is not resolved from ${REGISTRY}`,
      });
    }
    const integrity = entry['integrity'];
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
      findings.push({
        rule: 'missing-integrity',
        file: 'package-lock.json',
        subject: key,
        message: `${key} has no sha512 integrity hash`,
      });
    }
  }
  return findings;
}

export function checkLockfileDir(dir: string): Finding[] {
  return checkLockfile(
    readJson(join(dir, 'package.json')),
    readJson(join(dir, 'package-lock.json')),
  );
}

if (import.meta.main) await runCli(() => checkLockfileDir(process.argv[2] ?? CLIENT_ROOT));
