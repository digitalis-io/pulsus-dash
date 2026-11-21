//! unit:segment-clip (plan #68 §5, A.3.3, T02-014, ADR-0014 §4, PRF-016).
use dash_scales::Range64;
use dash_scales::encode::{Encoding, SegClip, Side, choose_encoding, clip_segment, is_far};

const MAX: f64 = f64::MAX;

fn axis_enc() -> Encoding {
    match Encoding::of(Range64 { lo: 0.0, hi: 1.0 }) {
        Some(e) => e,
        None => Encoding { v_ref: f64::NAN, exp: 0 },
    }
}

#[test]
fn far_segment_crosses_at_one_third() {
    let enc = axis_enc();
    assert_eq!(enc, Encoding { v_ref: 0.5, exp: 1 });
    let b = enc.clip_box();
    let SegClip::Clipped { a: Some((ta, Side::Low)), b: Some((tb, Side::High)) } =
        clip_segment(-1e300, 2e300, &b)
    else {
        panic!("{:?}", clip_segment(-1e300, 2e300, &b));
    };
    assert!((ta - 1.0 / 3.0).abs() <= 1e-16 && (tb - 1.0 / 3.0).abs() <= 1e-16, "{ta} {tb}");
    assert!((f64::from(ta as f32) - 1.0 / 3.0).abs() <= 2f64.powi(-24));
    // The line through the two cut ends (t_a, b.lo) and (t_b, b.hi), crossing v = 0 and v = 1.
    let cross = |v: f64| ta + (v - b.lo) / (b.hi - b.lo) * (tb - ta);
    assert!((cross(0.0) - 1.0 / 3.0).abs() <= 1e-15, "{}", cross(0.0));
    assert!((cross(1.0) - 1.0 / 3.0).abs() <= 1e-15, "{}", cross(1.0));
}

#[test]
fn reversed_segment_and_single_cuts() {
    let b = axis_enc().clip_box();
    assert!(matches!(
        clip_segment(2e300, -1e300, &b),
        SegClip::Clipped { a: Some((_, Side::High)), b: Some((_, Side::Low)) }
    ));
    assert!(matches!(clip_segment(0.5, 2e300, &b), SegClip::Clipped { a: None, b: Some((_, Side::High)) }));
    let SegClip::Clipped { a: Some((ta, Side::Low)), b: Some((tb, Side::High)) } = clip_segment(-MAX, MAX, &b) else {
        panic!("{:?}", clip_segment(-MAX, MAX, &b));
    };
    assert!(ta.is_finite() && tb.is_finite() && (ta - 0.5).abs() < 1e-9, "{ta} {tb}");
    assert_eq!(clip_segment(3e300, 4e300, &b), SegClip::Outside(Side::High));
    assert_eq!(clip_segment(0.2, 0.7, &b), SegClip::Inside);
}

#[test]
fn far_only_beyond_the_clip_box() {
    let enc = axis_enc();
    assert!(is_far(&enc, Some((-1e300, 2e300))));
    let cases = [
        (MAX / 2.0, MAX),
        (-MAX, -MAX / 2.0),
        (-MAX, MAX),
        (1e300, 1e300 + 1e290),
        (f64::MIN_POSITIVE, 4.0 * f64::MIN_POSITIVE),
        (-1e-300, 1e-300),
    ];
    for (lo, hi) in cases {
        let axis = Range64 { lo: lo.min(0.0), hi };
        let Some(e) = choose_encoding(Some(Range64 { lo, hi }), axis, 240.0) else {
            panic!("no encoding for {lo:e}..{hi:e}");
        };
        assert!(!is_far(&e, Some((lo, hi))), "{lo:e}..{hi:e}: {e:?}");
    }
}
