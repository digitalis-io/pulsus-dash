//! Positions, columns and decimation (T02-014, T02-015; plan #24 §3.3, §4.3).
//!
//! Samples sit at their true positions: `x(k) = (f32(k − k0) + c0) · s` and
//! `y(b) = (f32(b) + d) · a` are two IEEE operations each (add, then multiply), so the CPU and
//! every GPU stage compute the same `f32`. Values are stored as `f32(v − v_ref)` bits; NULLs
//! (invalid or non-finite) are [`NULL_BITS`]. The decimation compares bits only (as `f32`), so
//! its output is identical on the CPU, T1 and T2 for any thread count (T02-015).

/// The bits of a NULL sample (a quiet NaN `to_bits` never produces for a value).
pub const NULL_BITS: u32 = 0x7FC0_0000;
/// Pyramid branching factor.
pub const PYRAMID_B: u32 = 16;
/// Off-plot columns on each side.
pub const MARGIN: u32 = 4;
/// In `a[2]` of a record: the slot has more than three runs.
pub const OVERFLOW_BITS: u32 = 0x7FC0_0001;

/// Pyramid flags: bit0 any NULL, bit1 all NULL.
const ANY_NULL: u32 = 1;
const ALL_NULL: u32 = 2;

/// `f32(v − v_ref)` bits; [`NULL_BITS`] if invalid or non-finite (before or after the
/// conversion); `+0.0` for ±0.0.
pub fn to_bits(v: f64, valid: bool, v_ref: f64) -> u32 {
    if !valid || !v.is_finite() {
        return NULL_BITS;
    }
    let f = (v - v_ref) as f32;
    if !f.is_finite() {
        NULL_BITS
    } else if f == 0.0 {
        0
    } else {
        f.to_bits()
    }
}

/// [`to_bits`] of every sample into `out` (`out.len()` samples).
pub fn rel_bits(values: &[f64], is_valid: &dyn Fn(usize) -> bool, v_ref: f64, out: &mut [u32]) {
    for (k, (v, o)) in values.iter().zip(out.iter_mut()).enumerate() {
        *o = to_bits(*v, is_valid(k), v_ref);
    }
}

/// The smaller of two value bits as `f32`; NULL loses.
fn bmin(a: u32, b: u32) -> u32 {
    if a == NULL_BITS || (b != NULL_BITS && f32::from_bits(b) < f32::from_bits(a)) {
        b
    } else {
        a
    }
}

/// The larger of two value bits as `f32`; NULL loses.
fn bmax(a: u32, b: u32) -> u32 {
    if a == NULL_BITS || (b != NULL_BITS && f32::from_bits(b) > f32::from_bits(a)) {
        b
    } else {
        a
    }
}

/// The min/max pyramid: `levels[ℓ−1][e] = [min, max, flags, 0]` over
/// `[e·16^ℓ, min((e+1)·16^ℓ, n))`; flags bit0 any NULL, bit1 all NULL (then min = max = NULL).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pyramid {
    pub levels: Vec<Vec<[u32; 4]>>,
}

/// `#{ℓ ≥ 1 : 16^ℓ < n}`.
pub fn levels_for(n: u32) -> u32 {
    let mut l = 0;
    let mut size = u64::from(PYRAMID_B);
    while size < u64::from(n) {
        l += 1;
        size *= u64::from(PYRAMID_B);
    }
    l
}

/// The level-0 entry of one sample.
fn leaf(b: u32) -> [u32; 4] {
    if b == NULL_BITS {
        [NULL_BITS, NULL_BITS, ANY_NULL | ALL_NULL, 0]
    } else {
        [b, b, 0, 0]
    }
}

/// Combines entries (NULL loses; any = OR, all = AND).
fn combine(acc: [u32; 4], e: [u32; 4]) -> [u32; 4] {
    [
        bmin(acc[0], e[0]),
        bmax(acc[1], e[1]),
        ((acc[2] | e[2]) & ANY_NULL) | (acc[2] & e[2] & ALL_NULL),
        0,
    ]
}

/// The identity of [`combine`].
const NONE: [u32; 4] = [NULL_BITS, NULL_BITS, ALL_NULL, 0];

