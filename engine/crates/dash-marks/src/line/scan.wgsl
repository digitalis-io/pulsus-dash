// P3 scan (plan #68 §4.2, C1 §3.1): one workgroup of 256 over the series. starts[s] = G + Σ counts[..s];
// status[0..4] = draw-indirect args (6, min(G + total, window_hi), 0, 0), status[4] = total
// (uncapped). Native passes window_hi = u32::MAX, so its count is G + total.

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

var<workgroup> partial: array<u32, 256>;

@compute @workgroup_size(256)
fn scan(@builtin(local_invocation_index) li: u32) {
  let per = (cfg.series + 255u) / 256u;
  let lo = min(li * per, cfg.series);
  let hi = min(lo + per, cfg.series);
  var sum = 0u;
  for (var s = lo; s < hi; s++) { sum += counts[s]; }
  partial[li] = sum;
  workgroupBarrier();
  if (li == 0u) {
    var acc = 0u;
    for (var i = 0u; i < 256u; i++) {
      let v = partial[i];
      partial[i] = acc;
      acc += v;
    }
    status[0] = 6u;
    status[1] = min(cfg.guides + acc, cfg.window_hi);
    status[2] = 0u;
    status[3] = 0u;
    status[4] = acc;
  }
  workgroupBarrier();
  var at = cfg.guides + partial[li];
  for (var s = lo; s < hi; s++) {
    starts[s] = at;
    at += counts[s];
  }
}
