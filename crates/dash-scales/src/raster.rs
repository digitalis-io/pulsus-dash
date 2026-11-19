//! Line coverage (VIZ-006, plan #24 §4.4): the pixels whose square the raw polyline touches, at
//! 1/64 device px, computed exactly with integers and independently of the decimated records.
//!
//! Pixel `(c, r)` (r from the plot bottom) is the closed box `[64c, 64c+64] × [64r, 64r+64]`,
//! with `c` restricted to the columns `⌊x_min/64⌋ ..= ⌊x_max/64⌋` of the piece, so a point on a
//! column edge belongs to one column only.

use crate::Plot;
use crate::lod::{Columns, NULL_BITS, OVERFLOW_BITS, SlotRecord, XMap, YMap};

/// Sub-pixel units per device pixel.
pub const SUB: i64 = 64;
/// `yq` saturates here (beyond every on-screen value, §4.9).
const Q_MAX: f32 = (1u32 << 30) as f32;

/// `⌊x · 64⌋` (exact: a power-of-two scale).
pub fn xq(x: f32) -> i64 {
    (x * SUB as f32).floor() as i64
}

/// `⌊clamp(y · 64, ±2³⁰)⌋`.
pub fn yq(y: f32) -> i64 {
    (y * SUB as f32).clamp(-Q_MAX, Q_MAX).floor() as i64
}

/// A binary mask of plot pixels, row-major from the plot bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mask {
    pub w: u32,
    pub h: u32,
    pub bits: Vec<u64>,
}

impl Mask {
    pub fn new(w: u32, h: u32) -> Mask {
        Mask {
            w,
            h,
            bits: vec![0; (w as usize * h as usize).div_ceil(64)],
        }
    }

    fn index(&self, c: u32, r: u32) -> Option<usize> {
        (c < self.w && r < self.h).then(|| r as usize * self.w as usize + c as usize)
    }

    pub fn get(&self, c: u32, r: u32) -> bool {
        self.index(c, r)
            .is_some_and(|i| self.bits[i / 64] >> (i % 64) & 1 == 1)
    }

    pub fn set(&mut self, c: u32, r: u32) {
        if let Some(i) = self.index(c, r) {
            self.bits[i / 64] |= 1 << (i % 64);
        }
    }

    pub fn clear(&mut self, c: u32, r: u32) {
        if let Some(i) = self.index(c, r) {
            self.bits[i / 64] &= !(1 << (i % 64));
        }
    }

    /// Lit pixels.
    pub fn count(&self) -> u64 {
        self.bits.iter().map(|w| u64::from(w.count_ones())).sum()
    }

    /// From an `R8Unorm` readback of the canvas (rows top-down, `canvas_w` bytes each, tightly
    /// packed): pixel `(c, r)` is lit iff its byte is > 0.
    pub fn from_r8(bytes: &[u8], canvas_w: u32, plot: &Plot) -> Mask {
        let mut m = Mask::new(plot.w, plot.h);
        let cw = canvas_w as usize;
        if cw == 0 {
            return m;
        }
        let ch = bytes.len() / cw;
        let (x0, y0) = (plot.x0 as usize, plot.y0 as usize);
        for r in 0..plot.h as usize {
            let Some(y) = ch.checked_sub(1 + y0 + r) else {
                continue;
            };
            for c in 0..plot.w as usize {
                if bytes.get(y * cw + x0 + c).is_some_and(|b| *b > 0) {
                    m.set(c as u32, r as u32);
                }
            }
        }
        m
    }

    /// `self |= o` (same size).
    pub fn union(&mut self, o: &Mask) {
        for (a, b) in self.bits.iter_mut().zip(&o.bits) {
            *a |= *b;
        }
    }
}

/// Whether segment `a`–`b` (1/64 px; `a == b` is a point) touches pixel `(c, r)`: column
/// restriction, closed y overlap, then the separating axis of the segment's line, with exact
/// `i128` cross products.
pub fn seg_covers(a: (i64, i64), b: (i64, i64), c: i64, r: i64) -> bool {
    let (x0, x1) = (a.0.min(b.0), a.0.max(b.0));
    if c < x0.div_euclid(SUB) || c > x1.div_euclid(SUB) {
        return false;
    }
    let (by0, by1) = (SUB * r, SUB * r + SUB);
    let (y0, y1) = (a.1.min(b.1), a.1.max(b.1));
    if y1 < by0 || y0 > by1 {
        return false;
    }
    if a == b {
        return true;
    }
    let (dx, dy) = (i128::from(b.0 - a.0), i128::from(b.1 - a.1));
    let side = |px: i64, py: i64| dx * i128::from(py - a.1) - dy * i128::from(px - a.0);
    let (bx0, bx1) = (SUB * c, SUB * c + SUB);
    let s = [
        side(bx0, by0),
        side(bx1, by0),
        side(bx0, by1),
        side(bx1, by1),
    ];
    !(s.iter().all(|v| *v > 0) || s.iter().all(|v| *v < 0))
}

