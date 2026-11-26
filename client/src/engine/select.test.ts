import { describe, expect, it } from 'vitest';
import { chooseEngine, type Probe } from './select';

/** Every capability present, no flag (plan #68 C1 §3.5; plan #256 §4.1). */
const ALL: Probe = {
  search: '',
  buildFlag: undefined,
  isolated: true,
  offscreen: true,
  webgpu: true,
  webgl2: true,
  waitAsync: true,
  failedThisSession: false,
};

const WASM = { kind: 'wasm', forceT2: false } as const;
const T2 = { kind: 'wasm', forceT2: true } as const;
const C2D = { kind: 'canvas2d' } as const;

describe('chooseEngine (ADR-0031, T03-025)', () => {
  it.each<[string, Partial<Probe>, ReturnType<typeof chooseEngine>]>([
    ['U1 no flag: the engine', {}, WASM],
    ['U2 ?engine=wasm', { search: '?engine=wasm' }, WASM],
    ['U3 ?mode=t2', { search: '?mode=t2' }, T2],
    ['U4 ?mode=st', { search: '?mode=st' }, C2D],
    ['U5 ?mode=mtr', { search: '?mode=mtr' }, C2D],
    ['U6 ?mode=static', { search: '?mode=static' }, C2D],
    ['U7 not isolated', { isolated: false }, C2D],
    ['U8 no OffscreenCanvas', { offscreen: false }, C2D],
    ['U9 no GPU API', { webgpu: false, webgl2: false }, C2D],
    ['U10 no Atomics.waitAsync', { waitAsync: false }, C2D],
    ['U11 failed this session', { failedThisSession: true }, C2D],
    ['U12 ?engine=canvas2d', { search: '?engine=canvas2d' }, C2D],
    ['U13 build flag canvas2d', { buildFlag: 'canvas2d' }, C2D],
    ['U14 the URL beats the build (on)', { search: '?engine=wasm', buildFlag: 'canvas2d' }, WASM],
    ['U15 the URL beats the build (off)', { search: '?engine=canvas2d', buildFlag: 'wasm' }, C2D],
    ['U16 ?engine= (empty)', { search: '?engine=' }, WASM],
    ['U16 ?engine=gpu', { search: '?engine=gpu' }, WASM],
    ["U16 build flag ''", { buildFlag: '' }, WASM],
    ['U17 WebGL2 only', { webgpu: false }, WASM],
    ['U17 WebGPU only', { webgl2: false }, WASM],
    ['U18 ?engine=canvas2d&mode=t2', { search: '?engine=canvas2d&mode=t2' }, C2D],
    ['U19 failed beats ?engine=wasm', { search: '?engine=wasm', failedThisSession: true }, C2D],
  ])('%s', (_name, p, want) => {
    expect(chooseEngine({ ...ALL, ...p })).toEqual(want);
  });
});
