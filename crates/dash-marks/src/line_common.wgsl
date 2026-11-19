// Shared part of the M1 line mark shaders (plan #24 §3.5, §4.3, §4.4). Prepended to
// line_decimate_cs.wgsl, line_decimate_fs.wgsl and line_draw.wgsl, which declare `values_tex`
// and `bounds_tex` at their own bindings. Records are decided by integer and compare operations
// only, so the CPU specification (`dash_scales::lod`), T1 and T2 agree bit for bit (T02-015).

struct LineUniforms {
    canvas_px: vec2<f32>,
    plot_origin_px: vec2<f32>,
    plot_size_px: vec2<f32>,
    c0: f32,
    s: f32,
    a_y: f32,
    half_w: f32,
    slots: u32,
    margin: u32,
    radius: u32,
    series: u32,
    n: u32,
    tex_w: u32,
    levels: u32,
    k0: i32,
    k_l: u32,
    k_r: u32,
    colour: vec4<f32>,
    pyr_base: vec4<u32>,
    pyr_len: vec4<u32>,
    tile_w: u32,
    k_from_c: u32,
    pad0: u32,
    pad1: u32,
    series_d: array<vec4<f32>, 256>,
};

@group(0) @binding(0) var<uniform> u: LineUniforms;

const NULL_BITS: u32 = 0x7FC00000u;
const OVERFLOW_BITS: u32 = 0x7FC00001u;
const NONE_U32: u32 = 0xFFFFFFFFu;
const PYRAMID_B: u32 = 8u;
const ANY_NULL: u32 = 1u;
const ALL_NULL: u32 = 2u;

// One slot's record: a = [min0, max0, min1, max1], b = [min2, max2, last, next].
struct Rec {
    a: vec4<u32>,
    b: vec4<u32>,
};

fn empty_rec() -> Rec {
    return Rec(vec4<u32>(NULL_BITS), vec4<u32>(NULL_BITS));
}

// Linear index → texel (x, y, layer) of a tex_w × tex_w × layers texture.
fn texel(x: u32) -> vec3<u32> {
    let w = u.tex_w;
    return vec3<u32>(x % w, (x / w) % w, x / (w * w));
}

fn value_bits(i: u32, k: u32) -> u32 {
    let t = texel(i * u.n + k);
    return textureLoad(values_tex, t.xy, t.z, 0).x;
}

fn bound(j: u32) -> u32 {
    return textureLoad(bounds_tex, vec2<u32>(j % u.tile_w, j / u.tile_w), 0).x;
}

// The sample range [lo, hi) of slot s: 0 = k_l, then one per column, the last = k_r.
fn slot_range(s: u32) -> vec2<u32> {
    let last = u.slots - 1u;
    if (s == 0u) {
        if (u.k_l == NONE_U32) {
            return vec2<u32>(0u, 0u);
        }
        return vec2<u32>(u.k_l, u.k_l + 1u);
    }
    if (s >= last) {
        if (s > last || u.k_r == NONE_U32) {
            return vec2<u32>(0u, 0u);
        }
        return vec2<u32>(u.k_r, u.k_r + 1u);
    }
    return vec2<u32>(bound(s - 1u), bound(s));
}

// Integer order key of value bits: the same order as f32 (no NaN, no -0), exact for every
// normal and subnormal value.
fn key(b: u32) -> u32 {
    if ((b & 0x80000000u) != 0u) {
        return ~b;
    }
    return b | 0x80000000u;
}

fn bmin(a: u32, b: u32) -> u32 {
    if (a == NULL_BITS || (b != NULL_BITS && key(b) < key(a))) {
        return b;
    }
    return a;
}

fn bmax(a: u32, b: u32) -> u32 {
    if (a == NULL_BITS || (b != NULL_BITS && key(b) > key(a))) {
        return b;
    }
    return a;
}

// PYRAMID_B^l.
fn bpow(l: u32) -> u32 {
    var p = 1u;
    for (var j = 0u; j < l; j = j + 1u) {
        p = p * PYRAMID_B;
    }
    return p;
}

// [min, max, flags, 0] of the level-lvl block holding sample k of series i.
fn entry(pyr: texture_2d_array<u32>, i: u32, lvl: u32, k: u32) -> vec4<u32> {
    if (lvl == 0u) {
        let v = value_bits(i, k);
        return vec4<u32>(v, v, select(0u, ANY_NULL | ALL_NULL, v == NULL_BITS), 0u);
    }
    let l = lvl - 1u;
    let t = texel(u.pyr_base[l] + i * u.pyr_len[l] + k / bpow(lvl));
    return textureLoad(pyr, t.xy, t.z, 0);
}

fn mixed(e: vec4<u32>) -> bool {
    return (e.z & ANY_NULL) != 0u && (e.z & ALL_NULL) == 0u;
}

// The record of slot s of series i: the pyramid walk of plan §4.3.
fn decimate_slot(pyr: texture_2d_array<u32>, i: u32, s: u32) -> Rec {
    let r = slot_range(s);
    let n = u.n;
    let lo = r.x;
    let hi = min(r.y, n);
    var out = empty_rec();
    if (lo >= hi) {
        return out;
    }
    var k = lo;
    var lvl = 0u;
    var open = false;
    var rmn = NULL_BITS;
    var rmx = NULL_BITS;
    var amn = NULL_BITS;
    var amx = NULL_BITS;
    var runs = 0u;
    var iv = array<vec2<u32>, 3>(vec2<u32>(NULL_BITS), vec2<u32>(NULL_BITS), vec2<u32>(NULL_BITS));
    loop {
        if (k >= hi) {
            break;
        }
        let s0 = bpow(lvl);
        if (lvl < u.levels && k % (PYRAMID_B * s0) == 0u && min(k + PYRAMID_B * s0, n) <= hi) {
            if (!mixed(entry(pyr, i, lvl + 1u, k))) {
                lvl = lvl + 1u;
                continue;
            }
        }
        if (min(k + s0, n) > hi) {
            lvl = lvl - 1u;
            continue;
        }
        let e = entry(pyr, i, lvl, k);
        if ((e.z & ALL_NULL) != 0u) {
            if (open) {
                runs = runs + 1u;
                if (runs <= 3u) {
                    iv[runs - 1u] = vec2<u32>(rmn, rmx);
                }
                open = false;
            }
            k = k + s0;
        } else if ((e.z & ANY_NULL) == 0u) {
            if (open) {
                rmn = bmin(rmn, e.x);
                rmx = bmax(rmx, e.y);
            } else {
                rmn = e.x;
                rmx = e.y;
                open = true;
            }
            amn = bmin(amn, e.x);
            amx = bmax(amx, e.y);
            k = k + s0;
        } else {
            lvl = lvl - 1u;
        }
    }
    if (open) {
        runs = runs + 1u;
        if (runs <= 3u) {
            iv[runs - 1u] = vec2<u32>(rmn, rmx);
        }
    }
    if (runs > 3u) {
        out.a = vec4<u32>(amn, amx, OVERFLOW_BITS, NULL_BITS);
    } else {
        out.a = vec4<u32>(iv[0].x, iv[0].y, iv[1].x, iv[1].y);
        out.b.x = iv[2].x;
        out.b.y = iv[2].y;
    }
    out.b.z = value_bits(i, hi - 1u);
    if (hi < n && s != u.slots - 1u) {
        out.b.w = value_bits(i, hi);
    }
    return out;
}