/// Builds the pyramid of `bits` into `out`, reusing its allocations.
pub fn build_pyramid(bits: &[u32], out: &mut Pyramid) {
    let levels = levels_for(bits.len() as u32) as usize;
    out.levels.resize_with(levels, Vec::new);
    let b = PYRAMID_B as usize;
    for l in 0..levels {
        let (done, rest) = out.levels.split_at_mut(l);
        let level = &mut rest[0];
        level.clear();
        match done.last() {
            None => level.extend(
                bits.chunks(b)
                    .map(|c| c.iter().fold(NONE, |acc, x| combine(acc, leaf(*x)))),
            ),
            Some(prev) => level.extend(
                prev.chunks(b)
                    .map(|c| c.iter().fold(NONE, |acc, x| combine(acc, *x))),
            ),
        }
    }
}

/// The reference value and range of a series' finite valid samples.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Prepared {
    pub v_ref: f64,
    pub min: f64,
    pub max: f64,
}

/// `v_ref = (min + max) / 2` over the finite valid samples; `(0, NaN, NaN)` if there are none.
pub fn prepare(values: &[f64], is_valid: &dyn Fn(usize) -> bool) -> Prepared {
    let mut range: Option<(f64, f64)> = None;
    for (k, v) in values.iter().enumerate() {
        if v.is_finite() && is_valid(k) {
            range = Some(match range {
                None => (*v, *v),
                Some((lo, hi)) => (lo.min(*v), hi.max(*v)),
            });
        }
    }
    match range {
        Some((min, max)) => Prepared {
            v_ref: (min + max) / 2.0,
            min,
            max,
        },
        None => Prepared {
            v_ref: 0.0,
            min: f64::NAN,
            max: f64::NAN,
        },
    }
}

/// `x(k) = (f32(k − k0) + c0) · s`, plot-relative device px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct XMap {
    pub k0: i32,
    pub c0: f32,
    pub s: f32,
}

/// `|κ|` clamp: keeps `k − k0` exact in `f32` for `k ≤ 10⁶`.
const KAPPA_MAX: f64 = (1u32 << 23) as f64;

impl XMap {
    /// `κ = clamp(t_left_rel / step, ±2²³)`, `k0 = ⌊κ⌋`, `c0 = f32(k0 − κ)`,
    /// `s = f32(step / ms_per_px)`.
    pub fn new(step_ms: f64, t_left_rel_ms: f64, ms_per_px: f64) -> XMap {
        let kappa = (t_left_rel_ms / step_ms).clamp(-KAPPA_MAX, KAPPA_MAX);
        let kappa = if kappa.is_nan() { 0.0 } else { kappa };
        let k0 = kappa.floor();
        XMap {
            k0: k0 as i32,
            c0: (k0 - kappa) as f32,
            s: (step_ms / ms_per_px) as f32,
        }
    }

    /// The device-px x of sample `k` (add, then multiply).
    pub fn x(&self, k: u32) -> f32 {
        let rel = (i64::from(k) - i64::from(self.k0)) as f32;
        (rel + self.c0) * self.s
    }

    /// The pixel column of sample `k`: `⌊x(k)⌋`.
    pub fn col(&self, k: u32) -> i32 {
        self.x(k).floor() as i32
    }
}

/// The plot's device-pixel columns `c ∈ [−M, plot_w + M)` and their sample ranges.
#[derive(Clone, Debug, PartialEq)]
pub struct Columns {
    pub xmap: XMap,
    pub n: u32,
    pub plot_w: u32,
    /// `bounds[j]` = the smallest `k ∈ [0, n]` with `col(k) ≥ j − M` (`n` if none).
    pub bounds: Vec<u32>,
    /// The last sample left of the columns, if any.
    pub k_l: Option<u32>,
    /// The first sample right of the columns, if any.
    pub k_r: Option<u32>,
}

impl Columns {
    pub fn new(xmap: XMap, n: u32, plot_w: u32) -> Columns {
        let m = i64::from(MARGIN);
        let kappa = f64::from(xmap.k0) - f64::from(xmap.c0);
        let beta = 1.0 / f64::from(xmap.s);
        let count = plot_w as usize + 2 * MARGIN as usize + 1;
        let mut bounds = Vec::with_capacity(count);
        let mut lo = 0u32;
        for j in 0..count as i64 {
            let target = j - m;
            let guess = (kappa + target as f64 * beta).ceil();
            let guess = if guess.is_finite() {
                guess.clamp(0.0, f64::from(n)) as u32
            } else {
                lo
            };
            let b = first_at_least(&xmap, target, guess, lo, n);
            bounds.push(b);
            lo = b;
        }
        let k_l = bounds.first().filter(|b| **b > 0).map(|b| b - 1);
        let k_r = bounds.last().copied().filter(|b| *b < n);
        Columns {
            xmap,
            n,
            plot_w,
            bounds,
            k_l,
            k_r,
        }
    }

