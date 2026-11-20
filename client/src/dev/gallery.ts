import type { FrameData, TimeWindow, VisSpec } from '../engine/api';

export const GALLERY_SEED = 20261120;
export type GalleryId =
  'line-1' | 'line-50' | 'line-gaps' | 'line-600' | 'heatmap' | 'bars' | 'stat';
export interface GalleryEntry {
  readonly id: GalleryId;
  readonly spec: VisSpec;
  readonly data: FrameData;
}

export function galleryEntries(_w: TimeWindow, _seed?: number): GalleryEntry[] {
  throw new Error('not implemented');
}
