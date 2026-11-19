
// The M1 line draw (plan #24 §4.4): instance j = part (j & 1) of slot (j >> 1) % slots of series
// (j >> 1) / slots. Part 0 covers the slot's column by its run extents; part 1 is the connector
// from the slot's last sample to the next. `fs_line` writes coverage (Max blended); `fs_mask`
// writes the binary line coverage of the raw polyline, exactly, in 1/64 px integers.

@group(0) @binding(1) var rec_a: texture_2d_array<u32>;
@group(0) @binding(2) var rec_b: texture_2d_array<u32>;
@group(0) @binding(3) var rec_k: texture_2d_array<u32>;
@group(0) @binding(4) var values_tex: texture_2d_array<u32>;
@group(0) @binding(5) var bounds_tex: texture_2d<u32>;

const F_IV0: u32 = 1u;
const F_IV1: u32 = 2u;
const F_IV2: u32 = 4u;
const F_OVER: u32 = 8u;
const Q_MAX: f32 = 1073741824.0;

struct LineOut {
    @builtin(position) pos: vec4<f32>,
    // part, flags, series, slot lo
    @location(0) @interpolate(flat) info: vec4<u32>,
    // slot hi, column c'
    @location(1) @interpolate(flat) span: vec2<i32>,
    // part 0: [y(min0), y(max0), y(min1), y(max1)]; part 1: [x_a, y_a, x_b, y_b]
    @location(2) @interpolate(flat) ya: vec4<f32>,
    // part 0: [y(min2), y(max2)]
    @location(3) @interpolate(flat) yb: vec2<f32>,
};

// x(k) = (f32(k − k0) + c0) · s: add, then multiply.
fn x_of(k: u32) -> f32 {
    return (f32(i32(k) - u.k0) + u.c0) * u.s;
}

// y(b) = (f32(b) + d_i) · a_y: add, then multiply.
fn y_of(i: u32, b: u32) -> f32 {
    return (bitcast<f32>(b) + u.series_d[i >> 2u][i & 3u]) * u.a_y;
}

fn xq(x: f32) -> i32 {
    return i32(floor(x * 64.0));
}

fn yq(y: f32) -> i32 {
    return i32(floor(clamp(y * 64.0, -Q_MAX, Q_MAX)));
}

fn ndc(p: vec2<f32>) -> vec4<f32> {
    let c = (u.plot_origin_px + p) / u.canvas_px * 2.0 - 1.0;
    return vec4<f32>(c, 0.0, 1.0);
}

@vertex
fn vs_line(@builtin(vertex_index) vid: u32, @builtin(instance_index) j: u32) -> LineOut {
    var o: LineOut;
    o.pos = vec4<f32>(-2.0, -2.0, 0.0, 1.0);
    o.info = vec4<u32>(0u);
    o.span = vec2<i32>(0, 0);
    o.ya = vec4<f32>(0.0);
    o.yb = vec2<f32>(0.0);
    let part = j & 1u;
    let rest = j >> 1u;
    let slot = rest % u.slots;
    let i = rest / u.slots;
    if (i >= u.series) {
        return o;
    }
    let tx = vec2<u32>(slot % u.tile_w, i);
    let tl = slot / u.tile_w;
    let a = textureLoad(rec_a, tx, tl, 0);
    let b = textureLoad(rec_b, tx, tl, 0);
    let range = slot_range(slot);
    var k_last = range.y - 1u;
    if (u.k_from_c == 1u) {
        k_last = textureLoad(rec_k, tx, tl, 0).x;
    }
    let cx = (vid & 1u) == 1u;
    let cy = (vid >> 1u) == 1u;
    let h = u.half_w;
    let rr = f32(u.radius);
    if (part == 0u) {
        var flags = 0u;
        var lo = 3.0e38;
        var hi = -3.0e38;
        if (a.z == OVERFLOW_BITS) {
            flags = F_OVER;
            o.ya = vec4<f32>(y_of(i, a.x), y_of(i, a.y), 0.0, 0.0);
            lo = o.ya.x;
            hi = o.ya.y;
        } else {
            if (a.x != NULL_BITS) {
                flags = flags | F_IV0;
                o.ya.x = y_of(i, a.x);
                o.ya.y = y_of(i, a.y);
                lo = min(lo, o.ya.x);
                hi = max(hi, o.ya.y);
            }
            if (a.z != NULL_BITS) {
                flags = flags | F_IV1;
                o.ya.z = y_of(i, a.z);
                o.ya.w = y_of(i, a.w);
                lo = min(lo, o.ya.z);
                hi = max(hi, o.ya.w);
            }
            if (b.x != NULL_BITS) {
                flags = flags | F_IV2;
                o.yb = vec2<f32>(y_of(i, b.x), y_of(i, b.y));
                lo = min(lo, o.yb.x);
                hi = max(hi, o.yb.y);
            }
        }
        if (flags == 0u) {
            return o;
        }
        let cp = i32(floor(x_of(k_last)));
        let px = select(f32(cp) - rr, f32(cp) + rr + 1.0, cx);
        let py = select(lo - h - 1.0, hi + h + 1.0, cy);
        o.pos = ndc(vec2<f32>(px, py));
        o.info = vec4<u32>(0u, flags, i, range.x);
        o.span = vec2<i32>(i32(range.y), cp);
        return o;
    }
    if (b.z == NULL_BITS || b.w == NULL_BITS) {
        return o;
    }
    let xa = x_of(k_last);
    let xb = x_of(k_last + 1u);
    let y_a = y_of(i, b.z);
    let y_b = y_of(i, b.w);
    let px = select(floor(xa) - rr, floor(xb) + rr + 1.0, cx);
    let py = select(min(y_a, y_b) - h - 1.0, max(y_a, y_b) + h + 1.0, cy);
    o.pos = ndc(vec2<f32>(px, py));
    o.info = vec4<u32>(1u, 0u, i, 0u);
    o.ya = vec4<f32>(xa, y_a, xb, y_b);
    return o;
}

