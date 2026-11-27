// `unit:platform-face` (#282; VL-010, VL-011 as amended, ADR-0035).
import { describe, expect, it } from 'vitest';
import { STAT_FONT } from '../engine/canvas2d/layout';
import { applyPlatform, isApplePlatform, type PlatformNavigator } from './platform';

const nav = (platform: string, uaData?: string): PlatformNavigator =>
  uaData === undefined ? { platform } : { platform, userAgentData: { platform: uaData } };

describe('unit:platform-face', () => {
  it('detects macOS, iPadOS and iOS, userAgentData first', () => {
    expect(isApplePlatform(nav('MacIntel'))).toBe(true);
    expect(isApplePlatform(nav('iPhone'))).toBe(true);
    expect(isApplePlatform(nav('iPad'))).toBe(true);
    expect(isApplePlatform(nav('Linux x86_64', 'macOS'))).toBe(true);
    expect(isApplePlatform(nav('Win32'))).toBe(false);
    expect(isApplePlatform(nav('Linux x86_64'))).toBe(false);
    expect(isApplePlatform(nav('MacIntel', 'Windows'))).toBe(false);
  });

  it('sets data-platform="apple" on Apple systems and removes it otherwise, idempotently', () => {
    const root = document.createElement('html');
    applyPlatform(root, nav('MacIntel'));
    applyPlatform(root, nav('MacIntel'));
    expect(root.getAttribute('data-platform')).toBe('apple');
    applyPlatform(root, nav('Win32'));
    expect(root.hasAttribute('data-platform')).toBe(false);
    applyPlatform(root, nav('Win32'));
    expect(root.hasAttribute('data-platform')).toBe(false);
  });

  it('keeps canvas text in Inter on every platform', () => {
    expect(STAT_FONT).toContain('"Inter Variable"');
  });
});
