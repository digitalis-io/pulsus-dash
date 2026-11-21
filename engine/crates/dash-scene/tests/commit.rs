//! unit:commit-shape (plan #68 §5, ADR-0020 (1)): whole-ms windows and the commit event's JSON.
use dash_scene::camera::to_window;
use dash_scene::{CommitEvent, Gesture, Range64, TimeWindow, ValueCommit, ValueRange};
use serde_json::json;

#[test]
fn to_window_rounds_like_ecmascript() {
    let w = |lo, hi| {
        let t = to_window(Range64 { lo, hi });
        (t.from_ms, t.to_ms)
    };
    assert_eq!(w(1000.4, 61000.6), (1000.0, 61001.0));
    assert_eq!(w(-2.5, 2.5), (-2.0, 3.0));
    assert_eq!(w(5.0, 5.2), (5.0, 6.0));
}

#[test]
fn commit_json_is_the_ts_shape() {
    let window = CommitEvent {
        window: Some(TimeWindow { from_ms: 1000.0, to_ms: 61001.0 }),
        value: None,
        gesture: Gesture::Wheel,
    };
    let value = CommitEvent {
        window: None,
        value: Some(ValueCommit::Range(ValueRange { min: 0.25, max: 0.75 })),
        gesture: Gesture::Axis,
    };
    let auto = CommitEvent { window: None, value: Some(ValueCommit::Auto), gesture: Gesture::Fit };
    let j = |e: &CommitEvent| serde_json::to_value(e).unwrap_or_default();
    assert_eq!(j(&window), json!({"window": {"fromMs": 1000.0, "toMs": 61001.0}, "value": null, "gesture": "wheel"}));
    assert_eq!(j(&value), json!({"window": null, "value": {"min": 0.25, "max": 0.75}, "gesture": "axis"}));
    assert_eq!(j(&auto), json!({"window": null, "value": "auto", "gesture": "fit"}));
    let pan = CommitEvent { window: None, value: None, gesture: Gesture::Pan };
    assert_eq!(j(&pan)["gesture"], json!("pan"));
}
