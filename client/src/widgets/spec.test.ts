/** Widget panels (plan #198 Part 1 §3.3, `unit:widget-spec`; T24-002, T24-003). */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardSpec } from '../api/types';
import {
  clockOptions,
  isDataPanel,
  isWidgetPanel,
  PENDING_WIDGETS,
  textOptions,
  WIDGET_KINDS,
} from './spec';

const FIXTURE = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec', 'v5-widgets.json');

describe('unit:widget-spec', () => {
  it('text options with the defaults', () => {
    expect(textOptions()).toEqual({ mode: 'markdown', content: '', language: 'plaintext' });
    expect(textOptions({ mode: 'code' })).toEqual({
      mode: 'code',
      content: '',
      language: 'plaintext',
    });
    // A board list's mode is not a text mode (board spec v6): the default.
    expect(textOptions({ mode: 'starred' }).mode).toBe('markdown');
    expect(textOptions({}).mode).toBe('markdown');
    expect(textOptions({ mode: 'code', language: 'go', content: 'x' })).toEqual({
      mode: 'code',
      content: 'x',
      language: 'go',
    });
  });

  it('clock options with the defaults', () => {
    expect(clockOptions()).toEqual({
      zones: [{ tz: '', label: '' }],
      hourCycle: 'auto',
      seconds: false,
      date: true,
      countdown: null,
    });
    const countdown = { to: '2026-11-26T14:00:00Z', label: 'M', after: 'hide' } as const;
    expect(clockOptions({ countdown })).toEqual({
      zones: [{ tz: '', label: '' }],
      hourCycle: 'auto',
      seconds: false,
      date: true,
      countdown,
    });
  });

  it('isWidgetPanel per fixture panel', () => {
    const spec = JSON.parse(readFileSync(FIXTURE, 'utf8')) as BoardSpec;
    const panels = [...spec.panels, ...spec.sections.flatMap((s) => s.panels)];
    expect(panels.map((p) => [p.id, isWidgetPanel(p)])).toEqual([
      ['p-1', true],
      ['p-2', true],
      ['p-3', true],
      ['p-4', true],
      ['p-5', false],
      ['p-6', true],
    ]);
    expect(panels.filter(isDataPanel).map((p) => p.id)).toEqual(['p-5']);
    expect([...WIDGET_KINDS].sort()).toEqual(['boardList', 'clock', 'text']);
    // Text draws from plan #198 Part 3a.
    expect([...PENDING_WIDGETS].sort()).toEqual(['boardList', 'clock']);
  });
});