    /// `plot_w + 2·MARGIN + 2`: slot 0 (`k_l`), one per column, the last (`k_r`).
    pub fn slots(&self) -> u32 {
        self.plot_w + 2 * MARGIN + 2
    }

    /// The sample range `[lo, hi)` of slot `s` (`lo == hi` when empty).
    pub fn slot_range(&self, s: u32) -> (u32, u32) {
        let last = self.slots() - 1;
        let one = |k: Option<u32>| k.map_or((0, 0), |k| (k, k + 1));
        if s == 0 {
            one(self.k_l)
        } else if s < last {
            let s = s as usize;
            (self.bounds[s - 1], self.bounds[s])
        } else if s == last {
            one(self.k_r)
        } else {
            (0, 0)
        }
    }
}

/// The smallest `k ∈ [lo, n]` with `col(k) ≥ target` (`n` if none), galloping from `guess`
/// then bisecting; `col` is monotone in `k`.
fn first_at_least(x: &XMap, target: i64, guess: u32, lo: u32, n: u32) -> u32 {
    let ok = |k: u32| k >= n || i64::from(x.col(k)) >= target;
    let g = guess.clamp(lo, n);
    // Invariant once found: !ok(a) (or a = lo − 1), ok(b); the answer is in (a, b].
    let (mut a, mut b): (i64, i64);
    if ok(g) {
        b = i64::from(g);
        let mut step = 1i64;
        loop {
            let c = b - step;
            if c < i64::from(lo) {
                a = i64::from(lo) - 1;
                break;
            }
            if ok(c as u32) {
                b = c;
                step *= 2;
            } else {
                a = c;
                break;
            }
        }
    } else {
        a = i64::from(g);
        let mut step = 1i64;
        loop {
            let c = (a + step).min(i64::from(n));
            if ok(c as u32) {
                b = c;
                break;
            }
            a = c;
            step *= 2;
        }
    }
    while b - a > 1 {
        let mid = a + (b - a) / 2;
        if ok(mid as u32) {
            b = mid;
        } else {
            a = mid;
        }
    }
    b as u32
}

/// One slot's record (32 bytes): `a = [min₀, max₀, min₁, max₁]`, `b = [min₂, max₂, last, next]`;
/// with more than three runs `a = [min, max, OVERFLOW_BITS, NULL]`.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SlotRecord {
    pub a: [u32; 4],
    pub b: [u32; 4],
}

/// The record of an empty slot.
pub const EMPTY: SlotRecord = SlotRecord {
    a: [NULL_BITS; 4],
    b: [NULL_BITS; 4],
};

fn is_mixed(e: [u32; 4]) -> bool {
    e[2] & ANY_NULL != 0 && e[2] & ALL_NULL == 0
}

/// The record of the sample range `[lo, hi)` by the pyramid walk of plan §4.3; `next` = whether
/// `b[3]` holds `bits[hi]` (when `hi < n`).
pub fn slot_record(bits: &[u32], p: &Pyramid, lo: u32, hi: u32, next: bool) -> SlotRecord {
    let n = bits.len() as u64;
    let (lo, hi) = (u64::from(lo), u64::from(hi).min(n));
    if lo >= hi {
        return EMPTY;
    }
    let top = p.levels.len() as u32;
    let b = u64::from(PYRAMID_B);
    let entry = |lvl: u32, k: u64| -> [u32; 4] {
        if lvl == 0 {
            leaf(bits[k as usize])
        } else {
            p.levels[lvl as usize - 1][(k / b.pow(lvl)) as usize]
        }
    };
    let mut k = lo;
    let mut lvl = 0u32;
    let mut run: Option<(u32, u32)> = None;
    let mut all: Option<(u32, u32)> = None;
    let mut runs = 0usize;
    let mut iv = [(NULL_BITS, NULL_BITS); 3];
    let mut close = |run: &mut Option<(u32, u32)>, runs: &mut usize| {
        if let Some(r) = run.take() {
            *runs += 1;
            if *runs <= 3 {
                iv[*runs - 1] = r;
            }
        }
    };
    let add = |acc: Option<(u32, u32)>, e: [u32; 4]| {
        Some(match acc {
            None => (e[0], e[1]),
            Some((mn, mx)) => (bmin(mn, e[0]), bmax(mx, e[1])),
        })
    };
    while k < hi {
        let s0 = b.pow(lvl);
        if lvl < top
            && k % (b * s0) == 0
            && (k + b * s0).min(n) <= hi
            && !is_mixed(entry(lvl + 1, k))
        {
            lvl += 1;
            continue;
        }
        if (k + s0).min(n) > hi {
            lvl = lvl.saturating_sub(1);
            continue;
        }
        let e = entry(lvl, k);
        if e[2] & ALL_NULL != 0 {
            close(&mut run, &mut runs);
            k += s0;
        } else if e[2] & ANY_NULL == 0 {
            run = add(run, e);
            all = add(all, e);
            k += s0;
        } else {
            lvl = lvl.saturating_sub(1);
        }
    }
    close(&mut run, &mut runs);
    let mut r = EMPTY;
    if runs > 3 {
        if let Some((mn, mx)) = all {
            r.a = [mn, mx, OVERFLOW_BITS, NULL_BITS];
        }
    } else {
        r.a = [iv[0].0, iv[0].1, iv[1].0, iv[1].1];
        r.b[0] = iv[2].0;
        r.b[1] = iv[2].1;
    }
    r.b[2] = bits[hi as usize - 1];
    if next && hi < n {
        r.b[3] = bits[hi as usize];
    }
    r
}

