//! unit:spec-from-json (plan #68 C1 §3.4, D-PROTO): the TS `VisSpec` JSON the render worker
//! receives. `line` parses to a `LineSpec` (unknown fields ignored); the kinds the engine does not
//! draw yet are `Unsupported`; anything else is an error.
use dash_scene::{LineSpec, ValueRange, VisKind, VisSpec};
use dash_units::{TimeBase, Unit};

/// The gallery's `line-thresholds` spec, as `JSON.stringify` sends it.
const LINE_THRESHOLDS: &str = r#"{"kind":"line","title":"Request duration with thresholds","unit":{"kind":"time","base":"s"},"thresholds":[{"value":0.25,"state":"watch","label":"≥ 250 ms"},{"value":0.3,"state":"failing","label":"SLO p99 ≤ 300 ms"}]}"#;
/// The gallery's `bars` spec.
const BARS: &str = r#"{"kind":"bars","title":"Log lines by level","unit":{"kind":"suffix","suffix":"lines"},"stacking":"normal","categoryLabel":"level","categoryOrder":["debug","info","warn","error"]}"#;

#[test]
fn specs_parse_from_the_ts_json() {
    assert_eq!(
        VisSpec::from_json(LINE_THRESHOLDS).ok(),
        Some(VisSpec::Line(LineSpec::new(Unit::Time {
            base: TimeBase::S
        })))
    );
    assert_eq!(
        VisSpec::from_json(BARS).ok(),
        Some(VisSpec::Unsupported(VisKind::Bars))
    );
    for (json, kind) in [
        (
            r#"{"kind":"heatmap","title":"h","unit":{"kind":"none"},"countUnit":{"kind":"none"}}"#,
            VisKind::Heatmap,
        ),
        (
            r#"{"kind":"stat","title":"s","unit":{"kind":"none"}}"#,
            VisKind::Stat,
        ),
    ] {
        assert_eq!(
            VisSpec::from_json(json).ok(),
            Some(VisSpec::Unsupported(kind))
        );
    }
    let pinned =
        r#"{"kind":"line","title":"t","unit":{"kind":"none"},"valueRange":{"min":1,"max":5}}"#;
    let mut want = LineSpec::new(Unit::None);
    want.value_range = Some(ValueRange { min: 1.0, max: 5.0 });
    assert_eq!(VisSpec::from_json(pinned).ok(), Some(VisSpec::Line(want)));
    assert!(VisSpec::from_json(r#"{"kind":"pie"}"#).is_err());
    assert!(VisSpec::from_json("{").is_err());
    assert!(
        VisSpec::from_json(r#"{"kind":"line","title":"t"}"#).is_err(),
        "no unit"
    );
}
