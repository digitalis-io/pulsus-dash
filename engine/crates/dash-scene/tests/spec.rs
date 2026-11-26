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

/// Plan #68 C2c1 §5 `spec_thresholds` (ADR-0022): the first 8 threshold lines in spec order, a JSON
/// `null` value (NaN and ±∞ in TS) as None, the label ignored; an unknown state is a spec error.
#[test]
fn spec_thresholds() {
    use dash_scene::{ThresholdLine, ThresholdState};
    let states = [
        "watch", "degraded", "failing", "watch", "degraded", "failing", "watch", "degraded",
        "failing", "watch",
    ];
    let lines: Vec<String> = states
        .iter()
        .enumerate()
        .map(|(k, s)| {
            let value = if k == 2 {
                "null".to_owned()
            } else {
                format!("{}", 10 * k)
            };
            format!(r#"{{"value":{value},"state":"{s}","label":"line {k}"}}"#)
        })
        .collect();
    let json = format!(
        r#"{{"kind":"line","title":"T","unit":{{"kind":"none"}},"thresholds":[{}]}}"#,
        lines.join(",")
    );
    let Ok(VisSpec::Line(spec)) = VisSpec::from_json(&json) else {
        panic!("not a line spec: {json}")
    };
    let state = |s: &str| match s {
        "watch" => ThresholdState::Watch,
        "degraded" => ThresholdState::Degraded,
        _ => ThresholdState::Failing,
    };
    let want: Vec<ThresholdLine> = (0..8)
        .map(|k| ThresholdLine {
            value: (k != 2).then_some(10.0 * k as f64),
            state: state(states[k]),
        })
        .collect();
    assert_eq!(spec.thresholds, want);
    // No thresholds: none.
    let Ok(VisSpec::Line(plain)) =
        VisSpec::from_json(r#"{"kind":"line","title":"T","unit":{"kind":"none"}}"#)
    else {
        panic!("not a line spec")
    };
    assert!(plain.thresholds.is_empty());
    // An unknown state is a spec error.
    let bad = r#"{"kind":"line","title":"T","unit":{"kind":"none"},"thresholds":[{"value":1,"state":"ok","label":""}]}"#;
    assert!(
        VisSpec::from_json(bad).is_err(),
        "an unknown state must not parse"
    );
}