/// Every slot's record (the specification of the GPU pass, §4.3).
pub fn decimate_series(bits: &[u32], p: &Pyramid, c: &Columns) -> Vec<SlotRecord> {
    let last = c.slots() - 1;
    (0..c.slots())
        .map(|s| {
            let (lo, hi) = c.slot_range(s);
            slot_record(bits, p, lo, hi, s != last)
        })
        .collect()
}

/// Streams the reference passes of one series (§4.4) one pass at a time: per slot except the
/// last, the next raw item (a segment `k → k + 1` between valid samples, or a dot at a valid `k`
/// without valid neighbours) and its `k`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReferenceCursor {
    /// Per slot: the next `k` to scan and the slot's end.
    at: Vec<(u32, u32)>,
}

impl ReferenceCursor {
    pub fn new(c: &Columns) -> ReferenceCursor {
        let last = c.slots() - 1;
        ReferenceCursor {
            at: (0..c.slots())
                .map(|s| if s == last { (0, 0) } else { c.slot_range(s) })
                .collect(),
        }
    }

    /// Writes the next pass into `recs`, `ks` (one entry per slot; `EMPTY` / `u32::MAX` where a
    /// slot has no item left). Returns `false` (and writes nothing) when every slot is done.
    pub fn next_pass(&mut self, bits: &[u32], recs: &mut [SlotRecord], ks: &mut [u32]) -> bool {
        let n = bits.len() as u32;
        let valid = |k: u32| k < n && bits[k as usize] != NULL_BITS;
        let mut any = false;
        for (s, (k, hi)) in self.at.iter_mut().enumerate() {
            let mut item = None;
            while *k < *hi && item.is_none() {
                let j = *k;
                *k += 1;
                if !valid(j) {
                    continue;
                }
                let v = bits[j as usize];
                if valid(j + 1) {
                    item = Some((
                        SlotRecord {
                            a: [NULL_BITS; 4],
                            b: [NULL_BITS, NULL_BITS, v, bits[j as usize + 1]],
                        },
                        j,
                    ));
                } else if j == 0 || !valid(j - 1) {
                    item = Some((
                        SlotRecord {
                            a: [v, v, NULL_BITS, NULL_BITS],
                            b: [NULL_BITS; 4],
                        },
                        j,
                    ));
                }
            }
            let (r, kk) = item.unwrap_or((EMPTY, u32::MAX));
            any |= kk != u32::MAX;
            if let (Some(rs), Some(kz)) = (recs.get_mut(s), ks.get_mut(s)) {
                *rs = r;
                *kz = kk;
            }
        }
        any
    }
}

/// Every reference pass of one series: pass `q` holds item `q` of each slot (§4.4).
pub fn reference_passes(bits: &[u32], c: &Columns) -> Vec<(Vec<SlotRecord>, Vec<u32>)> {
    let mut cur = ReferenceCursor::new(c);
    let slots = c.slots() as usize;
    let mut out = Vec::new();
    loop {
        let mut recs = vec![EMPTY; slots];
        let mut ks = vec![u32::MAX; slots];
        if !cur.next_pass(bits, &mut recs, &mut ks) {
            return out;
        }
        out.push((recs, ks));
    }
}

/// `y(b) = (f32::from_bits(b) + d) · a`, plot-relative device px (add, then multiply).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct YMap {
    pub d: f32,
    pub a: f32,
}

