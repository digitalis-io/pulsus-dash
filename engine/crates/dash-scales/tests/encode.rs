//! unit:value-encoding (plan #68 §5, A.3, T02-014, PRF-016).
use dash_scales::Range64;
use dash_scales::encode::{Encoding, U_CLAMP, axis_map, choose_encoding};

const MAX: f64 = f64::MAX;
const MP: f64 = f64::MIN_POSITIVE;

fn r(lo: f64, hi: f64) -> Range64 {
    Range64 { lo, hi }
}

/// The shader's y in f32: plot.y + plot.height − (u − ou)·ku.
fn y32(u: f32, ku: f32, ou: f32, plot_y: f32, h: f32) -> f32 {
    plot_y + h - (u - ou) * ku
}

/// The independent f64 reference: plot.y + h·(1 − q).
fn y_ref(v: f64, a: Range64, plot_y: f64, h: f64) -> f64 {
    let q = if (a.hi - a.lo).is_finite() {
        (v - a.lo) / (a.hi - a.lo)
    } else {
        (v / 2.0 - a.lo / 2.0) / (a.hi / 2.0 - a.lo / 2.0)
    };
    plot_y + h * (1.0 - q)
}

fn lerp(a: Range64, q: f64) -> f64 {
    if (a.hi - a.lo).is_finite() { a.lo + q * (a.hi - a.lo) } else { a.lo * (1.0 - q) + a.hi * q }
}

fn seeded(i: u64) -> f64 {
    let x = i.wrapping_mul(0x9E37_79B9_7F4A_7C15).rotate_left(29) ^ 0xD1B5_4A32_D192_ED03;
    (x >> 11) as f64 / (1u64 << 53) as f64
}

#[test]
fn subnormal_axis_is_exact() {
    let tiny = f64::from_bits(1);
    let axis = r(0.0, tiny);
    let enc = Encoding::of(axis);
    assert_eq!(enc, Some(Encoding { v_ref: 0.0, exp: -1073 }));
    let Some(enc) = enc else { return };
    assert_eq!(enc.u_exact(tiny), 0.5);
    let m = axis_map(&enc, axis, 240.0);
    let (ku, ou) = (m.ku as f32, m.ou as f32);
    assert_eq!(y32(f32::from_bits(enc.encode(tiny)), ku, ou, 8.0, 240.0), 8.0);
    assert_eq!(y32(f32::from_bits(enc.encode(0.0)), ku, ou, 8.0, 240.0), 248.0);
}

#[test]
fn subnormal_data_is_exact() {
    let (lo, hi) = (f64::from_bits(3), f64::from_bits(1000));
    let enc = Encoding::of(r(lo, hi));
    assert_eq!(enc.map(|e| e.exp), Some(-1064));
    let Some(enc) = enc else { return };
    for bits in [3u64, 4, 500, 999, 1000] {
        let v = f64::from_bits(bits);
        let u = enc.u_exact(v);
        let back = u * 2f64.powi(-1064) + enc.v_ref;
        assert_eq!(back, v, "bits {bits}");
    }
}

#[test]
fn constant_data_has_no_data_encoding() {
    assert_eq!(Encoding::of(r(5.0, 5.0)), None);
    let axis = r(0.0, 10.0);
    let chosen = choose_encoding(Encoding::of(r(5.0, 5.0)).map(|_| r(5.0, 5.0)), axis, 240.0);
    assert!(chosen.is_some(), "constant data must use the axis encoding");
    assert_eq!(chosen, Encoding::of(axis));
}

#[test]
fn every_case_is_finite_and_precise() {
    let data = [
        r(MAX / 2.0, MAX),
        r(-MAX, -MAX / 2.0),
        r(-MAX, MAX),
        r(1e300, 1e300 + 1e290),
        r(5.0, 5.0),
        r(MP, 4.0 * MP),
        r(-1e-300, 1e-300),
    ];
    let mut checked = 0;
    for (di, d) in data.iter().enumerate() {
        let span = |a: Range64| if (a.hi - a.lo).is_finite() { a.hi - a.lo } else { f64::INFINITY };
        let auto = r(d.lo.min(0.0), if d.hi > d.lo.min(0.0) { d.hi } else { d.hi + 1.0 });
        let inside = if d.lo < d.hi { r(lerp(*d, 0.25), lerp(*d, 0.75)) } else { r(d.lo - 0.5, d.lo + 0.5) };
        let mid = lerp(*d, 0.5);
        let w = if d.lo < d.hi { (d.hi / 2.0 - d.lo / 2.0) * 2e-12 } else { 1e-12 };
        let narrow = r(mid, mid + w.max(mid.abs() * 1e-15));
        let s = span(*d).max(1.0);
        let far = if (d.hi + 2e6 * s).is_finite() {
            r(d.hi + 1e6 * s, d.hi + 2e6 * s)
        } else if (d.lo - 2e6 * s).is_finite() {
            r(d.lo - 2e6 * s, d.lo - 1e6 * s)
        } else {
            r(1.0, 2.0)
        };
        for (ai, axis) in [auto, inside, narrow, far].into_iter().enumerate() {
            assert!(axis.lo < axis.hi, "case {di}/{ai}: axis {axis:?}");
            for h in [240.0, 8192.0] {
                let data_range = if d.lo < d.hi { Some(*d) } else { Some(*d) };
                let Some(enc) = choose_encoding(data_range, axis, h) else {
                    panic!("case {di}/{ai}/{h}: no encoding for {axis:?}");
                };
                for v in [d.lo, d.hi, lerp(*d, 0.5)] {
                    let u = f32::from_bits(enc.encode(v));
                    assert!(u.is_finite() && f64::from(u).abs() <= U_CLAMP, "case {di}/{ai}: u {u}");
                }
                let m = axis_map(&enc, axis, h);
                let (ku, ou) = (m.ku as f32, m.ou as f32);
                assert!(ku.is_finite() && ou.is_finite(), "case {di}/{ai}/{h}: {m:?}");
                for i in 0..1000 {
                    let v = lerp(axis, seeded(i + 7919 * ai as u64));
                    let u = f32::from_bits(enc.encode(v));
                    let got = f64::from(y32(u, ku, ou, 0.0, h as f32));
                    let want = y_ref(v, axis, 0.0, h);
                    assert!(
                        (got - want).abs() <= 2f64.powi(-8),
                        "case {di}/{ai}/{h}: v {v:e}: y {got} vs {want}"
                    );
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 7 * 4 * 2 * 1000);
}
