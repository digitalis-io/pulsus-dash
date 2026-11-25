/** A PNG decoder for the engine specs and the GPU smoke (node built-ins only). */
import { inflateSync } from 'node:zlib';

export interface Rgba {
  w: number;
  h: number;
  px: Uint8Array;
}

/** A non-interlaced 8-bit RGB or RGBA PNG (Playwright's screenshots) to RGBA. */
export function decodePng(png: Buffer): Rgba {
  let at = 8;
  let w = 0;
  let h = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const colour = data[9];
      if (data[8] !== 8 || (colour !== 2 && colour !== 6) || data[12] !== 0) {
        throw new Error('unsupported PNG');
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const rows = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)] ?? 0;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? (rows[y * stride + x - channels] ?? 0) : 0;
      const b = y > 0 ? (rows[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= channels && y > 0 ? (rows[(y - 1) * stride + x - channels] ?? 0) : 0;
      const p = a + b - c;
      const pr =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const pred = [0, a, b, (a + b) >> 1, pr][f] ?? 0;
      rows[y * stride + x] = ((src[x] ?? 0) + pred) & 0xff;
    }
  }
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < 3; k++) px[i * 4 + k] = rows[i * channels + k] ?? 0;
    px[i * 4 + 3] = channels === 4 ? (rows[i * channels + 3] ?? 255) : 255;
  }
  return { w, h, px };
}