impl YMap {
    pub fn y(&self, b: u32) -> f32 {
        (f32::from_bits(b) + self.d) * self.a
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_bits_cases() {
        assert_eq!(to_bits(100.0, true, 100.0), 0);
        assert_eq!(to_bits(101.5, true, 100.0), 1.5f32.to_bits());
        assert_eq!(to_bits(-0.0, true, 0.0), 0);
        assert_eq!(to_bits(f64::NAN, true, 0.0), NULL_BITS);
        assert_eq!(to_bits(f64::INFINITY, true, 0.0), NULL_BITS);
        assert_eq!(to_bits(1e300, true, 0.0), NULL_BITS);
        assert_eq!(to_bits(5.0, false, 0.0), NULL_BITS);
        let mut out = [7u32; 3];
        rel_bits(&[1.0, 2.0, 3.0], &|k| k != 1, 1.0, &mut out);
        assert_eq!(out, [0, NULL_BITS, 2.0f32.to_bits()]);
    }

    #[test]
    fn pyramid_shape() {
        let n = 100_000u32;
        let mut bits: Vec<u32> = (0..n).map(|k| (k as f32).to_bits()).collect();
        for b in &mut bits[48..64] {
            *b = NULL_BITS;
        }
        bits[70] = NULL_BITS;
        assert_eq!(levels_for(n), 4);
        assert_eq!(levels_for(16), 0);
        assert_eq!(levels_for(17), 1);
        let mut p = Pyramid::default();
        build_pyramid(&bits, &mut p);
        let lens: Vec<usize> = p.levels.iter().map(Vec::len).collect();
        assert_eq!(lens, vec![6_250, 391, 25, 2]);
        let f = |v: f32| v.to_bits();
        assert_eq!(p.levels[0][0], [f(0.0), f(15.0), 0, 0]);
        assert_eq!(p.levels[0][3], [NULL_BITS, NULL_BITS, 3, 0]);
        assert_eq!(p.levels[0][4], [f(64.0), f(79.0), 1, 0]);
        assert_eq!(p.levels[1][0], [f(0.0), f(255.0), 1, 0]);
        assert_eq!(p.levels[3][1], [f(65_536.0), f(99_999.0), 0, 0]);
        // Reuses the allocations.
        let ptr = p.levels[0].as_ptr();
        build_pyramid(&bits, &mut p);
        assert_eq!(p.levels[0].as_ptr(), ptr);
    }

    #[test]
    fn xmap_and_columns() {
        let xm = XMap::new(10.0, 1_234.5, 25.0);
        assert_eq!(xm.k0, 123);
        assert_eq!(xm.c0, -0.45f32);
        assert_eq!(xm.s, 0.4f32);
        assert_eq!(xm.x(124), (1.0f32 - 0.45) * 0.4);
        let c = Columns::new(xm, 1_000, 100);
        assert_eq!(c.bounds.len(), 109);
        assert_eq!(c.k_l, Some(113));
        assert_eq!(c.k_r, Some(384));
        assert_eq!(c.slots(), 110);
        let m = MARGIN as i32;
        assert_eq!(c.slot_range(0), (113, 114));
        assert!(xm.col(113) < -m);
        for s in 1..c.slots() - 1 {
            let (lo, hi) = c.slot_range(s);
            for k in lo..hi {
                assert_eq!(xm.col(k), s as i32 - 1 - m, "slot {s} k {k}");
            }
        }
        assert_eq!(c.slot_range(109), (384, 385));
        assert!(xm.col(384) >= 100 + m);
        let covered: u32 = (0..c.slots())
            .map(|s| {
                let (lo, hi) = c.slot_range(s);
                hi - lo
            })
            .sum();
        assert_eq!(covered, 385 - 113);

        let far = Columns::new(XMap::new(10.0, 1e15, 25.0), 1_000, 100);
        assert_eq!(far.xmap.k0, 1 << 23);
        assert!(far.bounds.iter().all(|b| *b == 1_000));
        assert_eq!(far.k_l, Some(999));
        assert_eq!(far.k_r, None);
        assert_eq!(far.slot_range(0), (999, 1_000));
        for s in 1..far.slots() {
            let (lo, hi) = far.slot_range(s);
            assert_eq!(lo, hi, "slot {s}");
        }
        let near = Columns::new(XMap::new(10.0, -1e15, 25.0), 1_000, 100);
        assert!(near.bounds.iter().all(|b| *b == 0));
        assert_eq!(near.k_l, None);
        assert_eq!(near.k_r, Some(0));
        for s in 0..near.slots() - 1 {
            let (lo, hi) = near.slot_range(s);
            assert_eq!(lo, hi, "slot {s}");
        }
        assert_eq!(near.slot_range(near.slots() - 1), (0, 1));
    }
}
