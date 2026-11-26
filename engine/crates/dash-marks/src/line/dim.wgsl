// The dim layer's composite (plan #68 C2c2 §3.3, ADR-0032): the unmatched series were drawn at
// full alpha into a premultiplied layer; one full-target triangle puts it onto the frame at
// `dimmed`, blended (One, OneMinusSrcAlpha): dst·(1 − a·d) + c·a·d.

struct U {
  dimmed: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
};

@group(0) @binding(0) var layer: texture_2d<f32>;
@group(0) @binding(1) var<uniform> u: U;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let x = f32(i32(i & 1u) * 4 - 1);
  let y = f32(i32(i >> 1u) * 4 - 1);
  return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(layer, vec2<i32>(p.xy), 0) * u.dimmed;
}
