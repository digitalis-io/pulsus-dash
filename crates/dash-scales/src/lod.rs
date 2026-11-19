//! Positions, columns and decimation (T02-014, T02-015; plan #24 §3.3, §4.3).

/// The bits of a NULL sample (a quiet NaN `to_bits` never produces for a value).
pub const NULL_BITS: u32 = 0x7FC0_0000;
/// Pyramid branching factor.
pub const PYRAMID_B: u32 = 16;
/// Off-plot columns on each side.
pub const MARGIN: u32 = 4;
/// In `a[2]` of a record: the slot has more than three runs.
pub const OVERFLOW_BITS: u32 = 0x7FC0_0001;

/// `f32(v − v_ref)` bits; [`NULL_BITS`] if invalid or non-finite; `+0.0` for ±0.0.
pub fn to_bits(_v: f64, _valid: bool, _v_ref: f64) -> u32 {
    0
}

/// [`to_bits`] of every sample into `out`.
pub fn rel_bits(_values: &[f64], _is_valid: &dyn Fn(usize) -> bool, _v_ref: f64, _out: &mut [u32]) {
}

/// The min/max pyramid: `levels[ℓ−1][e] = [min, max, flags, 0]`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pyramid {
    pub levels: Vec<Vec<[u32; 4]>>,
}

/// `#{ℓ ≥ 1 : 16^ℓ < n}`.
pub fn levels_for(_n: u32) -> u32 {
    0
}

pub fn build_pyramid(_bits: &[u32], _out: &mut Pyramid) {}

/// The reference value and range of a series' finite valid samples.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Prepared {
    pub v_ref: f64,
    pub min: f64,
    pub max: f64,
}

pub fn prepare(_values: &[f64], _is_valid: &dyn Fn(usize) -> bool) -> Prepared {
    Prepared {
        v_ref: 0.0,
        min: 0.0,
        max: 0.0,
    }
}

/// `x(k) = (f32(k − k0) + c0) · s`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct XMap {
    pub k0: i32,
    pub c0: f32,
    pub s: f32,
}

impl XMap {
    pub fn new(_step_ms: f64, _t_left_rel_ms: f64, _ms_per_px: f64) -> XMap {
        XMap {
            k0: 0,
            c0: 0.0,
            s: 0.0,
        }
    }

    pub fn x(&self, _k: u32) -> f32 {
        0.0
    }

    pub fn col(&self, _k: u32) -> i32 {
        0
    }
}

/// The plot's device-pixel columns and their sample ranges.
#[derive(Clone, Debug, PartialEq)]
pub struct Columns {
    pub xmap: XMap,
    pub n: u32,
    pub plot_w: u32,
    pub bounds: Vec<u32>,
    pub k_l: Option<u32>,
    pub k_r: Option<u32>,
}

impl Columns {
    pub fn new(xmap: XMap, n: u32, plot_w: u32) -> Columns {
        Columns {
            xmap,
            n,
            plot_w,
            bounds: Vec::new(),
            k_l: None,
            k_r: None,
        }
    }

    /// `plot_w + 2·MARGIN + 2`.
    pub fn slots(&self) -> u32 {
        0
    }

    /// The sample range `[lo, hi)` of slot `s` (`lo == hi` when empty).
    pub fn slot_range(&self, _s: u32) -> (u32, u32) {
        (0, 0)
    }
}

/// One slot's record (32 bytes).
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

/// The record of the sample range `[lo, hi)`; `next` = whether `b[3]` holds `bits[hi]`.
pub fn slot_record(_bits: &[u32], _p: &Pyramid, _lo: u32, _hi: u32, _next: bool) -> SlotRecord {
    EMPTY
}

/// Every slot's record (the specification of the GPU pass).
pub fn decimate_series(_bits: &[u32], _p: &Pyramid, _c: &Columns) -> Vec<SlotRecord> {
    Vec::new()
}

/// Reference passes: per slot the q-th raw item and its sample k (`u32::MAX` if none).
pub fn reference_passes(_bits: &[u32], _c: &Columns) -> Vec<(Vec<SlotRecord>, Vec<u32>)> {
    Vec::new()
}

/// `y(b) = (f32::from_bits(b) + d) · a`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct YMap {
    pub d: f32,
    pub a: f32,
}

impl YMap {
    pub fn y(&self, _b: u32) -> f32 {
        0.0
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
