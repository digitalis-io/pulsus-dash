//! unit:manual-axis (plan #68 §5, ADR-0020 (2), #93's plan §3.5): a manual axis keeps its range as
//! the domain and only ticks inside it.
use dash_axes::{Band, VisKind, label_height, layout_plot, value_axis};
use dash_scales::{Range64, value_ticks};
use dash_units::Unit;

#[test]
fn manual_axis_uses_the_range() {
    for (lo, hi) in [(0.25, 0.75), (-3.0, 1e6), (1e-9, 2e-9)] {
        let r = Range64 { lo, hi };
        let ax = value_axis(VisKind::Line, 1118.0, 240.0, 0.0, 30.0, Some(r), &Unit::None, Band::Measure);
        assert!(ax.manual, "{r:?}");
        assert_eq!(ax.domain, r);
        let height = layout_plot(VisKind::Line, 1118.0, 240.0, 0.0).height;
        let Some(vt) = value_ticks(lo, hi, height, label_height(), 1000) else {
            panic!("value_ticks None for {r:?}");
        };
        let tol = 1e-9 * (hi - lo);
        let want: Vec<f64> = vt.ticks.into_iter().filter(|t| *t >= lo - tol && *t <= hi + tol).collect();
        assert!(!want.is_empty(), "{r:?}");
        assert_eq!(ax.ticks, want, "{r:?}");
        let bottom = ax.plot.y + ax.plot.height;
        assert!((ax.y(lo) - bottom).abs() <= 1e-9, "{r:?}: {} vs {bottom}", ax.y(lo));
        assert!((ax.y(hi) - ax.plot.y).abs() <= 1e-9, "{r:?}: {}", ax.y(hi));
    }
}
