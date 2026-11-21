//! unit:extreme-ticks (plan #68 §5, A.3.2): ranges whose span overflows get three ticks, fast.
use dash_axes::{Band, VisKind, value_axis};
use dash_scales::extreme_ticks;
use dash_units::{Unit, format_value};

#[test]
fn overflowing_spans_use_extreme_ticks() {
    for (lo, hi) in [(-f64::MAX, f64::MAX), (f64::MAX / 2.0, f64::MAX)] {
        let t0 = std::time::Instant::now();
        let ax = value_axis(VisKind::Line, 1118.0, 240.0, lo, hi, None, &Unit::None, Band::Measure);
        let took = t0.elapsed();
        assert!(took < std::time::Duration::from_millis(1), "{lo:e}..{hi:e}: {took:?}");
        let want = extreme_ticks(lo.min(0.0), hi);
        assert_eq!(ax.ticks, want.ticks, "{lo:e}..{hi:e}");
        assert_eq!(ax.ticks.len(), 3);
        assert!(ax.ticks.iter().all(|t| t.is_finite()));
        let texts: Vec<String> = ax.ticks.iter().map(|t| format_value(*t, &Unit::None)).collect();
        let got: Vec<String> = ax.labels.iter().map(|l| l.text.clone()).collect();
        assert_eq!(got, texts);
    }
}
