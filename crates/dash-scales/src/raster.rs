//! Line coverage (VIZ-006, plan #24 §4.4): the pixels whose square the raw polyline touches, at
//! 1/64 device px, computed exactly with integers and independently of the decimated records.

use crate::Plot;
use crate::lod::{Columns, SlotRecord, XMap, YMap};

/// Sub-pixel units per device pixel.
pub const SUB: i64 = 64;

pub fn xq(_x: f32) -> i64 {
    0
}

pub fn yq(_y: f32) -> i64 {
    0
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
            bits: Vec::new(),
        }
    }

    pub fn get(&self, _c: u32, _r: u32) -> bool {
        false
    }

    pub fn set(&mut self, _c: u32, _r: u32) {}

    pub fn clear(&mut self, _c: u32, _r: u32) {}

    pub fn count(&self) -> u64 {
        0
    }

    /// From an `R8Unorm` readback of the canvas (rows top-down, `canvas_w` bytes each).
    pub fn from_r8(_bytes: &[u8], _canvas_w: u32, plot: &Plot) -> Mask {
        Mask::new(plot.w, plot.h)
    }

    pub fn union(&mut self, _o: &Mask) {}
}

pub fn seg_covers(_a: (i64, i64), _b: (i64, i64), _c: i64, _r: i64) -> bool {
    false
}

pub fn raw_mask(_bits: &[u32], _xm: &XMap, _ym: &YMap, _n: u32, plot_w: u32, plot_h: u32) -> Mask {
    Mask::new(plot_w, plot_h)
}

pub fn record_mask(
    _recs: &[SlotRecord],
    c: &Columns,
    _bits: &[u32],
    _ym: &YMap,
    plot_h: u32,
) -> Mask {
    Mask::new(c.plot_w, plot_h)
}

/// `(missing, extra)` pixel counts of `got` against `want`.
pub fn mask_diff(_got: &Mask, _want: &Mask) -> (u64, u64) {
    (0, 0)
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
        assert!(!seg_covers(a, b, 4_096, 100));
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