fn dist(y: f32, lo: f32, hi: f32) -> f32 {
    return max(max(lo - y, y - hi), 0.0);
}

fn coverage(dx: f32, dy: f32) -> f32 {
    return clamp(u.half_w + 0.5 - sqrt(dx * dx + dy * dy), 0.0, 1.0);
}

// Distance from row centre ry to the slot's runs (overflow: recomputed from the raw values).
fn run_dist(o: LineOut, ry: f32) -> f32 {
    let flags = o.info.y;
    var best = 3.0e38;
    if ((flags & F_OVER) != 0u) {
        let i = o.info.z;
        var open = false;
        var mn = 0.0;
        var mx = 0.0;
        for (var k = o.info.w; k < u32(o.span.x); k = k + 1u) {
            let b = value_bits(i, k);
            if (b == NULL_BITS) {
                if (open) {
                    best = min(best, dist(ry, mn, mx));
                    open = false;
                }
                continue;
            }
            let y = y_of(i, b);
            if (open) {
                mn = min(mn, y);
                mx = max(mx, y);
            } else {
                mn = y;
                mx = y;
                open = true;
            }
        }
        if (open) {
            best = min(best, dist(ry, mn, mx));
        }
        return best;
    }
    if ((flags & F_IV0) != 0u) {
        best = min(best, dist(ry, o.ya.x, o.ya.y));
    }
    if ((flags & F_IV1) != 0u) {
        best = min(best, dist(ry, o.ya.z, o.ya.w));
    }
    if ((flags & F_IV2) != 0u) {
        best = min(best, dist(ry, o.yb.x, o.yb.y));
    }
    return best;
}

// The connector's y at X (endpoints exact; no fusable multiply-add).
fn yi(p: vec4<f32>, x: f32) -> f32 {
    return p.y + (p.w - p.y) / ((p.z - p.x) / (x - p.x));
}

// Best coverage of column c, row centre ry by the connector p = [x_a, y_a, x_b, y_b].
fn connector_cov(p: vec4<f32>, c: i32, ry: f32) -> f32 {
    let rr = i32(u.radius);
    let c_lo = max(c - rr, i32(floor(p.x)));
    let c_hi = min(c + rr, i32(floor(p.z)));
    var best = 0.0;
    for (var cp = c_lo; cp <= c_hi; cp = cp + 1) {
        let x0 = max(f32(cp), p.x);
        let x1 = min(f32(cp + 1), p.z);
        let y0 = select(yi(p, x0), p.y, x0 == p.x);
        let y1 = select(yi(p, x1), p.w, x1 == p.z);
        let dy = dist(ry, min(y0, y1), max(y0, y1));
        best = max(best, coverage(f32(abs(c - cp)), dy));
    }
    return best;
}

fn pixel_col(pos: vec4<f32>) -> i32 {
    return i32(floor(pos.x - u.plot_origin_px.x));
}

// Plot-relative row centre (y up).
fn row_centre(pos: vec4<f32>) -> f32 {
    return (u.canvas_px.y - pos.y) - u.plot_origin_px.y;
}

@fragment
fn fs_line(o: LineOut) -> @location(0) vec4<f32> {
    let c = pixel_col(o.pos);
    let ry = row_centre(o.pos);
    var cov = 0.0;
    if (o.info.x == 0u) {
        cov = coverage(f32(abs(c - o.span.y)), run_dist(o, ry));
    } else {
        cov = connector_cov(o.ya, c, ry);
    }
    return vec4<f32>(u.colour.rgb * cov, cov);
}

