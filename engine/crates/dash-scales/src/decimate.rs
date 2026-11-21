//! Decimation (plan #68 §3.7, §4.2, A.15.2), the CPU path mirrored bit for bit by the WGSL passes
//! in `dash-marks` (`decimate.wgsl`, `link.wgsl`, `scan.wgsl`).
//!
//! Per (series, column) P1 reduces the column's samples to a 40-byte `ColOut`: the first and last
//! finite u, the exact number of NaN-free runs and runs 0 and 1 inline. Per series P2 counts and
//! P4 emits instances in column order (runs, then the segment into the column, then a dot); P3
//! is the prefix over series; P5 re-scans the columns with more than two runs and writes their
//! spans at `span_at + k`. Every comparison of two values is on an order-preserving integer key of
//! their f32 bits (`f32` `<`/`>` with ±0 equal), so no GPU denormal or NaN rule can change a choice.
//!
//! Joins (A.15.2): the segment into a drawn column runs from the previous drawn column's `last` to
//! this column's `first`, and exists unless a gap lies between them (a trailing gap of the previous
//! drawn column, an all-gap column between, or a gap before this column's first sample). Each run
//! is one instance: a vertical round-capped capsule from its max to its min, or a dot (radius
//! `width_css`) for a one-sample run that no segment reaches. So every pair of consecutive finite
//! samples with no gap between is covered by exactly the capsules a raw-point drawing has.

use rayon::prelude::*;

use crate::ColumnRanges;
use crate::encode::{ClipBox, GAP_BITS, SegClip, Side, clip_segment};

/// `ColOut.meta`: count class (0 none, 1 one, 2 ≥ 2 finite).
pub const COL_CLASS: u32 = 0b11;
pub const COL_HAS_FINITE: u32 = 1 << 2;
/// A gap sample before the first finite sample (or, with no finite sample, any gap).
pub const COL_GAP_LEAD: u32 = 1 << 3;
/// A gap between the first and the last finite sample.
pub const COL_GAP_INNER: u32 = 1 << 4;
/// A gap after the last finite sample.
pub const COL_GAP_TRAIL: u32 = 1 << 5;
/// Samples, none finite.
pub const COL_ALL_GAP: u32 = 1 << 6;
/// More than `INLINE_RUNS` runs: P5 writes the spans.
pub const COL_OVERFLOW: u32 = 1 << 7;
/// P4: a segment reaches the column's first sample.
pub const COL_JOIN_IN: u32 = 1 << 8;
/// P4: a segment leaves the column's last sample.
pub const COL_JOIN_OUT: u32 = 1 << 9;
/// Run 0 (bit 10) or run 1 (bit 11) has exactly one sample.
pub const COL_RUN0_SINGLE: u32 = 1 << 10;
pub const COL_RUN1_SINGLE: u32 = 1 << 11;

/// `LineInstance.meta`: bits 0..=3 colour slot (0–7 series, 8 grid).
pub const INST_SLOT: u32 = 0xF;
pub const INST_KIND_SHIFT: u32 = 4;
pub const KIND_SEGMENT: u32 = 0;
pub const KIND_SPAN: u32 = 1;
pub const KIND_DOT: u32 = 2;
pub const KIND_HLINE: u32 = 3;
/// Round caps at a and b. A.15.2's raw-point equality needs round caps on every capsule.
pub const INST_CAPS: u32 = (1 << 6) | (1 << 7);
/// Clip of end a (bits 8..=9) and b (bits 10..=11): 0 none, 1 at −U_CLAMP, 2 at +U_CLAMP; a
/// clipped end's `va`/`vb` holds t ∈ [0, 1] along the segment (A.3.3).
pub const INST_CLIP_A_SHIFT: u32 = 8;
pub const INST_CLIP_B_SHIFT: u32 = 10;
pub const CLIP_LOW: u32 = 1;
pub const CLIP_HIGH: u32 = 2;
pub const INST_LANE_SHIFT: u32 = 16;

pub const INLINE_RUNS: usize = 2;