/// Sets the rows of column `c` that the closed interval `[y0, y1]` (1/64 px) touches.
fn set_interval(m: &mut Mask, c: i64, y0: i64, y1: i64) {
    if c < 0 || c >= i64::from(m.w) {
        return;
    }
    let r0 = (y0 - SUB).div_euclid(SUB) + i64::from((y0 - SUB).rem_euclid(SUB) != 0);
    let r1 = y1.div_euclid(SUB);
    for r in r0.max(0)..=r1.min(i64::from(m.h) - 1) {
        m.set(c as u32, r as u32);
    }
}

/// Rasterises segment `a`–`b` (or a point) into `m` by [`seg_covers`].
fn draw_seg(m: &mut Mask, a: (i64, i64), b: (i64, i64)) {
    let (x0, x1) = (a.0.min(b.0), a.0.max(b.0));
    let (c0, c1) = (x0.div_euclid(SUB), x1.div_euclid(SUB));
    if c1 < 0 || c0 >= i64::from(m.w) {
        return;
    }
    if c0 == c1 {
        // Inside one column the segment touches exactly the rows its y-range touches.
        set_interval(m, c0, a.1.min(b.1), a.1.max(b.1));
        return;
    }
    let h = i64::from(m.h);
    let (ax, ay, bx, by) = (a.0 as f64, a.1 as f64, b.0 as f64, b.1 as f64);
    let at = |x: f64| ay + (by - ay) * (x - ax) / (bx - ax);
    for c in c0.max(0)..=c1.min(i64::from(m.w) - 1) {
        let xa = ((SUB * c) as f64).max(x0 as f64);
        let xb = ((SUB * c + SUB) as f64).min(x1 as f64);
        let (ya, yb) = (at(xa), at(xb));
        // Conservative candidates; `seg_covers` decides exactly.
        let lo = ((ya.min(yb) - 2.0) / SUB as f64).floor() as i64 - 1;
        let hi = ((ya.max(yb) + 2.0) / SUB as f64).floor() as i64 + 1;
        for r in lo.max(0)..=hi.min(h - 1) {
            if seg_covers(a, b, c, r) {
                m.set(c as u32, r as u32);
            }
        }
    }
}

