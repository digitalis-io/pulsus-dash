//! Value encoding (plan #68 A.3, T02-014): values are uploaded as f32 `u = (v − v_ref)·2^−exp`,
//! with an origin and a power-of-two scale taken from the exact f64 span of an encoding chosen per
//! draw; the clip box |u| ≤ 2^24 and f64 segment clipping for data beyond it (A.3.3).

use crate::Range64;

/// Gap sentinel in the uploaded values (a quiet NaN bit pattern, only ever compared as an integer).
pub const GAP_BITS: u32 = 0x7FC0_0000;
/// 2^24: the clip box half-height in u (A.3.3).
pub const U_CLAMP: f64 = 16_777_216.0;

/// `x·2^n`, in steps of at most 2^±1000 so no intermediate power overflows; exact unless the
/// result overflows (±inf) or falls below the normal range (IEEE rounding).
pub fn ldexp(mut x: f64, mut n: i32) -> f64 {
    while n != 0 && x != 0.0 && x.is_finite() {
        let step = n.clamp(-1000, 1000);
        x *= f64::from_bits(((1023 + step) as u64) << 52);
        n -= step;
    }
    x
}

/// The `e` with `x = f·2^e`, `f ∈ [0.5, 1)`, for any `x > 0`, subnormals included.
pub fn fexp(x: f64) -> i32 {
    let bits = x.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i32;
    if e > 0 {
        e - 1022
    } else {
        let mantissa = bits & ((1 << 52) - 1);
        -1074 + (64 - mantissa.leading_zeros() as i32)
    }
}

/// The exact span of `lo < hi` as `(m, k)`, true span = m·2^k: `(hi − lo, 0)` when that is finite,
/// else `(hi/2 − lo/2, 1)`. `hi − lo` is exact below 2^−1021, so every subnormal span is exact.
pub fn span_of(r: Range64) -> (f64, i32) {
    let d = r.hi - r.lo;
    if d.is_finite() {
        (d, 0)
    } else {
        (r.hi / 2.0 - r.lo / 2.0, 1)
    }
}

/// A per-draw value encoding.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Encoding {
    pub v_ref: f64,
    pub exp: i32,
}

/// Value-space box of |u| ≤ U_CLAMP; a bound that overflows is ±inf.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClipBox {
    pub lo: f64,
    pub hi: f64,
}

impl Encoding {
    /// None unless `lo < hi` are finite (constant data has no data encoding). `v_ref` is
    /// `lo + (hi − lo)/2` when the difference is finite, else `lo/2 + hi/2` (both in [lo, hi]);
    /// `exp = fexp(m) + k`, so the true span·2^−exp ∈ [0.5, 1).
    pub fn of(r: Range64) -> Option<Self> {
        if !(r.lo.is_finite() && r.hi.is_finite() && r.lo < r.hi) {
            return None;
        }
        let (m, k) = span_of(r);
        let v_ref = if k == 0 {
            r.lo + m / 2.0
        } else {
            r.lo / 2.0 + r.hi / 2.0
        };
        Some(Self {
            v_ref,
            exp: fexp(m) + k,
        })
    }

    /// d = v − v_ref; d finite → ldexp(d, −exp), else ldexp(v/2 − v_ref/2, 1 − exp). May be ±inf.
    pub fn u_exact(&self, v: f64) -> f64 {
        let d = v - self.v_ref;
        if d.is_finite() {
            ldexp(d, -self.exp)
        } else {
            ldexp(v / 2.0 - self.v_ref / 2.0, 1 - self.exp)
        }
    }

    /// The upload: non-finite → GAP_BITS, else (clamp(u_exact(v), ±U_CLAMP) as f32).to_bits().
    pub fn encode(&self, v: f64) -> u32 {
        if !v.is_finite() {
            return GAP_BITS;
        }
        (self.u_exact(v).clamp(-U_CLAMP, U_CLAMP) as f32).to_bits()
    }

