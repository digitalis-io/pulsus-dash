// The lazily imported probe module: it uses classifyUrl, findIframes, convertImportedText and
// renderMarkdown (plan #198 Part 2b §2: the renderer joins the probe under the same limit).
import { convertImportedText } from '../../../src/security/sanitise/importText.ts';
import { findIframes } from '../../../src/security/sanitise/findIframes.ts';
import { renderMarkdown } from '../../../src/security/sanitise/markdown.tsx';
import { classifyUrl } from '../../../src/security/sanitise/url.ts';

export function run(src: string): unknown {
  return [
    classifyUrl(src, location.origin),
    findIframes(src),
    convertImportedText(src, 'markdown', location.origin),
    renderMarkdown(src, { vars: new Map(), entity: null }, { policy: 'board', appOrigin: location.origin }),
  ];
}
