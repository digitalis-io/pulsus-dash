// P2 count and P4 emit (plan #68 §4.2, A.15.2): one invocation per series, columns in order, one
// drawn column behind so whether a segment leaves it is known. The image of
// dash-scales::decimate::{link, column_count} and the P4 loop of `decimate`.

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

const COL_GAP_LEAD: u32 = 8u;
const COL_GAP_TRAIL: u32 = 32u;
const COL_ALL_GAP: u32 = 64u;
const COL_OVERFLOW: u32 = 128u;
const COL_JOIN_IN: u32 = 256u;
const COL_JOIN_OUT: u32 = 512u;
const COL_RUN0_SINGLE: u32 = 1024u;
const KIND_SEGMENT: u32 = 0u;
const KIND_SPAN: u32 = 16u;
const KIND_DOT: u32 = 32u;
const INST_CAPS: u32 = 192u;

fn column_count(co: ColOut, join_in: bool, join_out: bool) -> u32 {
  let seg = select(0u, 1u, join_in);
  if ((co.flags & 3u) == 2u) { return co.n_runs + seg; }
  return seg + select(0u, 1u, !join_in && !join_out);
}

@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= cfg.series) { return; }
  let row = s * cfg.n;
  var have_prev = false;
  var pending = false;
  var prev_c = 0u;
  var prev_in = false;
  var total = 0u;
  for (var c = 0u; c < cfg.n; c++) {
    let co = cols[row + c];
    if ((co.flags & 3u) == 0u) {
      if ((co.flags & COL_ALL_GAP) != 0u) { pending = true; }
      continue;
    }
    let join_in = have_prev && !(pending || (co.flags & COL_GAP_LEAD) != 0u);
    if (have_prev) { total += column_count(cols[row + prev_c], prev_in, join_in); }
    prev_c = c;
    prev_in = join_in;
    have_prev = true;
    pending = (co.flags & COL_GAP_TRAIL) != 0u;
  }
  if (have_prev) { total += column_count(cols[row + prev_c], prev_in, false); }
  counts[s] = total;
}

fn put(at: u32, inst: Inst) {
  if (at >= cfg.window_lo && at < cfg.window_hi) { instances[at - cfg.window_lo] = inst; }
}

fn run_instance(c: u32, k: u32, n_runs: u32, mx: u32, mn: u32, single: bool, col_meta: u32, base: u32) -> Inst {
  let joined = (k == 0u && (col_meta & COL_JOIN_IN) != 0u) || (k + 1u == n_runs && (col_meta & COL_JOIN_OUT) != 0u);
  if (single && !joined) { return Inst(c, mx, mx, base | KIND_DOT); }
  return Inst(c, mx, mn, base | KIND_SPAN);
}

fn base_meta(s: u32) -> u32 {
  let sl = status[8u + s];
  return (sl & 0xFu) | INST_CAPS | ((sl >> 16u) << 16u);
}

/// Emits drawn column `c` (runs, the segment into it, a dot) at `*at`.
fn emit_column(s: u32, c: u32, join_in: bool, join_out: bool, pred_c: u32, pred_last: u32, base: u32, at: ptr<function, u32>) {
  let i = s * cfg.n + c;
  var co = cols[i];
  if (join_in) { co.flags |= COL_JOIN_IN; }
  if (join_out) { co.flags |= COL_JOIN_OUT; }
  let cclass = co.flags & 3u;
  if (cclass == 2u) {
    co.span_at = *at;
    if ((co.flags & COL_OVERFLOW) == 0u) {
      for (var k = 0u; k < co.n_runs; k++) {
        let single = (co.flags & (COL_RUN0_SINGLE << k)) != 0u;
        var mx = co.r0max;
        var mn = co.r0min;
        if (k == 1u) {
          mx = co.r1max;
          mn = co.r1min;
        }
        put(*at, run_instance(c, k, co.n_runs, mx, mn, single, co.flags, base));
        *at += 1u;
      }
    } else {
      *at += co.n_runs;
    }
  }
  cols[i] = co;
  if (join_in) {
    put(*at, Inst(c | ((c - pred_c) << 16u), pred_last, co.first, base | KIND_SEGMENT));
    *at += 1u;
  }
  if (cclass == 1u && !join_in && !join_out) {
    put(*at, Inst(c, co.last, co.last, base | KIND_DOT));
    *at += 1u;
  }
}

@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) id: vec3<u32>) {
  let s = id.x;
  if (s >= cfg.series) { return; }
  let row = s * cfg.n;
  let base = base_meta(s);
  var at = starts[s];
  var have_prev = false;
  var pending = false;
  var prev_c = 0u;
  var prev_in = false;
  var prev_pred_c = 0u;
  var prev_pred_last = 0u;
  var last_of_prev = 0u;
  for (var c = 0u; c < cfg.n; c++) {
    let co = cols[row + c];
    if ((co.flags & 3u) == 0u) {
      if ((co.flags & COL_ALL_GAP) != 0u) { pending = true; }
      continue;
    }
    let join_in = have_prev && !(pending || (co.flags & COL_GAP_LEAD) != 0u);
    let pred_c = prev_c;
    if (have_prev) { emit_column(s, prev_c, prev_in, join_in, prev_pred_c, prev_pred_last, base, &at); }
    prev_pred_c = select(0u, pred_c, have_prev);
    prev_pred_last = last_of_prev;
    prev_c = c;
    prev_in = join_in;
    last_of_prev = co.last;
    have_prev = true;
    pending = (co.flags & COL_GAP_TRAIL) != 0u;
  }
  if (have_prev) { emit_column(s, prev_c, prev_in, false, prev_pred_c, prev_pred_last, base, &at); }
}
