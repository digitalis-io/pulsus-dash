// The line area (#282 Part 2b §3.4, ADR-0036): a second instanced draw over the line's own
// instances, before any line pass. A SEGMENT instance (a join) becomes one quad over the join's
// x-span and the plot's full height; the fragment stage fills it by the piecewise rule (Rust
// `dash_scene::area_pieces` is its reference): the span splits where the line crosses the plot's
// top and bottom rows; an Above piece fills from the top, an Inside piece from the line, a Below
// piece not at all. Alpha runs from `area_alpha` at the top row to 0 at the bottom. Guides (kind 3)
// are drawn here as in `line.wgsl` when `guides` is set, so they lie under the areas; spans and
// dots draw nothing. Neighbouring quads share their x edges exactly (integer column arithmetic),
// so nothing blends twice. `common.wgsl` is prepended.

const CLS_ABOVE: u32 = 0u;
const CLS_INSIDE: u32 = 1u;
const CLS_BELOW: u32 = 2u;

struct AOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) @interpolate(flat) kind: u32,
  @location(1) @interpolate(flat) colour: vec4<f32>,
  // c0 | c1 << 2 | c2 << 4: the class of each piece in x order.
  @location(2) @interpolate(flat) classes: u32,
  // Device x where piece 1 and piece 2 begin.
  @location(3) @interpolate(flat) bounds: vec2<f32>,
  // The Inside piece's edge in device px: (xs, ys, xe, ye).
  @location(4) @interpolate(flat) iline: vec4<f32>,
  // The plot's top and bottom rows, device px.
  @location(5) @interpolate(flat) rows: vec2<f32>,
};

fn class_of(y: f32) -> u32 {
  if (y < view.plot.y) {
    return CLS_ABOVE;
  }
  if (y > view.plot.y + view.plot.w) {
    return CLS_BELOW;
  }
  return CLS_INSIDE;
}

/// The x where the line a→b reaches row y, within [x0, x1]; a.y ≠ b.y (ends of different classes).
fn cross(a: vec2<f32>, b: vec2<f32>, y: f32, x0: f32, x1: f32) -> f32 {
  return clamp(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y), x0, x1);
}

fn skipped() -> AOut {
  var o: AOut;
  o.pos = vec4<f32>(-2.0, -2.0, 0.0, 1.0);
  o.kind = 3u;
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) col: u32, @location(1) va: f32, @location(2) vb: f32, @location(3) flags: u32) -> AOut {
  let kind = (flags >> 4u) & 3u;
  let slot = flags & 15u;
  let lane = flags >> 16u;
  let z = view.lane_z0 + f32(lane) * view.lane_dz;
  var corner = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
  let k = corner[vi % 6u];
  var o: AOut;
  o.kind = kind;
  o.colour = view.colours[min(slot, 9u)];
  if (kind == 3u) {
    if (view.guides == 0u) {
      return skipped();
    }
    let p0 = device(view.plot.x, va, z);
    let p1 = device(view.plot.x + view.plot.z, va + 1.0, z);
    o.pos = to_clip(mix(p0, p1, k));
    return o;
  }
  if (kind != 0u) {
    return skipped();
  }
  let c = col & 0xFFFFu;
  let dx = col >> 16u;
  if (dx == 0u || dx > c) {
    return skipped();
  }
  let x0 = view.plot.x + f32(c - dx) + 0.5;
  let x1 = view.plot.x + f32(c) + 0.5;
  var a = vec2<f32>(x0, y_of(va));
  var b = vec2<f32>(x1, y_of(vb));
  let ca = (flags >> 8u) & 3u;
  let cb = (flags >> 10u) & 3u;
  if (ca != 0u) {
    a = vec2<f32>(x0 + va * (x1 - x0), y_of(clipped_u(ca)));
  }
  if (cb != 0u) {
    b = vec2<f32>(x0 + vb * (x1 - x0), y_of(clipped_u(cb)));
  }
  let top = view.plot.y;
  let bottom = view.plot.y + view.plot.w;
  let ka = class_of(a.y);
  let kb = class_of(b.y);
  var c1 = ka;
  var c2 = ka;
  var b1 = x1;
  var b2 = x1;
  var s = a;
  var e = b;
  if (ka != kb) {
    if (a.y < b.y) {
      if (ka == CLS_ABOVE) {
        b1 = cross(a, b, top, x0, x1);
        c1 = CLS_INSIDE;
        c2 = CLS_INSIDE;
        s = vec2<f32>(b1, top);
      }
      if (kb == CLS_BELOW) {
        let bx = cross(a, b, bottom, x0, x1);
        if (ka == CLS_ABOVE) {
          b2 = max(bx, b1);
          c2 = CLS_BELOW;
        } else {
          b1 = bx;
          b2 = x1;
          c1 = CLS_BELOW;
          c2 = CLS_BELOW;
        }
        e = vec2<f32>(bx, bottom);
      }
    } else {
      if (ka == CLS_BELOW) {
        b1 = cross(a, b, bottom, x0, x1);
        c1 = CLS_INSIDE;
        c2 = CLS_INSIDE;
        s = vec2<f32>(b1, bottom);
      }
      if (kb == CLS_ABOVE) {
        let bx = cross(a, b, top, x0, x1);
        if (ka == CLS_BELOW) {
          b2 = max(bx, b1);
          c2 = CLS_ABOVE;
        } else {
          b1 = bx;
          b2 = x1;
          c1 = CLS_ABOVE;
          c2 = CLS_ABOVE;
        }
        e = vec2<f32>(bx, top);
      }
    }
  }
  o.classes = ka | (c1 << 2u) | (c2 << 4u);
  o.bounds = vec2<f32>(device(b1, top, z).x, device(b2, top, z).x);
  let ds = device(s.x, s.y, z);
  let de = device(e.x, e.y, z);
  o.iline = vec4<f32>(ds.x, ds.y, de.x, de.y);
  let t0 = device(x0, top, z);
  let t1 = device(x1, bottom, z);
  o.rows = vec2<f32>(t0.y, t1.y);
  o.pos = to_clip(mix(t0, t1, k));
  return o;
}

@fragment
fn fs(i: AOut) -> @location(0) vec4<f32> {
  if (i.kind == 3u) {
    return i.colour;
  }
  let x = i.pos.x;
  var k = i.classes & 3u;
  if (x >= i.bounds.x) {
    k = (i.classes >> 2u) & 3u;
  }
  if (x >= i.bounds.y) {
    k = (i.classes >> 4u) & 3u;
  }
  if (k == CLS_BELOW) {
    discard;
  }
  var edge = i.rows.x;
  if (k == CLS_INSIDE) {
    let d = i.iline.z - i.iline.x;
    edge = i.iline.y + (x - i.iline.x) * (i.iline.w - i.iline.y) / max(d, 1e-30);
    if (d <= 0.0) {
      edge = min(i.iline.y, i.iline.w);
    }
  }
  if (i.pos.y < edge || i.pos.y > i.rows.y) {
    discard;
  }
  let span = max(i.rows.y - i.rows.x, 1e-30);
  let alpha = view.area_alpha * clamp((i.rows.y - i.pos.y) / span, 0.0, 1.0);
  return vec4<f32>(i.colour.rgb, i.colour.a * alpha);
}
