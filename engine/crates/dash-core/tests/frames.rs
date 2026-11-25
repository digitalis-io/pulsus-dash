//! unit:engine-frames (plan #68 C1 §3.3, §3.4, §5; VIZ-001, D-ROUTE): the render worker's frame
//! table, without a GPU. A line frame builds its draw list and reports `a11y` once per change,
//! with the TS `FrameSummary` keys; a kind the engine does not draw clears and reports an empty
//! summary; data errors carry the TS issue codes.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::collections::BTreeSet;
use std::sync::Arc;

use dash_core::events;
use dash_core::frames::Frames;
use dash_marks::{DrawnEvent, MarkItem};
use dash_scene::Theme;
use dash_tokens::{ColourRole, colour};
use dash_wire::Chunk;
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};
use serde_json::Value;

const TS_SUMMARY_KEYS: [&str; 12] = [
    "kind",
    "seriesTotal",
    "seriesShown",
    "fromMs",
    "toMs",
    "min",
    "max",
    "last",
    "plot",
    "valueAxis",
    "thresholdLabels",
    "eventLabels",
];

fn line50() -> (Chunk, String) {
    let (chunk, spec) = gallery_line(GalleryLine::Line50, GALLERY_WINDOW);
    let unit = serde_json::to_string(&spec.unit).unwrap_or_default();
    let json = format!(r#"{{"kind":"line","title":"50 series","unit":{unit}}}"#);
    (chunk, json)
}

fn parse(json: &str) -> Value {
    serde_json::from_str(json).unwrap_or(Value::Null)
}

fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object()
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default()
}

fn line_frame(f: &mut Frames, id: u32, json: &str) {
    f.create(id, Some("f1".into()));
    assert!(f.set_spec(id, json).is_ok());
    f.set_window(id, GALLERY_WINDOW.0, GALLERY_WINDOW.1);
    f.resize(id, 1118.0, 240.0, 1.0);
}

#[test]
fn a_line_frame_reports_a11y_once_per_change() {
    let (chunk, json) = line50();
    let want = fixture::load("summary.json")
        .into_iter()
        .find(|r| r["id"] == "line-50")
        .map(|r| r["summary"].clone());
    let Some(want) = want else {
        panic!("summary.json has no line-50")
    };
    let mut f = Frames::new();
    line_frame(&mut f, 3, &json);
    f.set_chunk(3, Some(Arc::new(chunk)));
    let Some((list, a11y)) = f.build(3) else {
        panic!("no build")
    };
    assert!(
        list.items.iter().any(|i| matches!(i, MarkItem::Line { .. })),
        "{:?}",
        list.items.len()
    );
    let a11y = parse(&a11y.unwrap_or_default());
    let want_keys: BTreeSet<String> = TS_SUMMARY_KEYS.iter().map(|k| (*k).to_owned()).collect();
    assert_eq!(keys(&a11y), want_keys);
    assert_eq!(norm(&a11y["plot"]), norm(&want["plot"]));
    assert_eq!(norm(&a11y["valueAxis"]), norm(&want["valueAxis"]));
    assert_eq!(a11y["seriesShown"], serde_json::json!(50));
    assert_eq!(a11y["thresholdLabels"], serde_json::json!([]));
    // Unchanged: no a11y; a theme change redraws but the summary is the same.
    assert!(matches!(f.build(3), Some((_, None))));
    f.set_theme(3, Theme::Light);
    let Some((light, again)) = f.build(3) else {
        panic!("no build after set_theme")
    };
    assert_eq!(again, None);
    assert_eq!(light.clear, colour(Theme::Light, ColourRole::Surface1));
    assert_eq!(f.size(3), Some((1118.0, 240.0, 1.0)));
    f.dispose(3);
    assert!(f.build(3).is_none());
}

