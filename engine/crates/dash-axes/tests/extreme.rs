//! unit:extreme-ticks (plan #68 §5, A.3.2): ranges whose span overflows get three ticks, and the
//! tick search terminates. Termination is checked by a hang guard (the axis is computed on another
//! thread and must answer within 10 s); the elapsed time is printed for information only, so CI
//! load cannot fail the test.
use dash_axes::{Band, VisKind, label_height, layout_plot, value_axis};
use dash_scales::extreme_ticks;
use dash_units::{Unit, format_value};

#[test]
fn overflowing_spans_use_extreme_ticks() {
    for (lo, hi) in [(-f64::MAX, f64::MAX), (f64::MAX / 2.0, f64::MAX)] {
        let t0 = std::time::Instant::now();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let ax = value_axis(
                VisKind::Line,
                1118.0,
                240.0,
                lo,
                hi,
                None,
                &Unit::None,
                Band::Measure,
                0.0,
            );
            let _ = tx.send(ax);
        });
        let ax = match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(ax) => ax,
            Err(e) => panic!("{lo:e}..{hi:e}: value_axis did not terminate ({e})"),
        };
        eprintln!(
            "{lo:e}..{hi:e}: value_axis took {:?} (report only)",
            t0.elapsed()
        );
        let want = extreme_ticks(
            lo.min(0.0),
            hi,
            layout_plot(VisKind::Line, 1118.0, 240.0, 0.0, 0.0).height,
            label_height(),
        );
        assert_eq!(ax.ticks, want.ticks, "{lo:e}..{hi:e}");
        assert_eq!(ax.ticks.len(), 3);
        assert!(ax.ticks.iter().all(|t| t.is_finite()));
        let texts: Vec<String> = ax
            .ticks
            .iter()
            .map(|t| format_value(*t, &Unit::None))
            .collect();
        let got: Vec<String> = ax.labels.iter().map(|l| l.text.clone()).collect();
        assert_eq!(got, texts);
    }
}
