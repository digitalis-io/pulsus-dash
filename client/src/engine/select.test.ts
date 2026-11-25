import { describe, expect, it } from 'vitest';
import { chooseEngine, type Probe } from './select';

/** Every capability present, no flag (plan #68 C1 §3.5, D-SEL). */
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

describe('chooseEngine (D-SEL, T03-025)', () => {
  it.each<[string, Partial<Probe>, ReturnType<typeof chooseEngine>]>([
    ['(1) no flag', {}, { kind: 'canvas2d' }],
    ['(2) ?engine=wasm', { search: '?engine=wasm' }, { kind: 'wasm', forceT2: false }],
    ['(3) + mode=t2', { search: '?engine=wasm&mode=t2' }, { kind: 'wasm', forceT2: true }],
    ['(4) + mode=st', { search: '?engine=wasm&mode=st' }, { kind: 'canvas2d' }],
    ['(5) + mode=mtr', { search: '?engine=wasm&mode=mtr' }, { kind: 'canvas2d' }],
    ['(6) + mode=static', { search: '?engine=wasm&mode=static' }, { kind: 'canvas2d' }],
    ['(7) not isolated', { search: '?engine=wasm', isolated: false }, { kind: 'canvas2d' }],
    ['(8) no OffscreenCanvas', { search: '?engine=wasm', offscreen: false }, { kind: 'canvas2d' }],
    [
      '(9) no GPU API',
      { search: '?engine=wasm', webgpu: false, webgl2: false },
      { kind: 'canvas2d' },
    ],
    ['(10) no Atomics.waitAsync', { search: '?engine=wasm', waitAsync: false }, { kind: 'canvas2d' }],
    [
      '(11) failed this session',
      { search: '?engine=wasm', failedThisSession: true },
      { kind: 'canvas2d' },
    ],
    [
      '(12) the URL beats the build flag',
      { search: '?engine=canvas2d', buildFlag: 'wasm' },
      { kind: 'canvas2d' },
    ],
  ])('%s', (_name, p, want) => {
    expect(chooseEngine({ ...ALL, ...p })).toEqual(want);
  });

  it('the build flag alone selects the engine; WebGL2 alone is enough', () => {
    expect(chooseEngine({ ...ALL, buildFlag: 'wasm', webgpu: false })).toEqual({
      kind: 'wasm',
      forceT2: false,
    });
  });
});