// |a − b| and whether a < b (the magnitude always fits u32).
fn sdiff(a: i32, b: i32) -> vec2<u32> {
    if (a >= b) {
        return vec2<u32>(bitcast<u32>(a) - bitcast<u32>(b), 0u);
    }
    return vec2<u32>(bitcast<u32>(b) - bitcast<u32>(a), 1u);
}

// The full 64-bit product (lo, hi) of two u32, from 16-bit limbs.
fn umul64(a: u32, b: u32) -> vec2<u32> {
    let a0 = a & 0xFFFFu;
    let a1 = a >> 16u;
    let b0 = b & 0xFFFFu;
    let b1 = b >> 16u;
    let p00 = a0 * b0;
    let p01 = a0 * b1;
    let p10 = a1 * b0;
    let p11 = a1 * b1;
    let mid = (p00 >> 16u) + (p01 & 0xFFFFu) + (p10 & 0xFFFFu);
    let lo = (p00 & 0xFFFFu) | (mid << 16u);
    let hi = p11 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u);
    return vec2<u32>(lo, hi);
}

fn neg64(v: vec2<u32>) -> vec2<u32> {
    let lo = ~v.x + 1u;
    return vec2<u32>(lo, ~v.y + select(0u, 1u, lo == 0u));
}

// Two's-complement 64-bit product of (magnitude, negative) pairs.
fn smul64(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let m = umul64(a.x, b.x);
    if ((a.y ^ b.y) == 1u) {
        return neg64(m);
    }
    return m;
}

fn sub64(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    return vec2<u32>(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x));
}

fn sign64(v: vec2<u32>) -> i32 {
    if ((v.y & 0x80000000u) != 0u) {
        return -1;
    }
    if ((v.x | v.y) == 0u) {
        return 0;
    }
    return 1;
}

// dash_scales::raster::seg_covers with 64-bit products emulated in u32 pairs.
fn seg_covers(a: vec2<i32>, b: vec2<i32>, c: i32, r: i32) -> bool {
    let x0 = min(a.x, b.x);
    let x1 = max(a.x, b.x);
    if (c < (x0 >> 6u) || c > (x1 >> 6u)) {
        return false;
    }
    let by0 = r * 64;
    let by1 = by0 + 64;
    if (max(a.y, b.y) < by0 || min(a.y, b.y) > by1) {
        return false;
    }
    if (a.x == b.x && a.y == b.y) {
        return true;
    }
    let dx = sdiff(b.x, a.x);
    let dy = sdiff(b.y, a.y);
    let bx0 = c * 64;
    var pos = 0;
    var neg = 0;
    for (var q = 0; q < 4; q = q + 1) {
        let px = bx0 + 64 * (q & 1);
        let py = by0 + 64 * (q >> 1u);
        let s = sign64(sub64(smul64(dx, sdiff(py, a.y)), smul64(dy, sdiff(px, a.x))));
        if (s > 0) {
            pos = pos + 1;
        }
        if (s < 0) {
            neg = neg + 1;
        }
    }
    return !(pos == 4 || neg == 4);
}

// Whether a closed y interval (px) touches row r: yq(lo) ≤ 64r + 64 and yq(hi) ≥ 64r.
fn touches(lo: f32, hi: f32, r: i32) -> bool {
    return yq(lo) <= r * 64 + 64 && yq(hi) >= r * 64;
}

fn runs_touch(o: LineOut, r: i32) -> bool {
    let flags = o.info.y;
    if ((flags & F_OVER) != 0u) {
        let i = o.info.z;
        var open = false;
        var mn = 0.0;
        var mx = 0.0;
        for (var k = o.info.w; k < u32(o.span.x); k = k + 1u) {
            let b = value_bits(i, k);
            if (b == NULL_BITS) {
                if (open && touches(mn, mx, r)) {
                    return true;
                }
                open = false;
                continue;
            }
            let y = y_of(i, b);
            if (open) {
                mn = min(mn, y);
                mx = max(mx, y);
            } else {
                mn = y;
                mx = y;
                open = true;
            }
        }
        return open && touches(mn, mx, r);
    }
    return ((flags & F_IV0) != 0u && touches(o.ya.x, o.ya.y, r))
        || ((flags & F_IV1) != 0u && touches(o.ya.z, o.ya.w, r))
        || ((flags & F_IV2) != 0u && touches(o.yb.x, o.yb.y, r));
}

@fragment
fn fs_mask(o: LineOut) -> @location(0) vec4<f32> {
    let c = pixel_col(o.pos);
    let r = i32(floor(row_centre(o.pos)));
    var hit = false;
    if (o.info.x == 0u) {
        hit = c == o.span.y && runs_touch(o, r);
    } else {
        let p = o.ya;
        hit = seg_covers(vec2<i32>(xq(p.x), yq(p.y)), vec2<i32>(xq(p.z), yq(p.w)), c, r);
    }
    if (!hit) {
        discard;
    }
    return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
