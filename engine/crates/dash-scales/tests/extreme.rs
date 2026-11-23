//! unit:extreme-ticks (#97 plan §5 C): the fallback ticks are height-aware (three ticks when both
//! mapped gaps hold a label, two when the plot holds one gap, else the end nearer zero), the nice
//! search thins a two-tick result on short plots, and a nice result whose drawn gaps collide is
//! refused.
use dash_scales::{ValueTicks, extreme_ticks, tick_y, ticks_fit, value_fraction, value_ticks};

const L: f64 = 14.0;
const M: f64 = f64::MAX;

fn vt(min: f64, max: f64, ticks: &[f64]) -> ValueTicks {
    ValueTicks {
        min,
        max,
        ticks: ticks.to_vec(),
    }
}

#[test]
fn extreme_ticks_fit() {
    // B1: equal ends widen toward zero.
    assert_eq!(
        extreme_ticks(4.0, 4.0, 200.0, L),
        vt(2.0, 4.0, &[2.0, 3.0, 4.0])
    );
    assert_eq!(
        extreme_ticks(-4.0, -4.0, 200.0, L),
        vt(-4.0, -2.0, &[-4.0, -3.0, -2.0])
    );
    assert_eq!(
        extreme_ticks(0.0, 0.0, 200.0, L),
        vt(0.0, 1.0, &[0.0, 0.5, 1.0])
    );
    // B2: subnormal spans have no duplicate midpoint.
    assert_eq!(extreme_ticks(0.0, 5e-324, 200.0, L).ticks, [0.0, 5e-324]);
    assert_eq!(
        extreme_ticks(5e-324, 1e-323, 200.0, L).ticks,
        [5e-324, 1e-323]
    );
    // B3: the mapped gaps decide 3, 2 or 1 ticks.
    let min3 = f64::from_bits(3);
    assert_eq!(min3, 1.5e-323);
    assert_eq!(extreme_ticks(0.0, min3, 32.0, L).ticks, [0.0, 1.5e-323]);
    assert_eq!(
        extreme_ticks(0.0, min3, 48.0, L).ticks,
        [0.0, 1e-323, 1.5e-323]
    );
    assert_eq!(extreme_ticks(0.0, min3, 47.5, L).ticks, [0.0, 1.5e-323]);
    assert_eq!(extreme_ticks(-2.0, 6.0, 32.0, L).ticks, [-2.0, 2.0, 6.0]);
    assert_eq!(extreme_ticks(-2.0, 6.0, 31.9, L).ticks, [-2.0, 6.0]);
    assert_eq!(extreme_ticks(-2.0, 6.0, 16.0, L).ticks, [-2.0, 6.0]);
    assert_eq!(extreme_ticks(-2.0, 6.0, 15.9, L).ticks, [-2.0]);
    assert_eq!(extreme_ticks(-2.0, 6.0, f64::NAN, L).ticks, [-2.0]);
    assert_eq!(extreme_ticks(-M, M, 32.0, L).ticks, [-M, 0.0, M]);
    assert_eq!(extreme_ticks(-M, M, 31.5, L).ticks, [-M, M]);
    assert_eq!(extreme_ticks(-M, M, 200.0, L), vt(-M, M, &[-M, 0.0, M]));
    // B4: the single tick is the end nearer zero, lo on a tie.
    assert_eq!(extreme_ticks(-1.0, 1.0, 0.0, L).ticks, [-1.0]);
    assert_eq!(extreme_ticks(-3.0, 1.0, 0.0, L).ticks, [1.0]);
    assert_eq!(extreme_ticks(2.0, 5.0, 0.0, L).ticks, [2.0]);
    assert_eq!(extreme_ticks(-5.0, -2.0, 0.0, L).ticks, [-2.0]);
    // B7: value_fraction is the draw mapping, halved when the span overflows.
    assert!((value_fraction(1e-323, 0.0, min3) - 2.0 / 3.0).abs() < 1e-15);
    assert_eq!(value_fraction(0.0, -M, M), 0.5);
    assert_eq!(value_fraction(M, -M, M), 1.0);
    assert_eq!(value_fraction(3.0, 1.0, 5.0), 0.5);
}

#[test]
fn value_ticks_short_plot() {
    assert_eq!(
        value_ticks(0.0, 1.0, 15.5, L, 1000),
        Some(vt(0.0, 1.0, &[0.0]))
    );
    assert_eq!(
        value_ticks(0.0, 1.0, 16.0, L, 1000).map(|v| v.ticks),
        Some(vec![0.0, 1.0])
    );
}

#[test]
fn ticks_fit_cases() {
    assert!(ticks_fit(&[-M, 0.0, M], -M, M, 200.0, L));
    let y: Vec<f64> = [-M, 0.0, M]
        .iter()
        .map(|v| tick_y(*v, -M, M, 0.0, 200.0))
        .collect();
    assert_eq!(y, [200.0, 100.0, 0.0]);
    assert!(y.iter().all(|v| v.is_finite()));
    let sub = [0.0, 1e-323, 1.5e-323];
    assert!(ticks_fit(&sub, 0.0, 1.5e-323, 48.0, L));
    let y: Vec<f64> = sub
        .iter()
        .map(|v| tick_y(*v, 0.0, 1.5e-323, 0.0, 48.0))
        .collect();
    assert_eq!(y, [48.0, 16.0, 0.0]);
    assert!(y.iter().all(|v| v.is_finite()));
    assert!(!ticks_fit(&sub, 0.0, 1.5e-323, 47.5, L));
    assert!(!ticks_fit(
        &[1.0, 1.0, 1.00000000001],
        0.9999999999999999,
        1.00000000001,
        200.0,
        L
    ));
    assert!(!ticks_fit(&[0.0, 1.0], 0.0, 1.0, f64::NAN, L));
    assert!(ticks_fit(&[5.0], 0.0, 10.0, 0.0, L));
}

#[test]
fn value_ticks_collision() {
    assert_eq!(value_ticks(1.0, 1.0 + 1e-11, 200.0, L, 1000), None);
}