/// The smallest `k ∈ [0, n]` with `x(k) ≥ x` (`x` monotone in `k`).
fn first_x_at_least(xm: &XMap, n: u32, x: f32) -> u32 {
    let (mut lo, mut hi) = (0u32, n);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if xm.x(mid) >= x {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

/// Line coverage of the raw samples: every segment between consecutive valid samples and every
/// isolated valid sample, at `(xq(x(k)), yq(y(v_k)))`. Uses no records.
pub fn raw_mask(bits: &[u32], xm: &XMap, ym: &YMap, n: u32, plot_w: u32, plot_h: u32) -> Mask {
    let mut m = Mask::new(plot_w, plot_h);
    let n = n.min(bits.len() as u32);
    if n == 0 {
        return m;
    }
    // Skip segments wholly off the plot ± 2 px.
    let k0 = first_x_at_least(xm, n, -2.0).saturating_sub(1);
    let k1 = first_x_at_least(xm, n, plot_w as f32 + 2.0).min(n - 1);
    let valid = |k: u32| k < n && bits[k as usize] != NULL_BITS;
    let at = |k: u32| (xq(xm.x(k)), yq(ym.y(bits[k as usize])));
    for k in k0..=k1 {
        if !valid(k) {
            continue;
        }
        if valid(k + 1) {
            draw_seg(&mut m, at(k), at(k + 1));
        } else if k == 0 || !valid(k - 1) {
            let p = at(k);
            draw_seg(&mut m, p, p);
        }
    }
    m
}

/// Coverage implied by the records: each run interval `[yq(min), yq(max)]` in its column (closed
/// in y), overflow runs recomputed from `bits`, each connector by [`seg_covers`].
pub fn record_mask(recs: &[SlotRecord], c: &Columns, bits: &[u32], ym: &YMap, plot_h: u32) -> Mask {
    let mut m = Mask::new(c.plot_w, plot_h);
    let xm = &c.xmap;
    let y = |b: u32| yq(ym.y(b));
    for (s, r) in recs.iter().enumerate() {
        let (lo, hi) = c.slot_range(s as u32);
        if lo >= hi {
            continue;
        }
        let k_last = hi - 1;
        let col = i64::from(xm.col(k_last));
        if r.a[2] == OVERFLOW_BITS {
            let mut run: Option<(i64, i64)> = None;
            for k in lo..=hi {
                let b = bits.get(k as usize).copied().filter(|_| k < hi);
                match b.filter(|b| *b != NULL_BITS) {
                    Some(b) => {
                        let v = y(b);
                        run = Some(run.map_or((v, v), |(a, z)| (a.min(v), z.max(v))));
                    }
                    None => {
                        if let Some((a, z)) = run.take() {
                            set_interval(&mut m, col, a, z);
                        }
                    }
                }
            }
        } else {
            for (mn, mx) in [(r.a[0], r.a[1]), (r.a[2], r.a[3]), (r.b[0], r.b[1])] {
                if mn != NULL_BITS {
                    set_interval(&mut m, col, y(mn), y(mx));
                }
            }
        }
        if r.b[2] != NULL_BITS && r.b[3] != NULL_BITS {
            let a = (xq(xm.x(k_last)), y(r.b[2]));
            let b = (xq(xm.x(k_last + 1)), y(r.b[3]));
            draw_seg(&mut m, a, b);
        }
    }
    m
}

/// `(missing, extra)` pixel counts of `got` against `want`.
pub fn mask_diff(got: &Mask, want: &Mask) -> (u64, u64) {
    let mut missing = 0;
    let mut extra = 0;
    for (g, w) in got.bits.iter().zip(&want.bits) {
        missing += u64::from((w & !g).count_ones());
        extra += u64::from((g & !w).count_ones());
    }
    if got.bits.len() != want.bits.len() || (got.w, got.h) != (want.w, want.h) {
        let rest = |m: &Mask, from: usize| {
            m.bits
                .iter()
                .skip(from)
                .map(|w| u64::from(w.count_ones()))
                .sum::<u64>()
        };
        let common = got.bits.len().min(want.bits.len());
        missing += rest(want, common);
        extra += rest(got, common);
    }
    (missing, extra)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lod::{NULL_BITS, Pyramid, build_pyramid, decimate_series};

    #[test]
    fn seg_covers_cases() {
        assert!(seg_covers((0, 0), (640, 64), 3, 0));
        assert!(!seg_covers((0, 0), (640, 64), 3, 1));
        assert!(seg_covers((64, 64), (64, 64), 1, 0));
        assert!(seg_covers((64, 64), (64, 64), 1, 1));
        assert!(!seg_covers((64, 64), (64, 64), 0, 0));
        let a = (0, -(1i64 << 30));
        let b = (1i64 << 19, 1i64 << 30);
        // The middle of the segment: x = 2¹⁸ (column 4 096), y = 0 (row 0).
        assert!(seg_covers(a, b, 4_096, 0));
        assert!(!seg_covers(a, b, 4_096, 5_000));
        assert!(!seg_covers(a, b, 1 << 14, 0));
    }

    #[test]
    fn isolated_subpixel_mask() {
        let n = 10u32;
        let mut bits = vec![NULL_BITS; n as usize];
        bits[4] = 0;
        let ym = YMap { d: 5.0, a: 1.0 };
        let mut p = Pyramid::default();
        build_pyramid(&bits, &mut p);
        for (c0, col) in [(0.0f32, 3u32), (-0.2, 3), (-0.5, 2)] {
            let xm = XMap { k0: 0, c0, s: 0.8 };
            let raw = raw_mask(&bits, &xm, &ym, n, 8, 8);
            let mut want = Mask::new(8, 8);
            want.set(col, 4);
            want.set(col, 5);
            assert_eq!(raw.count(), 2, "c0 {c0}");
            assert_eq!(raw, want, "c0 {c0}");
            let c = Columns::new(xm, n, 8);
            let recs = decimate_series(&bits, &p, &c);
            assert_eq!(record_mask(&recs, &c, &bits, &ym, 8), raw, "c0 {c0}");
        }
    }

    #[test]
    fn mask_ops() {
        let mut a = Mask::new(70, 3);
        a.set(69, 2);
        a.set(0, 0);
        let mut b = Mask::new(70, 3);
        b.set(0, 0);
        b.set(5, 1);
        assert_eq!(mask_diff(&a, &b), (1, 1));
        a.union(&b);
        assert_eq!(a.count(), 3);
        assert!(a.get(5, 1));
        // A 4 × 3 canvas, plot {x0 1, y0 1, w 2, h 1}: plot row 0 is canvas row 1 from the top.
        let plot = Plot {
            x0: 1.0,
            y0: 1.0,
            w: 2,
            h: 1,
        };
        let bytes = [0, 0, 0, 0, 0, 0, 255, 0, 9, 9, 9, 9];
        let m = Mask::from_r8(&bytes, 4, &plot);
        assert!(!m.get(0, 0));
        assert!(m.get(1, 0));
        assert_eq!(m.count(), 1);
    }
}
