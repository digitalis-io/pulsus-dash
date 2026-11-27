/**
 * A geomap panel's body (plan #234 Part 3 §4.10). Stub (tests first).
 */
import type { ComponentType, JSX } from 'react';
import type { GeoMapFrameHostProps } from '../../charts/GeoMapFrame';

/** The host chunk's import, replaceable in tests. */
export const geoMapChunk = {
  load: (): Promise<{ default: ComponentType<GeoMapFrameHostProps> }> =>
    import('../../charts/GeoMapFrame'),
  /** Reload's action. */
  reload: (): void => {
    globalThis.location.reload();
  },
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function GeoMapBody(p: Omit<GeoMapFrameHostProps, 'onLoadFailed'>): JSX.Element | null {
  return null;
}