/// One (series, column); 40 bytes, the GPU layout (std430).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ColOut {
    /// u of the last finite sample.
    pub last: f32,
    /// u of the first finite sample.
    pub first: f32,
    /// Bits `COL_*`.
    pub meta: u32,
    /// Exact number of NaN-free runs in the column.
    pub n_runs: u32,
    /// P4: global instance index of the column's first span.
    pub span_at: u32,
    pub _pad: u32,
    /// [max, min] of runs 0 and 1; valid when n_runs ≤ 2.
    pub runs: [[f32; 2]; INLINE_RUNS],
}

/// One drawn primitive; 16 bytes; an instance vertex buffer.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct LineInstance {
    /// lo16 column, hi16 dx to the previous drawn column.
    pub col: u32,
    pub va: f32,
    pub vb: f32,
    /// Bits `INST_*`.
    pub meta: u32,
}

/// Data for one far item (A.3.3).
#[derive(Clone, Copy, Debug)]
pub struct FarClip<'a> {
    /// The chunk's f64 values.
    pub values: &'a [f64],
    pub clip: ClipBox,
}

#[derive(Clone, Debug)]
pub struct DecimateInput<'a> {
    pub values_bits: &'a [u32],
    pub offsets: &'a [u32],
    pub ranges: &'a ColumnRanges,
    pub n: u32,
    pub guides: u32,
    pub colour_slots: &'a [u8],
    pub lanes: &'a [u16],
    /// Global instance indices to write (batching).
    pub window: std::ops::Range<u64>,
    /// Some for a far item: segments clipped in f64.
    pub far: Option<FarClip<'a>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Decimated {
    pub cols: Vec<ColOut>,
    pub counts: Vec<u32>,
    pub starts: Vec<u32>,
    pub total: u64,
    /// Indices window.start..min(window.end, G + total); guide slots are zero.
    pub instances: Vec<LineInstance>,
}

/// The order-preserving key of f32 bits, with −0 equal to +0: `key(a) > key(b)` ⇔ `a > b`.
#[inline]
pub fn key(bits: u32) -> u32 {
    if bits & 0x7FFF_FFFF == 0 {
        0x8000_0000
    } else if bits & 0x8000_0000 != 0 {
        !bits
    } else {
        bits | 0x8000_0000
    }
}

/// P1 of one column of `bits` (absolute indices `lo..hi`): the `ColOut` and the absolute indices
/// of its first and last finite samples.
pub fn reduce_column(bits: &[u32], lo: u32, hi: u32) -> (ColOut, u32, u32) {
    let mut out = ColOut::default();
    let (mut count, mut n_runs) = (0u32, 0u32);
    let (mut in_run, mut gap_since_last, mut lead, mut inner) = (false, false, false, false);
    let (mut first, mut last) = (0u32, 0u32);
    let (mut first_i, mut last_i) = (lo, lo);
    let mut runs = [[0u32; 2]; INLINE_RUNS];
    let mut run_count = [0u32; INLINE_RUNS];
    for i in lo..hi {
        let b = bits[i as usize];
        if b == GAP_BITS {
            if count == 0 {
                lead = true;
            } else {
                gap_since_last = true;
            }
            in_run = false;
            continue;
        }
        if count > 0 && gap_since_last {
            inner = true;
        }
        gap_since_last = false;
        if !in_run {
            if (n_runs as usize) < INLINE_RUNS {
                runs[n_runs as usize] = [b, b];
                run_count[n_runs as usize] = 1;
            }
            n_runs += 1;
            in_run = true;
        } else {
            let k = (n_runs - 1) as usize;
            if k < INLINE_RUNS {
                if key(b) > key(runs[k][0]) {
                    runs[k][0] = b;
                }
                if key(b) < key(runs[k][1]) {
                    runs[k][1] = b;
                }
                run_count[k] += 1;
            }
        }
        if count == 0 {
            first = b;
            first_i = i;
        }
        last = b;
        last_i = i;
        count += 1;
    }
    let mut meta = count.min(2);
    if count > 0 {
        meta |= COL_HAS_FINITE;
    }
    if lead {
        meta |= COL_GAP_LEAD;
    }
    if inner {
        meta |= COL_GAP_INNER;
    }
    if gap_since_last {
        meta |= COL_GAP_TRAIL;
    }
    if count == 0 && hi > lo {
        meta |= COL_ALL_GAP;
    }
    if n_runs as usize > INLINE_RUNS {
        meta |= COL_OVERFLOW;
    }
    if n_runs >= 1 && run_count[0] == 1 {
        meta |= COL_RUN0_SINGLE;
    }
    if n_runs >= 2 && run_count[1] == 1 {
        meta |= COL_RUN1_SINGLE;
    }
    out.last = f32::from_bits(last);
    out.first = f32::from_bits(first);
    out.meta = meta;
    out.n_runs = n_runs;
    for (dst, src) in out.runs.iter_mut().zip(runs) {
        *dst = [f32::from_bits(src[0]), f32::from_bits(src[1])];
    }
    (out, first_i, last_i)
}