#[test]
fn series_data_builds_a_local_chunk() {
    let (chunk, json) = line50();
    let mut direct = Frames::new();
    line_frame(&mut direct, 1, &json);
    direct.set_chunk(1, Some(Arc::new(chunk.clone())));
    let want = direct.build(1).and_then(|(_, a)| a);
    let mut f = Frames::new();
    line_frame(&mut f, 1, &json);
    f.data_begin(1);
    for (s, meta) in chunk.series.iter().enumerate() {
        let values = chunk.series_values(s);
        let t: Vec<f64> = (0..values.len()).map(|k| chunk.t_ms(s, k)).collect();
        let (names, vals): (Vec<String>, Vec<String>) = meta.labels.iter().cloned().unzip();
        let key = format!("{:016x}", meta.key_hash);
        assert!(f.data_series(1, &key, names, vals, &t, values).is_ok());
    }
    assert!(f.data_end(1).is_ok());
    let Some((list, got)) = f.build(1) else {
        panic!("no build")
    };
    assert_eq!(got.map(|j| norm(&parse(&j))), want.map(|j| norm(&parse(&j))));
    let id = list.items.iter().find_map(|i| match i {
        MarkItem::Line { chunk, .. } => Some(chunk.id.0),
        MarkItem::Guides { .. } => None,
    });
    assert!(id.is_some_and(|id| id >= 1 << 63), "local id space: {id:?}");
    f.data_clear(1);
    assert!(matches!(f.build(1), Some((ref l, _)) if l.items.is_empty()));
}

#[test]
fn an_unsupported_kind_clears_and_reports_an_empty_summary() {
    let bars = r#"{"kind":"bars","title":"b","unit":{"kind":"none"},"stacking":"normal","categoryLabel":"level","categoryOrder":[]}"#;
    let mut f = Frames::new();
    f.create(4, None);
    assert!(f.set_spec(4, bars).is_ok());
    f.set_window(4, GALLERY_WINDOW.0, GALLERY_WINDOW.1);
    f.resize(4, 300.0, 150.0, 1.0);
    let Some((list, a11y)) = f.build(4) else {
        panic!("no build")
    };
    assert!(list.items.is_empty());
    let a = parse(&a11y.unwrap_or_default());
    assert_eq!(a["kind"], "bars");
    assert_eq!((a["seriesTotal"].clone(), a["seriesShown"].clone()), (0.into(), 0.into()));
    for k in ["min", "max", "last", "valueAxis"] {
        assert!(a[k].is_null(), "{k}: {a}");
    }
    assert_eq!(
        norm(&a["plot"]),
        norm(&serde_json::json!({"x": 0, "y": 0, "width": 300, "height": 150}))
    );
    assert_eq!(keys(&a).len(), TS_SUMMARY_KEYS.len());
}

#[test]
fn data_and_spec_errors_carry_their_codes() {
    let (_, json) = line50();
    let mut f = Frames::new();
    line_frame(&mut f, 2, &json);
    f.data_begin(2);
    let e = f.data_series(2, "XYZ", vec![], vec![], &[1.0], &[1.0]);
    assert_eq!(e.err().map(|e| e.to_string()).as_deref(), Some("key"));
    f.data_begin(2);
    let e = f.data_series(2, "00000000000000aa", vec![], vec![], &[1.0, 2.0, 3.0], &[1.0, 2.0]);
    assert_eq!(e.err().map(|e| e.to_string()).as_deref(), Some("length"));
    assert!(f.set_spec(2, r#"{"kind":"pie"}"#).is_err());
    assert!(matches!(f.build(2), Some((ref l, None)) if l.items.is_empty()));
}

#[test]
fn events_have_the_ts_shapes() {
    let a = parse(&events::a11y(3, r#"{"kind":"line"}"#));
    assert_eq!(a, serde_json::json!({"t": "a11y", "id": 3, "ev": {"kind": "line"}}));
    let ev = DrawnEvent {
        css_width: 1118.0,
        css_height: 240.0,
        dpr: 1.0,
    };
    let d = parse(&events::drawn(3, &ev, 10.5, 12.0, 50));
    assert_eq!(
        norm(&d),
        norm(&serde_json::json!({"t": "drawn", "id": 3, "ev": {"cssWidth": 1118, "cssHeight": 240, "dpr": 1}, "startMs": 10.5, "endMs": 12, "series": 50}))
    );
    let fl = parse(&events::failed(3, events::FailReason::Readback));
    assert_eq!(fl, serde_json::json!({"t": "failed", "id": 3, "reason": "readback"}));
    let s = parse(&events::failed(1, events::FailReason::Surface));
    assert_eq!(s["reason"], "surface");
}
