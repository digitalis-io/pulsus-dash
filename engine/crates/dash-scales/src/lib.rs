//! Value ticks, value encoding, column ranges and the CPU decimation reference (plan #68 §3.4).

pub mod decimate;
pub mod encode;
pub mod js_pow;

use dash_units::{js_round, to_precision};

/// A closed f64 interval.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range64 {
    pub lo: f64,
    pub hi: f64,
}

impl From<(f64, f64)> for Range64 {
    fn from((lo, hi): (f64, f64)) -> Self {
        Self { lo, hi }
    }
}

/// Nice value-axis ticks.
#[derive(Clone, Debug, PartialEq)]
pub struct ValueTicks {
    pub min: f64,
    pub max: f64,
    pub ticks: Vec<f64>,
}

/// The next nice step: 1 → 2 → 5 → 10.
fn next_nice(step: f64) -> f64 {
    let k = (step.log10() + 1e-9).floor();
    let m = js_round(step / js_pow::pow10(k));
    (if m == 1.0 {
        2.0
    } else if m == 2.0 {
        5.0
    } else {
        10.0
    }) * js_pow::pow10(k)
}

/// The smallest of {1, 2, 5} · 10^k at least `x`.
fn nice_at_least(x: f64) -> f64 {
    let k = x.log10().floor();
    for m in [1.0, 2.0, 5.0, 10.0] {
        let s = m * js_pow::pow10(k);
        if s >= x * (1.0 - 1e-12) {
            return s;
        }
    }
    js_pow::pow10(k + 1.0)
}

/// ECMAScript `Number(x.toPrecision(12))`.
fn round12(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    to_precision(x, 12).parse().unwrap_or(f64::NAN)
}

fn snapped(lo: f64, hi: f64, step: f64) -> (f64, f64) {
    let mut min = (lo / step).floor() * step;
    let mut max = (hi / step).ceil() * step;
    if min > lo {
        min -= step;
    }
    if max < hi {
        max += step;
    }
    (min, max)
}

/// The most iterations of the step loop before the port gives up (A.3.2).
const MAX_STEPS: usize = 64;

/// Port of `canvas2d/valueTicks.ts`, bit-identical on its finite domain (A.3.2): finite ends with
/// `data_min ≤ data_max`, both magnitudes ≤ 1e300 and `data_max/2 − data_min/2 < 2^1022`. Returns
/// None outside that domain, after 64 loop iterations (where the TS loop never ends: a zero span,
/// or a range straddling 0 on a plot under 2·(label + 2) px), or on any non-finite output or
/// `min ≥ max`. `round12` is ECMAScript `Number(x.toPrecision(12))`; `**` is V8's (`js_pow`).
pub fn value_ticks(
    data_min: f64,
    data_max: f64,
    height_px: f64,
    label_height_px: f64,
    base: u32,
) -> Option<ValueTicks> {
    let finite = data_min.is_finite() && data_max.is_finite() && height_px.is_finite();
    if !finite || data_min > data_max || data_min.abs().max(data_max.abs()) > 1e300 {
        return None;
    }
    if data_max / 2.0 - data_min / 2.0 >= 2f64.powi(1022) {
        return None;
    }
    let lo = data_min;
    let hi = if data_max == data_min {
        data_min + 1.0
    } else {
        data_max
    };
    if hi <= lo {
        // `min + 1` absorbed: the TS loop would never end.
        return None;
    }
    let b = f64::from(base);
    let p = (lo.abs().max(hi.abs()).ln() / b.ln()).floor().max(0.0);
    let unit = js_pow::pow_base(base, p)?;
    let target = (hi - lo) / unit / 2f64.max((height_px / (2.5 * label_height_px)).floor());
    let mut step_units = nice_at_least(target);
    let (mut min, mut max) = snapped(lo, hi, step_units * unit);
    let mut done = false;
    for _ in 0..MAX_STEPS {
        let step = step_units * unit;
        let count = js_round((max - min) / step);
        let spacing = height_px / count;
        if spacing >= label_height_px + 2.0 || count <= 1.0 {
            done = true;
            break;
        }
        step_units = next_nice(step_units);
        (min, max) = snapped(lo, hi, step_units * unit);
    }
    let step = step_units * unit;
    let count = js_round((max - min) / step);
    let count_ok = count.is_finite() && (0.0..=1e4).contains(&count);
    if !done || !count_ok || !min.is_finite() || !max.is_finite() || min >= max {
        return None;
    }
    let ticks: Vec<f64> = (0..=count as u32)
        .map(|i| round12(min + f64::from(i) * step))
        .collect();
    if ticks.iter().any(|t| !t.is_finite()) {
        return None;
    }
    Some(ValueTicks { min, max, ticks })
}

/// Ticks for ranges `value_ticks` cannot handle (A.3.2): `[lo, lo/2 + hi/2, hi]`; equal ends are
/// first widened toward zero, so the axis always has `lo < hi`.
pub fn extreme_ticks(lo: f64, hi: f64, height_px: f64, label_height_px: f64) -> ValueTicks {
    let _ = (height_px, label_height_px);
    let (lo, hi) = if lo < hi {
        (lo, hi)
    } else if lo > 0.0 {
        (lo / 2.0, lo)
    } else if lo < 0.0 {
        (lo, lo / 2.0)
    } else {
        (0.0, 1.0)
    };
    let m = lo / 2.0 + hi / 2.0;
    ValueTicks {
        min: lo,
        max: hi,
        ticks: vec![lo, m, hi],
    }
}