/// The instance of run `k` of a drawn column: a span capsule from max to min, or a dot for a
/// one-sample run that no segment reaches. Argument for argument the WGSL `run_instance`.
#[inline]
#[allow(clippy::too_many_arguments)]
pub fn run_instance(
    c: u32,
    k: u32,
    n_runs: u32,
    max: f32,
    min: f32,
    single: bool,
    col_meta: u32,
    base: u32,
) -> LineInstance {
    let joined = (k == 0 && col_meta & COL_JOIN_IN != 0)
        || (k + 1 == n_runs && col_meta & COL_JOIN_OUT != 0);
    if single && !joined {
        LineInstance {
            col: c,
            va: max,
            vb: max,
            meta: base | (KIND_DOT << INST_KIND_SHIFT),
        }
    } else {
        LineInstance {
            col: c,
            va: max,
            vb: min,
            meta: base | (KIND_SPAN << INST_KIND_SHIFT),
        }
    }
}

/// Where P4 and P5 write: global instance indices `window`.
struct Sink<'a> {
    out: &'a mut [LineInstance],
    window: std::ops::Range<u64>,
}

impl Sink<'_> {
    #[inline]
    fn put(&mut self, at: u64, inst: LineInstance) {
        if at >= self.window.start
            && at < self.window.end
            && let Some(slot) = self.out.get_mut((at - self.window.start) as usize)
        {
            *slot = inst;
        }
    }
}

/// P1 of one series: its `ColOut`s and their (first, last) finite sample indices.
type SeriesP1 = (Vec<ColOut>, Vec<(u32, u32)>);

/// The previous drawn column while a series is linked (P2, P4).
#[derive(Clone, Copy)]
struct Drawn {
    c: u32,
    join_in: bool,
    pred_c: u32,
    pred_last: f32,
}

/// Instances of a drawn column given whether segments reach and leave it (P2 counts them).
fn column_count(co: &ColOut, join_in: bool, join_out: bool) -> u32 {
    let seg = u32::from(join_in);
    match co.meta & COL_CLASS {
        2 => co.n_runs + seg,
        _ => seg + u32::from(!join_in && !join_out),
    }
}

/// Walks the drawn columns of one series, calling `f(column, join_in, join_out, drawn)` in column
/// order (one column behind, so `join_out` is known).
fn link(cols: &[ColOut], mut f: impl FnMut(u32, bool, Drawn)) {
    let mut prev: Option<Drawn> = None;
    let mut pending = false;
    let mut prev_last = 0.0f32;
    for (c, co) in cols.iter().enumerate() {
        let class = co.meta & COL_CLASS;
        if class == 0 {
            if co.meta & COL_ALL_GAP != 0 {
                pending = true;
            }
            continue;
        }
        let join_in = prev.is_some() && !(pending || co.meta & COL_GAP_LEAD != 0);
        let d = Drawn {
            c: c as u32,
            join_in,
            pred_c: prev.map_or(0, |p| p.c),
            pred_last: prev_last,
        };
        if let Some(p) = prev {
            f(p.c, join_in, p);
        }
        prev = Some(d);
        prev_last = co.last;
        pending = co.meta & COL_GAP_TRAIL != 0;
    }
    if let Some(p) = prev {
        f(p.c, false, p);
    }
}

