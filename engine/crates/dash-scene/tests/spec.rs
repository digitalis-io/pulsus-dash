//! unit:spec-value-range (plan #68 §5, ADR-0020 (2), (3)): an invalid pin is auto; the summary
//! reports the drawn domain.
mod common;

use common::*;
use dash_scene::{LineSpec, PlotCamera, Range64, ValueRange, VisSpec, YRange, build};
use dash_units::Unit;

#[test]
fn idle_camera_and_summary_follow_the_value_range() {
    let window = Range64 {
        lo: T0,
        hi: T0 + 10_000.0,
    };
    let cases = [
        (None, false),
        (Some(ValueRange { min: 2.0, max: 8.0 }), true),
        (Some(ValueRange { min: 1.0, max: 1.0 }), false),
        (
            Some(ValueRange {
                min: f64::NAN,
                max: 3.0,
            }),
            false,
        ),
    ];
    for (vr, manual) in cases {
        let mut spec = LineSpec::new(Unit::None);
        spec.value_range = vr;
        let cam = PlotCamera::idle(window, &VisSpec::Line(spec.clone()));
        assert_eq!(cam.x, window);
        match (manual, cam.y) {
            (true, YRange::Manual(r)) => assert_eq!(r, Range64 { lo: 2.0, hi: 8.0 }),
            (false, YRange::Auto) => {}
            other => panic!("{vr:?}: {other:?}"),
        }
        let v = viewport(
            chunk_of(&[1.0, 5.0, 3.0]),
            spec,
            window,
            dash_scene::Band::Measure,
        );
        let (_, summary) = build(&v);
        let Some(s) = summary else {
            panic!("{vr:?}: no summary")
        };
        let Some(ax) = s.value_axis else {
            panic!("{vr:?}: no valueAxis")
        };
        assert_eq!(ax.manual, manual, "{vr:?}");
        if manual {
            assert_eq!((ax.min, ax.max), (2.0, 8.0));
        }
    }
}

#[test]
fn line_spec_parses_the_ts_json() {
    let spec: Result<LineSpec, _> = serde_json::from_str(
        r#"{"kind":"line","title":"x","unit":{"kind":"time","base":"ms"},"valueRange":{"min":1,"max":2}}"#,
    );
    let Ok(spec) = spec else { panic!("{spec:?}") };
    assert_eq!(spec.value_range, Some(ValueRange { min: 1.0, max: 2.0 }));
    assert_eq!(spec.max_series, 500);
    assert_eq!(
        ValueRange { min: 1.0, max: 2.0 }.validated(),
        Some(Range64 { lo: 1.0, hi: 2.0 })
    );
}
