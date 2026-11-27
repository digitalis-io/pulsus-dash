/** The line area's piecewise edge rule (#282 Part 2b §3.4, ADR-0036): stub. */
export interface AreaPiece {
  readonly cls: 'A' | 'I' | 'B';
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export function areaPieces(
  _x0: number,
  _x1: number,
  _va: number,
  _vb: number,
  _min: number,
  _max: number,
  _top: number,
  _height: number,
): AreaPiece[] {
  return [];
}