/// The T2 path: P1 and P5 in parallel over series (rayon, one task per series, fixed chunking,
/// T03-021), P2–P4 sequential per series; bit-identical to the T1 compute passes.
pub fn decimate(input: &DecimateInput) -> Decimated {
    let n = input.n as usize;
    let series = input.offsets.len().saturating_sub(1);
    let base = |s: usize| input.offsets[s];
    // P1, with the CPU-only first/last sample indices (A.3.3).
    let p1: Vec<SeriesP1> = (0..series)
        .into_par_iter()
        .with_min_len(1)
        .with_max_len(1)
        .map(|s| {
            let mut cols = Vec::with_capacity(n);
            let mut idx = Vec::with_capacity(n);
            for c in 0..n {
                let (lo, hi) = input.ranges.range(s, c, base(s));
                let (co, fi, li) = reduce_column(input.values_bits, lo, hi);
                cols.push(co);
                idx.push((fi, li));
            }
            (cols, idx)
        })
        .collect();
    let mut cols: Vec<ColOut> = Vec::with_capacity(series * n);
    let mut idx: Vec<(u32, u32)> = Vec::with_capacity(series * n);
    for (c, i) in p1 {
        cols.extend(c);
        idx.extend(i);
    }
    // P2: per-series instance counts.
    let counts: Vec<u32> = (0..series)
        .map(|s| {
            let row = &cols[s * n..(s + 1) * n];
            let mut count = 0u32;
            link(row, |c, join_out, d| {
                count += column_count(&row[c as usize], d.join_in, join_out)
            });
            count
        })
        .collect();
    // P3: exclusive prefix from G.
    let mut starts = Vec::with_capacity(series);
    let mut total = 0u64;
    for c in &counts {
        starts.push((u64::from(input.guides) + total) as u32);
        total += u64::from(*c);
    }
    let end = (u64::from(input.guides) + total).min(input.window.end);
    let len = end.saturating_sub(input.window.start) as usize;
    let mut instances = vec![LineInstance::default(); len];
    let mut sink = Sink {
        out: &mut instances,
        window: input.window.clone(),
    };
    // P4: emit in column order; span_at and the join bits go back into the ColOut.
    for s in 0..series {
        let slot = u32::from(input.colour_slots.get(s).copied().unwrap_or(0)) & INST_SLOT;
        let lane = u32::from(input.lanes.get(s).copied().unwrap_or(0)) << INST_LANE_SHIFT;
        let base_meta = slot | INST_CAPS | lane;
        let mut at = u64::from(starts[s]);
        let row = &mut cols[s * n..(s + 1) * n];
        let mut emitted: Vec<(u32, bool, Drawn)> = Vec::new();
        link(row, |c, join_out, d| emitted.push((c, join_out, d)));
        for (c, join_out, d) in emitted {
            let co = &mut row[c as usize];
            if d.join_in {
                co.meta |= COL_JOIN_IN;
            }
            if join_out {
                co.meta |= COL_JOIN_OUT;
            }
            let co = *co;
            if co.meta & COL_CLASS == 2 {
                row[c as usize].span_at = at as u32;
                if co.meta & COL_OVERFLOW == 0 {
                    for k in 0..co.n_runs {
                        let single = co.meta & (COL_RUN0_SINGLE << k) != 0;
                        let [max, min] = co.runs[k as usize];
                        sink.put(
                            at,
                            run_instance(c, k, co.n_runs, max, min, single, co.meta, base_meta),
                        );
                        at += 1;
                    }
                } else {
                    at += u64::from(co.n_runs);
                }
            }
            if d.join_in {
                let mut inst = LineInstance {
                    col: c | ((c - d.pred_c) << 16),
                    va: d.pred_last,
                    vb: co.first,
                    meta: base_meta | (KIND_SEGMENT << INST_KIND_SHIFT),
                };
                if let Some(far) = &input.far {
                    let a = idx[s * n + d.pred_c as usize].1;
                    let b = idx[s * n + c as usize].0;
                    clip_far(
                        &mut inst,
                        far.values[a as usize],
                        far.values[b as usize],
                        &far.clip,
                    );
                }
                sink.put(at, inst);
                at += 1;
            }
            if co.meta & COL_CLASS == 1 && !d.join_in && !join_out {
                let meta = base_meta | (KIND_DOT << INST_KIND_SHIFT);
                sink.put(
                    at,
                    LineInstance {
                        col: c,
                        va: co.last,
                        vb: co.last,
                        meta,
                    },
                );
                at += 1;
            }
        }
    }
    // P5: spill the spans of overflow columns, in run order.
    let spill: Vec<Vec<(u64, LineInstance)>> = (0..series)
        .into_par_iter()
        .with_min_len(1)
        .with_max_len(1)
        .map(|s| {
            let slot = u32::from(input.colour_slots.get(s).copied().unwrap_or(0)) & INST_SLOT;
            let lane = u32::from(input.lanes.get(s).copied().unwrap_or(0)) << INST_LANE_SHIFT;
            let base_meta = slot | INST_CAPS | lane;
            let mut out = Vec::new();
            for c in 0..n {
                let co = cols[s * n + c];
                if co.meta & COL_CLASS != 2 || co.meta & COL_OVERFLOW == 0 {
                    continue;
                }
                let (lo, hi) = input.ranges.range(s, c, base(s));
                spill_column(
                    input.values_bits,
                    lo,
                    hi,
                    c as u32,
                    &co,
                    base_meta,
                    |k, inst| {
                        out.push((u64::from(co.span_at) + u64::from(k), inst));
                    },
                );
            }
            out
        })
        .collect();
    for list in spill {
        for (at, inst) in list {
            sink.put(at, inst);
        }
    }
    Decimated {
        cols,
        counts,
        starts,
        total,
        instances,
    }
}

