//! unit:camera-primitives (plan #68 §5, A.10, T02-021, INT-001, INT-002, #93 A.13 F1): the
//! primitives on A.10's hand-computed vectors (`camera.json` is absent until #93 is at the base).
use dash_scene::Range64;
use dash_scene::camera::{SpanLimits, contain, pan_by, to_window, zoom_about};

const T: f64 = 1_795_089_600_000.0;
const DAY: f64 = 86_400_000.0;

fn r(lo: f64, hi: f64) -> Range64 {
    Range64 { lo, hi }
}

fn bits(x: Range64) -> (u64, u64) {
    (x.lo.to_bits(), x.hi.to_bits())
}

/// #93 `timeLimits` at plot.width 3 950.
fn time_limits() -> SpanLimits {
    SpanLimits {
        min_span: 1000f64.max(3950f64.ceil()),
        max_span: 3650.0 * DAY,
        lo: 0.0,
        hi: 253_402_300_799_999.0,
    }
}

#[test]
fn hand_computed_vectors() {
    let l = time_limits();
    assert_eq!(
        bits(zoom_about(r(0.0, 2000.0), 0.3, 0.8, &l)),
        bits(r(0.0, 2000.0))
    );
    let l2 = SpanLimits {
        min_span: 1000.0,
        max_span: 3650.0 * DAY,
        lo: 0.0,
        hi: 1e15,
    };
    assert_eq!(
        zoom_about(r(0.0, 10000.0), 0.25, 0.5, &l2),
        r(1250.0, 6250.0)
    );
    assert_eq!(
        pan_by(r(T, T + 2000.0), 37.0 / 3950.0, &l, Some(1.0)),
        r(T + 19.0, T + 2019.0)
    );
    let p = pan_by(r(T, T + 2000.0), 37.0 / 3950.0, &l, None);
    assert!(
        p.lo.fract() != 0.0 && (p.lo - T - 18.734).abs() < 1e-3,
        "{p:?}"
    );
    let l3 = SpanLimits {
        min_span: 1.0,
        max_span: 1e12,
        lo: 0.0,
        hi: 1000.0,
    };
    assert_eq!(contain(r(-5.0, 95.0), &l3), r(0.0, 100.0));
    assert_eq!(contain(r(990.0, 1090.0), &l3), r(900.0, 1000.0));
    let w = to_window(r(-2.5, 2.5));
    assert_eq!((w.from_ms, w.to_ms), (-2.0, 3.0));
    let w = to_window(r(5.0, 5.2));
    assert_eq!((w.from_ms, w.to_ms), (5.0, 6.0));
}

#[test]
fn zoom_keeps_the_anchor() {
    let l = time_limits();
    let mut s = r(T, T + 3_600_000.0);
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    for i in 0..100 {
        let f = next();
        let factor = 0.5 * 4f64.powf(next());
        let a = s.lo + f * (s.hi - s.lo);
        let s2 = zoom_about(s, f, factor, &l);
        let a2 = s2.lo + f * (s2.hi - s2.lo);
        let w = s.hi - s.lo;
        let floor = if factor < 1.0 {
            w.min(l.min_span)
        } else {
            l.min_span
        };
        let w2 = (w * factor).max(floor).min(l.max_span);
        // The span is w2 up to the rounding of the ends (ulp(T) ≈ 2.4e-4 ms).
        assert!(
            ((s2.hi - s2.lo) - w2).abs() <= 1e-3,
            "step {i}: span {} vs {w2}",
            s2.hi - s2.lo
        );
        let px = (a2 - a).abs() / (s2.hi - s2.lo) * 3950.0;
        assert!(px < 1.0, "step {i}: anchor moved {px} px ({s:?} → {s2:?})");
        assert!(s2.hi > s2.lo);
        s = s2;
    }
}

#[test]
fn f1_primitives() {
    let l = time_limits();
    let v = r(T, T + 2000.0);
    let v1 = pan_by(v, 37.0 / 3950.0, &l, Some(1.0));
    let v2 = pan_by(v1, 13.0 / 3950.0, &l, Some(1.0));
    for x in [v1.lo, v1.hi, v2.lo, v2.hi] {
        assert_eq!(x.fract(), 0.0, "{x}");
    }
    assert_eq!(v2.hi - v2.lo, 2000.0);
    let frac = pan_by(pan_by(v, 37.0 / 3950.0, &l, None), 13.0 / 3950.0, &l, None);
    assert!(
        frac.lo.fract() != 0.0,
        "precondition: an unquantised pan is fractional"
    );
    let z = zoom_about(zoom_about(v2, 0.3, 0.8, &l), 0.3, 0.8, &l);
    assert_eq!(bits(z), bits(v2));
    // At the floor with fractional ends, recomputing a − f·w would move the ends by an ulp.
    let fractional = r(0.1, 2000.3);
    for f in [0.37, 0.61, 0.13, 0.3, 0.7] {
        assert_eq!(
            bits(zoom_about(fractional, f, 0.8, &l)),
            bits(fractional),
            "f {f}"
        );
    }
    let wide = r(T - l.max_span, T);
    assert_eq!(bits(zoom_about(wide, 0.5, 1.25, &l)), bits(wide));
    let w = to_window(v2);
    assert_eq!((w.from_ms, w.to_ms), (v2.lo, v2.hi));
}
