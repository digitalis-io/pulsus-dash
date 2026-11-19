
// T1 decimation (plan #24 §3.5): one invocation per (slot, series); dispatch
// (ceil(tile_w / 64), series, tiles). Slot s of series i → texel (s % tile_w, i, s / tile_w).

@group(0) @binding(1) var values_tex: texture_2d_array<u32>;
@group(0) @binding(2) var pyr_tex: texture_2d_array<u32>;
@group(0) @binding(3) var bounds_tex: texture_2d<u32>;
@group(0) @binding(4) var rec_a_out: texture_storage_2d_array<rgba32uint, write>;
@group(0) @binding(5) var rec_b_out: texture_storage_2d_array<rgba32uint, write>;

@compute @workgroup_size(64)
fn cs_decimate(@builtin(global_invocation_id) g: vec3<u32>) {
    let s = g.z * u.tile_w + g.x;
    if (g.x >= u.tile_w || g.y >= u.series || s >= u.slots) {
        return;
    }
    let r = decimate_slot(pyr_tex, g.y, s);
    textureStore(rec_a_out, vec2<u32>(g.x, g.y), g.z, r.a);
    textureStore(rec_b_out, vec2<u32>(g.x, g.y), g.z, r.b);
}