/// P5 of one overflow column: run k's instance, in run order.
pub fn spill_column(
    bits: &[u32],
    lo: u32,
    hi: u32,
    c: u32,
    co: &ColOut,
    base_meta: u32,
    mut put: impl FnMut(u32, LineInstance),
) {
    let (mut k, mut in_run) = (0u32, false);
    let (mut max, mut min, mut count) = (0u32, 0u32, 0u32);
    for i in lo..=hi {
        let b = if i < hi { bits[i as usize] } else { GAP_BITS };
        if b == GAP_BITS {
            if in_run {
                let (fmax, fmin) = (f32::from_bits(max), f32::from_bits(min));
                put(
                    k,
                    run_instance(c, k, co.n_runs, fmax, fmin, count == 1, co.meta, base_meta),
                );
                k += 1;
            }
            in_run = false;
            continue;
        }
        if !in_run {
            (max, min, count) = (b, b, 1);
            in_run = true;
        } else {
            if key(b) > key(max) {
                max = b;
            }
            if key(b) < key(min) {
                min = b;
            }
            count += 1;
        }
    }
}

/// A.3.3: a far item's segment between the f64 values `va` and `vb`, clipped to the clip box.
fn clip_far(inst: &mut LineInstance, va: f64, vb: f64, clip: &ClipBox) {
    let code = |s: Side| if s == Side::Low { CLIP_LOW } else { CLIP_HIGH };
    match clip_segment(va, vb, clip) {
        SegClip::Inside => {}
        SegClip::Clipped { a, b } => {
            if let Some((t, side)) = a {
                inst.va = t as f32;
                inst.meta |= code(side) << INST_CLIP_A_SHIFT;
            }
            if let Some((t, side)) = b {
                inst.vb = t as f32;
                inst.meta |= code(side) << INST_CLIP_B_SHIFT;
            }
        }
        SegClip::Outside(side) => {
            inst.va = 0.0;
            inst.vb = 1.0;
            inst.meta |= (code(side) << INST_CLIP_A_SHIFT) | (code(side) << INST_CLIP_B_SHIFT);
        }
    }
}
