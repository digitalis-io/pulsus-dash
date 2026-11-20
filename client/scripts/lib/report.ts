import { readFileSync } from 'node:fs';

/**
 * One finding format for every checker script:
 *   error[<rule>] <path>[:<line>]: <msg>
 * plus a GitHub Actions annotation when GITHUB_ACTIONS is "true". Scripts never print environment
 * values or URLs that are not in the lockfile or the build.
 */
export type Severity = 'error' | 'warning';

export interface Finding {
  rule: string;
  file: string;
  line?: number;
  /** What the finding is about (package name, URL, artefact), for tests and messages. */
  subject?: string;
  message: string;
  severity?: Severity;
}

export function isError(f: Finding): boolean {
  return (f.severity ?? 'error') === 'error';
}

export function formatFinding(f: Finding): string {
  const where = f.line === undefined ? f.file : `${f.file}:${String(f.line)}`;
  return `${f.severity ?? 'error'}[${f.rule}] ${where}: ${f.message}`;
}

function annotation(f: Finding): string {
  const kind = f.severity ?? 'error';
  const line = f.line === undefined ? '' : `,line=${String(f.line)}`;
  const msg = `${f.rule}: ${f.message}`
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  return `::${kind} file=${f.file}${line}::${msg}`;
}

/** Prints findings; returns the exit code (0 none or only warnings, 1 errors). */
export function report(findings: readonly Finding[]): number {
  const gh = process.env['GITHUB_ACTIONS'] === 'true';
  for (const f of findings) {
    console.error(formatFinding(f));
    if (gh) console.error(annotation(f));
  }
  return findings.some(isError) ? 1 : 0;
}

/** Thrown for unreadable or unparsable input (exit code 2). */
export class InputError extends Error {
  override name = 'InputError';
}

/** Runs a checker CLI: findings → 0/1, `InputError` (or any thrown error) → 2. */
export async function runCli(
  fn: () => Promise<readonly Finding[]> | readonly Finding[],
): Promise<void> {
  try {
    process.exitCode = report(await fn());
  } catch (e) {
    console.error(`error[input] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  }
}

/** Reads and parses a JSON file; unreadable or invalid input is an `InputError` (exit 2). */
export function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new InputError(`cannot read ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError(`${path} is not valid JSON`);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function record(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new InputError(`${what} is not an object`);
  return v;
}
