// The lazily imported probe module: it uses classifyUrl, findIframes and convertImportedText.
import { convertImportedText } from '../../../src/security/sanitise/importText.ts';
import { findIframes } from '../../../src/security/sanitise/findIframes.ts';
import { classifyUrl } from '../../../src/security/sanitise/url.ts';

export function run(src: string): unknown {
  return [
    classifyUrl(src, location.origin),
    findIframes(src),
    convertImportedText(src, 'markdown', location.origin),
  ];
}
