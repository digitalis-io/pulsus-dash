/**
 * The platform UI face (#282, VL-010 as amended, ADR-0035): stub until the implementation lands.
 */
export interface PlatformNavigator {
  readonly platform: string;
  readonly userAgentData?: { readonly platform: string };
}

export const isApplePlatform: (nav: PlatformNavigator) => boolean = () => false;

export const applyPlatform: (root: HTMLElement, nav: PlatformNavigator) => void = () => undefined;
