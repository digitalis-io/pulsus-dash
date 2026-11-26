import type { Plugin } from 'vite';

/** Test-first stub (plan #256 §5). */
export function previewManifest(): Plugin {
  return { name: 'preview-manifest' };
}

/** Test-first stub (plan #256 §5). */
export function isLoopbackHost(_host: string | boolean | undefined): boolean {
  return false;
}
