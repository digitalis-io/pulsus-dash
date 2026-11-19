// Minimal M3 rect mark of the #23 runtime spike: one instanced draw of axis-aligned quads.
// Instance slots: 0 `xy` (centre, NDC), 1 `phase` (radians). #24 adds radius and border.

struct Uniforms {
    t_s: f32,
    aspect: f32,
    cursor: vec2<f32>,
    half_size: f32,
    pad0: f32,
    pad1: f32,
    pad2: f32,
    colour: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0) colour: vec4<f32>,
};

@vertex
fn vs_main(
    @builtin(vertex_index) vertex: u32,
    @location(0) xy: vec2<f32>,
    @location(1) phase: f32,
) -> VertexOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
    );
    let pulse = 0.55 + 0.45 * sin(u.t_s * 2.5 + phase);
    let d = distance(vec2<f32>(xy.x * u.aspect, xy.y), vec2<f32>(u.cursor.x * u.aspect, u.cursor.y));
    let near = 1.0 - smoothstep(0.0, 0.3, d);
    let s = u.half_size * (pulse + 0.8 * near);
    let c = corners[vertex];
    var out: VertexOut;
    out.position = vec4<f32>(xy.x + c.x * s / max(u.aspect, 0.001), xy.y + c.y * s, 0.0, 1.0);
    out.colour = mix(u.colour, vec4<f32>(1.0, 1.0, 1.0, 1.0), 0.6 * near);
    return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    return in.colour;
}
