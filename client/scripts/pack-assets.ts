/**
 * Packs the client build for the BFF (plan #59 Part B, Appendix B.2; ADR-0016, T18-006):
 * copies the build (without `.vite/`), writes a brotli and a gzip variant of each compressible
 * file when smaller, lists every file with its SHA-384 and size in `asset-manifest.json`, and
 * signs the manifest's exact bytes with Ed25519 into `asset-manifest.sig` (64 raw bytes).
 *
 * Usage:
 *   node scripts/pack-assets.ts --gen-key DIR
 *       writes DIR/asset-signing.key (PKCS#8 PEM, mode 0600) and DIR/asset-signing.pub (the raw
 *       32-byte public key, standard base64, no newline); overwrites both; prints no key material.
 *   node scripts/pack-assets.ts --in DIST --out OUT --key KEYFILE
 *
 * Exit: 0 packed; 2 with `pack: <reason>` on stderr. The output is byte-identical for identical
 * inputs and keys.
 */
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const MANIFEST = 'asset-manifest.json';
const SIGNATURE = 'asset-manifest.sig';
const KEY_FILE = 'asset-signing.key';
const PUB_FILE = 'asset-signing.pub';
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.json',
  '.txt',
  '.map',
  '.wasm',
  '.xml',
]);
const MIN_COMPRESS = 256;

/** A failure reported as `pack: <message>`, exit 2. */
class PackError extends Error {
  override name = 'PackError';
}

export interface ManifestEntry {
  path: string;
  sha384: string;
  size: number;
}

/** The build's files as relative `/` paths, `.vite/` excluded; a symlink is an error. */
function listBuild(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (p === '.vite') continue;
      if (e.isSymbolicLink()) throw new PackError(`symlink in build output: ${p}`);
      if (e.isDirectory()) walk(join(dir, e.name), p);
      else if (e.isFile()) out.push(p);
      else throw new PackError(`not a regular file in build output: ${p}`);
    }
  };
  walk(root, '');
  return out;
}

function brotli(bytes: Buffer, ext: string): Buffer {
  return brotliCompressSync(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]:
        ext === '.wasm' ? constants.BROTLI_MODE_GENERIC : constants.BROTLI_MODE_TEXT,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
}

function write(out: string, rel: string, bytes: Buffer): void {
  const p = join(out, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
}

/** Packs `input` into `out`, signed with the PEM private key at `keyFile`. */
export function pack(
  input: string,
  out: string,
  keyFile: string,
): { files: number; variants: number } {
  if (!existsSync(input) || !statSync(input).isDirectory()) {
    throw new PackError('--in is not a directory');
  }
  if (!existsSync(keyFile)) throw new PackError('--key file not found');
  const key = createPrivateKey(readFileSync(keyFile));
  if (key.asymmetricKeyType !== 'ed25519') throw new PackError('--key is not an Ed25519 key');

  // Every check on the input runs before OUT is touched.
  const sources = listBuild(input);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const files = new Map<string, Buffer>();
  let variants = 0;
  for (const rel of sources) {
    const bytes = readFileSync(join(input, ...rel.split('/')));
    files.set(rel, bytes);
    const ext = extname(rel).toLowerCase();
    if (!COMPRESSIBLE.has(ext) || bytes.length < MIN_COMPRESS) continue;
    const br = brotli(bytes, ext);
    if (br.length < bytes.length) {
      files.set(`${rel}.br`, br);
      variants++;
    }
    // Node writes the gzip header with mtime 0, so the output is reproducible.
    const gz = gzipSync(bytes, { level: 9 });
    if (gz.length < bytes.length) {
      files.set(`${rel}.gz`, gz);
      variants++;
    }
  }
  for (const [rel, bytes] of files) write(out, rel, bytes);

  // Sorted by UTF-16 code units (the default sort), as the BFF's verifier requires.
  const entries: ManifestEntry[] = [...files.keys()].sort().map((path) => {
    const bytes = files.get(path) ?? Buffer.alloc(0);
    return {
      path,
      sha384: createHash('sha384').update(bytes).digest('base64'),
      size: bytes.length,
    };
  });
  const manifest = Buffer.from(`${JSON.stringify({ version: 1, files: entries }, null, 2)}\n`);
  writeFileSync(join(out, MANIFEST), manifest);
  writeFileSync(join(out, SIGNATURE), sign(null, manifest, key));
  return { files: sources.length, variants };
}

/** Test-first stub (plan #256 §5). */
export function manifestEntries(_root: string): ManifestEntry[] {
  return [];
}

/** Writes a fresh Ed25519 key pair into `dir` (Q3: a new key for every build). */
export function genKey(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyPath = join(dir, KEY_FILE);
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  // The SPKI DER of an Ed25519 key ends with the 32 raw key bytes.
  const der = publicKey.export({ type: 'spki', format: 'der' });
  writeFileSync(join(dir, PUB_FILE), der.subarray(der.length - 32).toString('base64'));
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const known = new Set(['--gen-key', '--in', '--out', '--key']);
  const opts = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i] ?? '';
    const value = argv[i + 1];
    if (!known.has(name)) throw new PackError(`unknown option ${name}`);
    if (value === undefined) throw new PackError(`${name} needs a value`);
    opts.set(name, value);
  }
  return opts;
}

function main(argv: readonly string[]): void {
  const opts = parseArgs(argv);
  const keyDir = opts.get('--gen-key');
  if (keyDir !== undefined) {
    if (opts.size !== 1) throw new PackError('--gen-key takes no other option');
    genKey(keyDir);
    return;
  }
  const input = opts.get('--in');
  const out = opts.get('--out');
  const keyFile = opts.get('--key');
  if (input === undefined) throw new PackError('--in is required');
  if (out === undefined) throw new PackError('--out is required');
  if (keyFile === undefined) throw new PackError('--key is required');
  const { files, variants } = pack(input, out, keyFile);
  process.stdout.write(
    `packed ${String(files)} files (${String(variants)} compressed variants) into ${out}\n`,
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    // Only our own messages are printed; another error's text could quote key material.
    const msg = e instanceof PackError ? e.message : e instanceof Error ? e.name : 'Error';
    process.stderr.write(`pack: ${msg}\n`);
    process.exitCode = 2;
  }
}