    /// A.3.1: the encoding draws `axis` on a plot `plot_h_dev` device px tall without overflow and
    /// with sub-pixel precision (y error ≤ 2^−8 device px for plots ≤ 2^14 device px). Both axis
    /// ends must also lie inside the clip box (|u| ≤ U_CLAMP), so the box contains the plot as
    /// A.3.3 requires; without it an axis far wider than the data (data spanning 1e−8 of an auto
    /// axis that includes 0) would clamp on-plot values.
    pub fn adequate(&self, axis: Range64, plot_h_dev: f64) -> bool {
        let (m, k) = span_of(axis);
        let span_u = ldexp(m, k - self.exp);
        let (lo_u, hi_u) = (self.u_exact(axis.lo), self.u_exact(axis.hi));
        if !(span_u.is_finite() && lo_u.is_finite() && hi_u.is_finite()) {
            return false;
        }
        let two15 = 32_768.0;
        let reach = lo_u.abs().max(hi_u.abs());
        span_u >= plot_h_dev / two15 && reach * plot_h_dev <= two15 * span_u && reach <= U_CLAMP
    }

    /// v_ref ∓ ldexp(U_CLAMP, exp).
    pub fn clip_box(&self) -> ClipBox {
        let h = ldexp(U_CLAMP, self.exp);
        ClipBox {
            lo: self.v_ref - h,
            hi: self.v_ref + h,
        }
    }
}

/// The data encoding when Some and adequate, else `Encoding::of(axis)`; None only for an invalid
/// axis. A pure function of (data range, axis, plot height), so T02-030 holds.
pub fn choose_encoding(data: Option<Range64>, axis: Range64, plot_h_dev: f64) -> Option<Encoding> {
    let axis_enc = Encoding::of(axis)?;
    match data.and_then(Encoding::of) {
        Some(e) if e.adequate(axis, plot_h_dev) => Some(e),
        _ => Some(axis_enc),
    }
}

/// Some finite data value lies outside `enc.clip_box()` (A.3.3).
pub fn is_far(enc: &Encoding, data: Option<(f64, f64)>) -> bool {
    let b = enc.clip_box();
    data.is_some_and(|(lo, hi)| lo < b.lo || hi > b.hi)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Low,
    High,
}

/// The f64 clip of one segment against a clip box: `t` of each cut end.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SegClip {
    Inside,
    Clipped {
        a: Option<(f64, Side)>,
        b: Option<(f64, Side)>,
    },
    Outside(Side),
}

/// Cut parameter of bound `c` on the segment from `va` to `vb`; halved when the difference
/// overflows (then both magnitudes are ≥ 2^1022, so halving is exact).
fn cut(c: f64, va: f64, vb: f64) -> f64 {
    let d = vb - va;
    if d.is_finite() {
        (c - va) / d
    } else {
        (c / 2.0 - va / 2.0) / (vb / 2.0 - va / 2.0)
    }
}

/// 1-D Liang–Barsky on value: `a` is cut at the entry bound, `b` at the exit bound.
pub fn clip_segment(va: f64, vb: f64, b: &ClipBox) -> SegClip {
    let side = |v: f64| {
        if v < b.lo {
            Some((b.lo, Side::Low))
        } else if v > b.hi {
            Some((b.hi, Side::High))
        } else {
            None
        }
    };
    match (side(va), side(vb)) {
        (None, None) => SegClip::Inside,
        (Some((_, sa)), Some((_, sb))) if sa == sb => SegClip::Outside(sa),
        (ca, cb) => SegClip::Clipped {
            a: ca.map(|(c, s)| (cut(c, va, vb), s)),
            b: cb.map(|(c, s)| (cut(c, va, vb), s)),
        },
    }
}

/// y_css(u) = plot.y + plot.height − (u − ou)·ku.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxisMap {
    pub ku: f64,
    pub ou: f64,
}

/// `ou = u_exact(axis.lo)`, `ku = plot_height_css / span_u` with `span_u = ldexp(m, k − exp)`;
/// finite and f32-safe when the encoding is adequate. `plot.y` is added by the shader.
pub fn axis_map(enc: &Encoding, axis: Range64, plot_height_css: f64) -> AxisMap {
    let (m, k) = span_of(axis);
    let span_u = ldexp(m, k - enc.exp);
    AxisMap {
        ku: plot_height_css / span_u,
        ou: enc.u_exact(axis.lo),
    }
}
