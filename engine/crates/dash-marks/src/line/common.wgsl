// Shared by `line.wgsl` and `area.wgsl` (#282 Part 2b §3.4): the view uniform and the CSS px →
// device px mapping. `pipeline.rs` prepends it to each module. Colour slots: 0–7 series, 8
// `chart-grid`, 9 `chart-axis`; `area_alpha` is the area pass's top alpha (ADR-0036).

struct View {
  view_proj: mat4x4<f32>,
  device_px: vec2<f32>,
  dpr: f32,
  width_css: f32,
  plot: vec4<f32>,
  ku: f32,
  ou: f32,
  lane_z0: f32,
  lane_dz: f32,
  colours: array<vec4<f32>, 10>,
  lane_only: u32,
  guides: u32,
  use_colour: u32,
  area_alpha: f32,
  colour: vec4<f32>,
};

const ALL_LANES: u32 = 0xFFFFFFFFu;

@group(0) @binding(0) var<uniform> view: View;

const U_CLAMP: f32 = 16777216.0;

fn y_of(u: f32) -> f32 {
  return view.plot.y + view.plot.w - (u - view.ou) * view.ku;
}

/// CSS px (and lane z) → device px, through view_proj and the perspective divide.
fn device(x: f32, y: f32, z: f32) -> vec2<f32> {
  let clip = view.view_proj * vec4<f32>(x, y, z, 1.0);
  let ndc = clip.xy / clip.w;
  return vec2<f32>((ndc.x + 1.0) * 0.5 * view.device_px.x, (1.0 - ndc.y) * 0.5 * view.device_px.y);
}

fn to_clip(p: vec2<f32>) -> vec4<f32> {
  return vec4<f32>(p.x / view.device_px.x * 2.0 - 1.0, 1.0 - p.y / view.device_px.y * 2.0, 0.0, 1.0);
}

fn clipped_u(code: u32) -> f32 {
  return select(U_CLAMP, -U_CLAMP, code == 1u);
}

