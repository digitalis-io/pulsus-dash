// Capsule segments of the minimal axes (plan #24 §3.5): one instanced triangle strip per segment
// [x0, y0, x1, y1] (device px, y up from the canvas bottom), anti-aliased by distance.

struct SegmentUniforms {
    canvas_px: vec2<f32>,
    half_w: f32,
    pad0: f32,
    colour: vec4<f32>,
};

@group(0) @binding(0) var<uniform> su: SegmentUniforms;

struct SegmentOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) @interpolate(flat) seg: vec4<f32>,
};

@vertex
fn vs_segment(@builtin(vertex_index) vid: u32, @location(0) seg: vec4<f32>) -> SegmentOut {
    let p0 = seg.xy;
    let p1 = seg.zw;
    let d = p1 - p0;
    let len = length(d);
    var dir = vec2<f32>(1.0, 0.0);
    if (len > 0.0) {
        dir = d / len;
    }
    let nrm = vec2<f32>(-dir.y, dir.x);
    let e = su.half_w + 1.0;
    let side = f32(vid >> 1u) * 2.0 - 1.0;
    let p = select(p0 - dir * e, p1 + dir * e, (vid & 1u) == 1u) + nrm * (e * side);
    var o: SegmentOut;
    o.pos = vec4<f32>(p / su.canvas_px * 2.0 - 1.0, 0.0, 1.0);
    o.seg = seg;
    return o;
}

@fragment
fn fs_segment(o: SegmentOut) -> @location(0) vec4<f32> {
    let q = vec2<f32>(o.pos.x, su.canvas_px.y - o.pos.y);
    let a = o.seg.xy;
    let ab = o.seg.zw - a;
    let t = clamp(dot(q - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
    let c = clamp(su.half_w + 0.5 - length(q - (a + ab * t)), 0.0, 1.0);
    return vec4<f32>(su.colour.rgb * c, c);
}
