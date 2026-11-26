// The overlay (plan #68 C2b §3.2): one instanced quad per shape, in device px (CSS px × dpr), no
// view_proj. A rect's coverage is the pixel's box overlap per axis, multiplied; a disc's is
// clamp(r·dpr + 0.5 − d, 0, 1). Straight alpha, blended as the line pipeline blends.

struct U {
    device_px: vec2<f32>,
    dpr: f32,
    pad: f32,
};

@group(0) @binding(0) var<uniform> u: U;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    // Rect: x0, y0, x1, y1; disc: cx, cy, r, 0 (device px).
    @location(0) @interpolate(flat) geom: vec4<f32>,
    @location(1) @interpolate(flat) colour: vec4<f32>,
    @location(2) @interpolate(flat) kind: f32,
};

@vertex
fn vs(
    @builtin(vertex_index) vi: u32,
    @location(0) g: vec4<f32>,
    @location(1) c: vec4<f32>,
    @location(2) k: f32,
) -> VsOut {
    var geom: vec4<f32>;
    var lo: vec2<f32>;
    var hi: vec2<f32>;
    if (k < 0.5) {
        let a = g.xy * u.dpr;
        let b = (g.xy + g.zw) * u.dpr;
        geom = vec4<f32>(a, b);
        lo = floor(a);
        hi = ceil(b);
    } else {
        let centre = g.xy * u.dpr;
        let r = g.z * u.dpr;
        geom = vec4<f32>(centre, r, 0.0);
        lo = floor(centre - vec2<f32>(r + 1.0, r + 1.0));
        hi = ceil(centre + vec2<f32>(r + 1.0, r + 1.0));
    }
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(1.0, 1.0),
    );
    let p = mix(lo, hi, corners[vi]);
    var out: VsOut;
    out.pos = vec4<f32>(p.x / u.device_px.x * 2.0 - 1.0, 1.0 - p.y / u.device_px.y * 2.0, 0.0, 1.0);
    out.geom = geom;
    out.colour = c;
    out.kind = k;
    return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let p = in.pos.xy;
    var cov: f32;
    if (in.kind < 0.5) {
        let ox = clamp(min(p.x + 0.5, in.geom.z) - max(p.x - 0.5, in.geom.x), 0.0, 1.0);
        let oy = clamp(min(p.y + 0.5, in.geom.w) - max(p.y - 0.5, in.geom.y), 0.0, 1.0);
        cov = ox * oy;
    } else {
        cov = clamp(in.geom.z + 0.5 - distance(p, in.geom.xy), 0.0, 1.0);
    }
    return vec4<f32>(in.colour.rgb, in.colour.a * cov);
}
