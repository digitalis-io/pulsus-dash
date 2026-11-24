import { describe, expect, it } from 'vitest';
import { t } from './t';

describe('i18n typed ids', () => {
  it('rejects unknown ids at compile time and resolves known ones', () => {
    // @ts-expect-error: 'no.such.id' is not a MessageId (npm run typecheck fails if this is unused)
    expect(() => t('no.such.id')).not.toThrow();
    expect(t('time.quick.6h')).toBe('Last 6 hours');
    expect(t('user.menu', { name: 'Ada Admin' })).toBe('User menu: Ada Admin');
    expect(t('user.menuButton', { initials: 'AA', name: 'Ada Admin' })).toBe(
      'AA, user menu: Ada Admin',
    );
  });
});
