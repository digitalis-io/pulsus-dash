import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./pack-assets.ts', import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pack-assets-'));
  dirs.push(d);
  return d;
}

function pack(...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Every file under dir, as sorted relative paths with `/`. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** A build output: index.html (compressible, > 256 B), a 300-byte JS file, a font, the Vite manifest. */
function dist(): string {
  const d = tmp();
  mkdirSync(join(d, 'assets'));
  mkdirSync(join(d, '.vite'));
  writeFileSync(
    join(d, 'index.html'),
    `<!doctype html><html><head>${'<meta name="x" content="y">'.repeat(20)}</head><body></body></html>`,
  );
  writeFileSync(
    join(d, 'assets', 'a.js'),
    `export const a = '${'a'.repeat(280)}';\n`.slice(0, 300),
  );
  writeFileSync(join(d, 'assets', 'f.woff2'), Buffer.alloc(400, 7));
  writeFileSync(join(d, '.vite', 'manifest.json'), '{}');
  return d;
}

describe('pack-assets (P1)', () => {
  it('copies, compresses, lists and signs the build deterministically', () => {
    const keys = tmp();
    const keyRun = pack('--gen-key', keys);
    expect(keyRun.code).toBe(0);
    const pubText = readFileSync(join(keys, 'asset-signing.pub'), 'utf8');
    const keyText = readFileSync(join(keys, 'asset-signing.key'), 'utf8');
    expect(pubText).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(statSync(join(keys, 'asset-signing.key')).mode & 0o777).toBe(0o600);
    expect(keyRun.stdout + keyRun.stderr).not.toContain(pubText);
    expect(keyRun.stdout + keyRun.stderr).not.toContain('PRIVATE KEY');
    expect(keyText).toContain('PRIVATE KEY');

    const input = dist();
    const out = join(tmp(), 'out');
    const run = pack('--in', input, '--out', out, '--key', join(keys, 'asset-signing.key'));
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/^packed \d+ files \(\d+ compressed variants\) into /);

    const all = files(out);
    expect(all.some((p) => p.startsWith('.vite/'))).toBe(false);
    expect(all).toContain('assets/a.js.br');
    expect(all).toContain('assets/a.js.gz');
    expect(all).toContain('index.html.br');
    expect(all).toContain('index.html.gz');
    expect(all.some((p) => p.startsWith('assets/f.woff2.'))).toBe(false);
    for (const v of all.filter((p) => /\.(br|gz)$/.test(p))) {
      expect(statSync(join(out, v)).size).toBeLessThan(
        statSync(join(out, v.replace(/\.(br|gz)$/, ''))).size,
      );
    }

    const manifestBytes = readFileSync(join(out, 'asset-manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      version: number;
      files: { path: string; sha384: string; size: number }[];
    };
    expect(manifest.version).toBe(1);
    const listed = manifest.files.map((f) => f.path);
    expect(listed).toEqual(all.filter((p) => !p.startsWith('asset-manifest.')));
    expect([...listed].sort()).toEqual(listed);
    for (const f of manifest.files) {
      const b = readFileSync(join(out, f.path));
      expect(f.size, f.path).toBe(b.length);
      expect(f.sha384, f.path).toBe(createHash('sha384').update(b).digest('base64'));
    }
    expect(manifestBytes.toString('utf8')).toBe(`${JSON.stringify(manifest, null, 2)}\n`);

    const sig = readFileSync(join(out, 'asset-manifest.sig'));
    expect(sig.length).toBe(64);
    const der = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(pubText, 'base64'),
    ]);
    const pub = createPublicKey({ key: der, format: 'der', type: 'spki' });
    expect(verify(null, manifestBytes, pub, sig)).toBe(true);

    const out2 = join(tmp(), 'out');
    expect(pack('--in', input, '--out', out2, '--key', join(keys, 'asset-signing.key')).code).toBe(
      0,
    );
    expect(files(out2)).toEqual(all);
    for (const p of all) {
      expect(readFileSync(join(out2, p)).equals(readFileSync(join(out, p))), p).toBe(true);
    }
  });
});

describe('pack-assets errors (P2)', () => {
  it('exits 2 for a missing input directory and for a symlink, printing no key material', () => {
    const keys = tmp();
    expect(pack('--gen-key', keys).code).toBe(0);
    const key = join(keys, 'asset-signing.key');
    const keyText = readFileSync(key, 'utf8');
    const pubText = readFileSync(join(keys, 'asset-signing.pub'), 'utf8');

    const missing = pack('--out', join(tmp(), 'o'), '--key', key);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/^pack: /);

    const absent = pack('--in', join(tmp(), 'nope'), '--out', join(tmp(), 'o'), '--key', key);
    expect(absent.code).toBe(2);
    expect(absent.stderr).toMatch(/^pack: /);

    const input = dist();
    symlinkSync(join(input, 'index.html'), join(input, 'assets', 'link.html'));
    const out = join(tmp(), 'o');
    const link = pack('--in', input, '--out', out, '--key', key);
    expect(link.code).toBe(2);
    expect(link.stderr).toBe('pack: symlink in build output: assets/link.html\n');

    for (const r of [missing, absent, link]) {
      const text = r.stdout + r.stderr;
      expect(text).not.toContain(pubText);
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain(keyText.split('\n')[1] ?? 'unreachable');
    }
    expect(existsSync(join(out, 'asset-manifest.sig'))).toBe(false);
  });
});
