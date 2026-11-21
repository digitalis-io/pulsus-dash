// P1 reduce and P5 spill (plan #68 §4.2, A.15.2): one invocation per (column x, series y).
// The image of dash-scales::decimate::{reduce_column, spill_column}; values are compared only as
// order-preserving integer keys of their f32 bits, so the result is bit-identical to the CPU path.

struct Pass { n: u32, series: u32, per_series_ranges: u32, guides: u32, window_lo: u32, window_hi: u32, pad0: u32, pad1: u32 };
struct ColOut { last: u32, first: u32, flags: u32, n_runs: u32, span_at: u32, pad: u32, r0max: u32, r0min: u32, r1max: u32, r1min: u32 };
struct Inst { col: u32, va: u32, vb: u32, flags: u32 };

@group(0) @binding(0) var<uniform> cfg: Pass;
@group(1) @binding(0) var<storage, read> values: array<u32>;
@group(1) @binding(1) var<storage, read> offsets: array<u32>;
@group(1) @binding(2) var<storage, read> ranges: array<u32>;
@group(1) @binding(3) var<storage, read_write> cols: array<ColOut>;
@group(1) @binding(4) var<storage, read_write> counts: array<u32>;
@group(1) @binding(5) var<storage, read_write> starts: array<u32>;
@group(1) @binding(6) var<storage, read_write> instances: array<Inst>;
@group(1) @binding(7) var<storage, read_write> status: array<u32>;

const GAP_BITS: u32 = 0x7FC00000u;
const COL_HAS_FINITE: u32 = 4u;
const COL_GAP_LEAD: u32 = 8u;
const COL_GAP_INNER: u32 = 16u;
const COL_GAP_TRAIL: u32 = 32u;
const COL_ALL_GAP: u32 = 64u;
const COL_OVERFLOW: u32 = 128u;
const COL_JOIN_IN: u32 = 256u;
const COL_JOIN_OUT: u32 = 512u;
const COL_RUN0_SINGLE: u32 = 1024u;
const COL_RUN1_SINGLE: u32 = 2048u;
const KIND_SPAN: u32 = 16u;
const KIND_DOT: u32 = 32u;
const INST_CAPS: u32 = 192u;

fn key(b: u32) -> u32 {
  if ((b & 0x7FFFFFFFu) == 0u) { return 0x80000000u; }
  if ((b & 0x80000000u) != 0u) { return ~b; }
  return b | 0x80000000u;
}

fn col_range(s: u32, c: u32) -> vec2<u32> {
  if (cfg.per_series_ranges != 0u) {
    let row = s * (cfg.n + 1u);
    return vec2<u32>(ranges[row + c], ranges[row + c + 1u]);
  }
  let base = offsets[s];
  return vec2<u32>(base + ranges[c], base + ranges[c + 1u]);
}

@compute @workgroup_size(64)
fn reduce(@builtin(global_invocation_id) id: vec3<u32>) {
  let c = id.x;
  let s = id.y;
  if (c >= cfg.n || s >= cfg.series) { return; }
  let r = col_range(s, c);
  var count = 0u;
  var n_runs = 0u;
  var in_run = false;
  var gap_since_last = false;
  var lead = false;
  var inner = false;
  var first = 0u;
  var last = 0u;
  var r0 = vec2<u32>(0u, 0u);
  var r1 = vec2<u32>(0u, 0u);
  var c0 = 0u;
  var c1 = 0u;
  for (var i = r.x; i < r.y; i++) {
    let b = values[i];
    if (b == GAP_BITS) {
      if (count == 0u) { lead = true; } else { gap_since_last = true; }
      in_run = false;
      continue;
    }
    if (count > 0u && gap_since_last) { inner = true; }
    gap_since_last = false;
    if (!in_run) {
      if (n_runs == 0u) { r0 = vec2<u32>(b, b); c0 = 1u; }
      if (n_runs == 1u) { r1 = vec2<u32>(b, b); c1 = 1u; }
      n_runs += 1u;
      in_run = true;
    } else {
      let k = n_runs - 1u;
      if (k == 0u) {
        if (key(b) > key(r0.x)) { r0.x = b; }
        if (key(b) < key(r0.y)) { r0.y = b; }
        c0 += 1u;
      }
      if (k == 1u) {
        if (key(b) > key(r1.x)) { r1.x = b; }
        if (key(b) < key(r1.y)) { r1.y = b; }
        c1 += 1u;
      }
    }
    if (count == 0u) { first = b; }
    last = b;
    count += 1u;
  }
  var flags = min(count, 2u);
  if (count > 0u) { flags |= COL_HAS_FINITE; }
  if (lead) { flags |= COL_GAP_LEAD; }
  if (inner) { flags |= COL_GAP_INNER; }
  if (gap_since_last) { flags |= COL_GAP_TRAIL; }
  if (count == 0u && r.y > r.x) { flags |= COL_ALL_GAP; }
  if (n_runs > 2u) { flags |= COL_OVERFLOW; }
  if (n_runs >= 1u && c0 == 1u) { flags |= COL_RUN0_SINGLE; }
  if (n_runs >= 2u && c1 == 1u) { flags |= COL_RUN1_SINGLE; }
  cols[s * cfg.n + c] = ColOut(last, first, flags, n_runs, 0u, 0u, r0.x, r0.y, r1.x, r1.y);
}

fn put(at: u32, inst: Inst) {
  if (at >= cfg.window_lo && at < cfg.window_hi) { instances[at - cfg.window_lo] = inst; }
}

fn run_instance(c: u32, k: u32, n_runs: u32, mx: u32, mn: u32, single: bool, col_meta: u32, base: u32) -> Inst {
  let joined = (k == 0u && (col_meta & COL_JOIN_IN) != 0u) || (k + 1u == n_runs && (col_meta & COL_JOIN_OUT) != 0u);
  if (single && !joined) { return Inst(c, mx, mx, base | KIND_DOT); }
  return Inst(c, mx, mn, base | KIND_SPAN);
}

// Per-series colour slot and lane: written by the renderer into `status` after the scan header
// (status[8 + s] = slot | lane << 16), so P4 and P5 see the same base flags.
fn base_meta(s: u32) -> u32 {
  let sl = status[8u + s];
  return (sl & 0xFu) | INST_CAPS | ((sl >> 16u) << 16u);
}

@compute @workgroup_size(64)
fn spill(@builtin(global_invocation_id) id: vec3<u32>) {
  let c = id.x;
  let s = id.y;
  if (c >= cfg.n || s >= cfg.series) { return; }
  let co = cols[s * cfg.n + c];
  if ((co.flags & 3u) != 2u || (co.flags & COL_OVERFLOW) == 0u) { return; }
  let r = col_range(s, c);
  let base = base_meta(s);
  var k = 0u;
  var in_run = false;
  var mx = 0u;
  var mn = 0u;
  var count = 0u;
  for (var i = r.x; i <= r.y; i++) {
    var b = GAP_BITS;
    if (i < r.y) { b = values[i]; }
    if (b == GAP_BITS) {
      if (in_run) {
        put(co.span_at + k, run_instance(c, k, co.n_runs, mx, mn, count == 1u, co.flags, base));
        k += 1u;
      }
      in_run = false;
      continue;
    }
    if (!in_run) {
      mx = b;
      mn = b;
      count = 1u;
      in_run = true;
    } else {
      if (key(b) > key(mx)) { mx = b; }
      if (key(b) < key(mn)) { mn = b; }
      count += 1u;
    }
  }
}
