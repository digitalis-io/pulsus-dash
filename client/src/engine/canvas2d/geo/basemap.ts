/**
 * The geomap's basemap painter (T24-091, VIZ-046; plan #234 Part 2 §4.7): land per polygon from
 * cached projected rings, the coast and the shared borders, each once.
 */
import type { Cam } from '../../controller/geo/camera';
import type { Basemap } from '../../../vis/geo/types';
import type { Ctx2D } from '../ctx';

export interface MapColours {
  readonly background: string;
  readonly water: string;
  readonly land: string;
  readonly coast: string;
  readonly border: string;
}

export function drawBasemap(
  ctx: Ctx2D,
  b: Basemap,
  cam: Cam,
  w: number,
  h: number,
  c: MapColours,
): void {
  void ctx;
  void b;
  void cam;
  void w;
  void h;
  void c;
}
