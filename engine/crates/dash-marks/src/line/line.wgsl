// The M1 line pipeline (plan #68 §4.3, A.11, A.15.2): one instance = a round-capped capsule
// (segment, span, dot) or a guide hairline. Positions are mapped through the viewport's
// `view_proj` (composed in f64 on the CPU, D-CAM), divided by w, and only then extruded in device
// pixels. Coverage is clamp(r + 0.5 − d, 0, 1) in device px; near a capsule end d is the distance
// to that end itself, so it depends only on that end's coordinates.

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
  colours: array<vec4<f32>, 9>,
};

@group(0) @binding(0) var<uniform> view: View;

const U_CLAMP: f32 = 16777216.0;

struct Out {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) a: vec2<f32>,
  @location(1) @interpolate(flat) b: vec2<f32>,
  @location(2) @interpolate(flat) r: f32,
  @location(3) @interpolate(flat) kind: u32,
  @location(4) @interpolate(flat) colour: vec4<f32>,
};

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

/// Clips the device-px segment a→b to the rows [−m, H + m] (x needs no clip: columns lie in the
/// plot). A cut end takes the bound as its y exactly and its x from the cut parameter, so far
/// ends (|y| up to ~1e10 px for u = ±2^24) never reach the rasterizer and nothing cancels. A
/// segment wholly beyond one bound collapses onto it (invisible: m exceeds the coverage reach).
fn clip_rows(a: vec2<f32>, b: vec2<f32>, m: f32) -> array<vec2<f32>, 2> {
  let lo = -m;
  let hi = view.device_px.y + m;
  let d = b - a;
  if (d.y == 0.0) {
    if (a.y < lo || a.y > hi) {
      let y = clamp(a.y, lo, hi);
      return array<vec2<f32>, 2>(vec2<f32>(a.x, y), vec2<f32>(a.x, y));
    }
    return array<vec2<f32>, 2>(a, b);
  }
  let t_lo = (lo - a.y) / d.y;
  let t_hi = (hi - a.y) / d.y;
  let t0 = max(0.0, min(t_lo, t_hi));
  let t1 = min(1.0, max(t_lo, t_hi));
  if (t0 > t1) {
    let y = select(hi, lo, max(a.y, b.y) < lo);
    return array<vec2<f32>, 2>(vec2<f32>(a.x, y), vec2<f32>(a.x, y));
  }
  var a2 = a;
  var b2 = b;
  if (t0 > 0.0) { a2 = vec2<f32>(a.x + t0 * d.x, select(hi, lo, t_lo < t_hi)); }
  if (t1 < 1.0) { b2 = vec2<f32>(a.x + t1 * d.x, select(lo, hi, t_lo < t_hi)); }
  return array<vec2<f32>, 2>(a2, b2);
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) col: u32, @location(1) va: f32, @location(2) vb: f32, @location(3) flags: u32) -> Out {
  var o: Out;
  let kind = (flags >> 4u) & 3u;
  let slot = flags & 15u;
  let lane = flags >> 16u;
  let z = view.lane_z0 + f32(lane) * view.lane_dz;
  o.kind = kind;
  o.colour = view.colours[min(slot, 8u)];
  // Two triangles: corners (0,0) (1,0) (0,1) (0,1) (1,0) (1,1).
  var corner = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  let k = corner[vi % 6u];
  if (kind == 3u) {
    // Guide: x ∈ plot, y ∈ [va, va + 1) CSS px, coverage 1.
    let p0 = device(view.plot.x, va, z);
    let p1 = device(view.plot.x + view.plot.z, va + 1.0, z);
    o.a = p0;
    o.b = p1;
    o.r = 0.0;
    o.pos = to_clip(mix(p0, p1, k));
    return o;
  }
  let c = f32(col & 0xFFFFu);
  let xb = view.plot.x + c + 0.5;
  var xa = xb;
  var ya = y_of(va);
  var yb = y_of(vb);
  var xbb = xb;
  if (kind == 0u) {
    xa = xb - f32(col >> 16u);
    let ca = (flags >> 8u) & 3u;
    let cb = (flags >> 10u) & 3u;
    if (ca != 0u) {
      ya = y_of(clipped_u(ca));
      xa = xa + va * (xb - xa);
    }
    if (cb != 0u) {
      yb = y_of(clipped_u(cb));
      xbb = (xb - f32(col >> 16u)) + vb * (xb - (xb - f32(col >> 16u)));
    }
  }
  if (kind == 2u) {
    yb = ya;
  }
  var r = view.width_css * 0.5 * view.dpr;
  if (kind == 2u) { r = view.width_css * view.dpr; }
  let ends = clip_rows(device(xa, ya, z), device(xbb, yb, z), r + 2.0);
  let a = ends[0];
  let b = ends[1];
  let ab = b - a;
  let len = length(ab);
  var d = vec2<f32>(1.0, 0.0);
  if (len > 0.0) { d = ab / len; }
  let n = vec2<f32>(-d.y, d.x);
  let e = r + 1.0;
  let along = select(a - d * e, b + d * e, k.x > 0.5);
  let p = along + n * select(-e, e, k.y > 0.5);
  o.a = a;
  o.b = b;
  o.r = r;
  o.pos = to_clip(p);
  return o;
}

@fragment
fn fs(i: Out) -> @location(0) vec4<f32> {
  if (i.kind == 3u) {
    return i.colour;
  }
  let p = i.pos.xy;
  let ab = i.b - i.a;
  let ap = p - i.a;
  let len2 = dot(ab, ab);
  let h = dot(ap, ab);
  var d: f32;
  if (len2 <= 0.0 || h <= 0.0) {
    d = length(ap);
  } else if (h >= len2) {
    d = length(p - i.b);
  } else {
    d = abs(ap.x * ab.y - ap.y * ab.x) / sqrt(len2);
  }
  let cov = clamp(i.r + 0.5 - d, 0.0, 1.0);
  if (cov <= 0.0) {
    discard;
  }
  return vec4<f32>(i.colour.rgb, i.colour.a * cov);
}
