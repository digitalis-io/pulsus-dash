/**
 * The ST mode banner (plan #68 C2d2 §4.4, §5 `banner`; T03 §9.2): one `role="status"` line per
 * reason, "ask your admin" only for a page that is not cross-origin isolated, and nothing in any
 * other mode or before the engine mode is known.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EngineMode } from '../engine';
import { EngineModeBanner } from './EngineModeBanner';

const TEXT = {
  isolation: 'Reduced performance: cross-origin isolation is off (ask your admin).',
  waitAsync: 'Reduced performance: this browser lacks a feature the fast chart engine needs.',
  forced: 'Reduced performance: the single-thread chart engine was requested for this page.',
} as const;

describe('EngineModeBanner (T03 §9.2)', () => {
  it.each(Object.entries(TEXT) as [keyof typeof TEXT, string][])(
    'ST for %s: its own text',
    (reason, text) => {
      render(<EngineModeBanner mode={{ mode: 'st', reason }} />);
      const s = screen.getByRole('status');
      expect(s.textContent).toBe(text);
      expect(s.textContent.includes('ask your admin')).toBe(reason === 'isolation');
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it.each<[string, EngineMode | null]>([
    ['mt', { mode: 'mt' }],
    ['canvas2d', { mode: 'canvas2d' }],
    ['not known yet', null],
  ])('nothing in %s', (_name, mode) => {
    const { container } = render(<EngineModeBanner mode={mode} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
