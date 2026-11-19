
// T2 decimation (plan #24 §3.5): a full-screen triangle per tile layer into two Rgba32Uint
// targets (rec_a, rec_b; 32 B per sample), viewport tile_w × series. The tile layer comes from
// a dynamic-offset uniform.

@group(0) @binding(1) var values_tex: texture_2d_array<u32>;
@group(0) @binding(2) var pyr_tex: texture_2d_array<u32>;
@group(0) @binding(3) var bounds_tex: texture_2d<u32>;

struct TileUniforms {
    layer: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
};

@group(0) @binding(6) var<uniform> tile: TileUniforms;

@vertex
fn vs_fullscreen(@builtin(vertex_index) v: u32) -> @builtin(position) vec4<f32> {
    let x = f32((v << 1u) & 2u);
    let y = f32(v & 2u);
    return vec4<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
}

struct RecOut {
    @location(0) a: vec4<u32>,
    @location(1) b: vec4<u32>,
};

@fragment
fn fs_decimate(@builtin(position) p: vec4<f32>) -> RecOut {
    let x = u32(p.x);
    let i = u32(p.y);
    let s = tile.layer * u.tile_w + x;
    var r = empty_rec();
    if (x < u.tile_w && i < u.series && s < u.slots) {
        r = decimate_slot(pyr_tex, i, s);
    }
    return RecOut(r.a, r.b);
}
