/**
 * The platform UI face (#282; VL-010, VL-011 as amended, ADR-0035). On Apple systems the DOM uses
 * the system UI face: `data-platform="apple"` on the root switches `--font-ui` to
 * `--font-ui-apple` (global.css). Everywhere else, and on every canvas, the face is the
 * self-hosted Inter; data stays JetBrains Mono.
 */

/** The part of `navigator` the detection reads (a fake in tests). */
export interface PlatformNavigator {
  readonly platform: string;
  readonly userAgentData?: { readonly platform: string };
}

const APPLE = /^(mac|iphone|ipad|ipod)/i;

/** macOS, iPadOS ("MacIntel"), iOS; userAgentData first, then platform. */
export function isApplePlatform(nav: PlatformNavigator): boolean {
  return APPLE.test(nav.userAgentData?.platform ?? nav.platform);
}

/** Sets data-platform="apple" on root when Apple, removes it otherwise. Idempotent. */
export function applyPlatform(root: HTMLElement, nav: PlatformNavigator): void {
  if (isApplePlatform(nav)) root.setAttribute('data-platform', 'apple');
  else root.removeAttribute('data-platform');
}