/// Relative slack on the label gap (#97): absorbs the rounding of `y0 − y1` only.
pub const GAP_TOLERANCE: f64 = 1e-9;

/// Where `v` sits on [min, max] as a fraction from min (#97 stub).
pub fn value_fraction(v: f64, min: f64, max: f64) -> f64 {
    let _ = (v, min, max);
    unimplemented!("#97: not implemented")
}

/// The renderer's y of `v` (#97 stub).
pub fn tick_y(v: f64, min: f64, max: f64, top: f64, height: f64) -> f64 {
    let _ = (v, min, max, top, height);
    unimplemented!("#97: not implemented")
}

/// True when every adjacent tick pair is one label gap apart on the drawn y (#97 stub).
pub fn ticks_fit(ticks: &[f64], min: f64, max: f64, height_px: f64, label_height_px: f64) -> bool {
    let _ = (ticks, min, max, height_px, label_height_px);
    unimplemented!("#97: not implemented")
}

/// Column of a sample, the interim formula: clamp(floor((t − from)/(to − from) · n), 0, n − 1),
/// in f64. Callers keep samples outside [from, to] out of every column.
pub fn column_of(t: f64, from: f64, to: f64, n: u32) -> u32 {
    let x = ((t - from) / (to - from) * f64::from(n)).floor();
    x.clamp(0.0, f64::from(n.saturating_sub(1))) as u32
}

/// Sample index ranges per column: entry c..c+1 is column c (len n + 1). One table for a grid
/// chunk (relative to the series start), one per series for explicit timestamps (absolute).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ColumnRanges {
    Grid(Vec<u32>),
    PerSeries { n: u32, table: Vec<u32> },
}

impl ColumnRanges {
    /// Columns per series.
    pub fn n(&self) -> u32 {
        match self {
            Self::Grid(t) => t.len().saturating_sub(1) as u32,
            Self::PerSeries { n, .. } => *n,
        }
    }

    /// Absolute sample range of column `c` of local series `s`, whose values start at `base`.
    pub fn range(&self, s: usize, c: usize, base: u32) -> (u32, u32) {
        match self {
            Self::Grid(t) => (base + t[c], base + t[c + 1]),
            Self::PerSeries { n, table } => {
                let row = s * (*n as usize + 1);
                (table[row + c], table[row + c + 1])
            }
        }
    }

    /// The table as uploaded (u32 words).
    pub fn words(&self) -> &[u32] {
        match self {
            Self::Grid(t) => t,
            Self::PerSeries { table, .. } => table,
        }
    }
}

/// Column ranges of `series` of `chunk` over the window [from, to] in `n` columns, in f64 from
/// the timestamps (T02-014): a grid chunk gets one table relative to the series start, an explicit
/// chunk one absolute table per series. `to ≤ from` (or a non-finite end) leaves every column
/// empty, as `lineColumns`.
pub fn column_ranges(
    chunk: &dash_wire::Chunk,
    series: std::ops::Range<u32>,
    from: f64,
    to: f64,
    n: u32,
) -> ColumnRanges {
    let valid = to > from && from.is_finite() && to.is_finite();
    match &chunk.time {
        dash_wire::TimeAxis::Grid {
            start_ms,
            step_ms,
            len,
        } => {
            let t = |k: u32| (start_ms + step_ms * i64::from(k)) as f64;
            ColumnRanges::Grid(table(*len, t, from, to, n, valid, 0))
        }
        dash_wire::TimeAxis::Explicit { t_ms } => {
            let mut out = Vec::with_capacity((series.len()) * (n as usize + 1));
            for s in series {
                let (a, b) = (chunk.offsets[s as usize], chunk.offsets[s as usize + 1]);
                let ts = &t_ms[a as usize..b as usize];
                out.extend(table(b - a, |k| ts[k as usize], from, to, n, valid, a));
            }
            ColumnRanges::PerSeries { n, table: out }
        }
    }
}

/// Entry c = the first in-window sample with column ≥ c (offset by `base`); entry n = the end of
/// the in-window samples. Timestamps are increasing, so columns are too.
fn table(
    len: u32,
    t: impl Fn(u32) -> f64,
    from: f64,
    to: f64,
    n: u32,
    valid: bool,
    base: u32,
) -> Vec<u32> {
    let mut out = vec![0u32; n as usize + 1];
    if !valid || n == 0 {
        out.fill(base);
        return out;
    }
    // [k0, k1): the in-window samples.
    let mut k = 0;
    // Timestamps are finite (ChunkBuilder), so `<` is the complement of `>=`.
    while k < len && t(k) < from {
        k += 1;
    }
    let mut c = 0usize;
    while k < len && t(k) <= to {
        let col = column_of(t(k), from, to, n) as usize;
        while c <= col {
            out[c] = base + k;
            c += 1;
        }
        k += 1;
    }
    while c <= n as usize {
        out[c] = base + k;
        c += 1;
    }
    out
}
