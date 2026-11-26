/**
 * unit:text-vis-roundtrip (plan #198 Part 3a §3.2, review r3 #1): `textVis` writes a text's vis in
 * the stored representation of the panel's head, so typing back to the head leaves no diff.
 */
import { describe, expect, it } from 'vitest';
import type { WidgetPanelSpec } from '../../api/types';
import { textOptions } from '../spec';
import { textVis } from './textVis';

type Vis = WidgetPanelSpec['vis'];

describe('unit:text-vis-roundtrip (textVis)', () => {
  it('an original without options and default values → no options', () => {
    const original: Vis = { kind: 'text' };
    expect(textVis(textOptions(), original)).toEqual({ kind: 'text' });
    expect(textVis(textOptions({ content: 'abc' }), original)).toEqual({
      kind: 'text',
      options: { content: 'abc' },
    });
  });

  it('keys the original holds are kept, even at their defaults', () => {
    const original: Vis = { kind: 'text', options: { mode: 'markdown', content: '' } };
    expect(textVis(textOptions({ mode: 'markdown', content: '' }), original)).toEqual(original);
  });

  it('code writes its language; Markdown drops it', () => {
    const original: Vis = { kind: 'text', options: { mode: 'markdown', content: 'x' } };
    const code = textVis({ mode: 'code', content: 'x', language: 'promql' }, original);
    expect(code).toEqual({
      kind: 'text',
      options: { mode: 'code', content: 'x', language: 'promql' },
    });
    // Plain text is the default: written only if the original holds a language.
    expect(textVis({ mode: 'code', content: 'x', language: 'plaintext' }, original)).toEqual({
      kind: 'text',
      options: { mode: 'code', content: 'x' },
    });
    const withLang: Vis = { kind: 'text', options: { mode: 'code', language: 'go' } };
    expect(textVis({ mode: 'code', content: '', language: 'plaintext' }, withLang)).toEqual({
      kind: 'text',
      options: { mode: 'code', language: 'plaintext' },
    });
    const back = textVis({ mode: 'markdown', content: 'x', language: 'promql' }, original);
    expect(back).toEqual(original);
    expect(back.options !== undefined && 'language' in back.options).toBe(false);
    // Markdown drops the language even when the original held one.
    expect(textVis({ mode: 'markdown', content: '', language: 'go' }, withLang)).toEqual({
      kind: 'text',
      options: { mode: 'markdown' },
    });
  });

  it('a new panel (no original) keeps no default', () => {
    expect(textVis(textOptions(), undefined)).toEqual({ kind: 'text' });
    expect(textVis({ mode: 'code', content: '', language: 'go' }, undefined)).toEqual({
      kind: 'text',
      options: { mode: 'code', language: 'go' },
    });
  });
});
