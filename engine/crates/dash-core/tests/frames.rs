//! unit:engine-frames (plan #68 C1 §3.3, §3.4, §5; VIZ-001, D-ROUTE): the render worker's frame
//! table, without a GPU. A line frame builds its draw list and reports `a11y` once per change,
//! with the TS `FrameSummary` keys; a kind the engine does not draw clears and reports an empty
//! summary; data errors carry the TS issue codes. Part C2a1 (§4.3, §5 `frames_apply`,
//! `presentation_capture`, `seq`, `dispose`): input records set the camera and the size, each
//! presentation reports the state it was submitted with, the acks are one per frame per tick, and
//! a frame id is never taken twice.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::collections::BTreeSet;
use std::sync::Arc;

use dash_axes::{VisKind, layout_plot};
use dash_core::events;
use dash_core::frames::{CameraIn, Frames, Presented};
use dash_core::input::{Decoded, Record};
use dash_marks::MarkItem;
use dash_scene::{Range64, Theme};
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

/// The idle camera of the gallery window.
fn window() -> CameraIn {
    CameraIn {
        view: Range64::from(GALLERY_WINDOW),
        value: None,
        band: None,
    }
}

fn line_frame(f: &mut Frames, id: u32, json: &str) {
    assert!(f.create(id, Some("f1".into())));
    assert!(f.set_spec(id, json).is_ok());
    f.set_camera(id, window());
    f.resize(id, (1118.0, 240.0), 1.0, (1118, 240), 1);
}

fn resize_rec(frame: u32, seq: u32, w: f32, h: f32, dpr: f32) -> Decoded {
    Decoded {
        seq,
        t_ms: 0.0,
        rec: Record::Resize {
            frame,
            css_w: w,
            css_h: h,
            dpr,
            device_w: (w * dpr).round() as u32,
            device_h: (h * dpr).round() as u32,
        },
    }
}

fn camera_rec(frame: u32, seq: u32, view: (f64, f64), value: (f64, f64), band: f64) -> Decoded {
    Decoded {
        seq,
        t_ms: 0.0,
        rec: Record::Camera {
            frame,
            view,
            value,
            band,
        },
    }
}

const NAN2: (f64, f64) = (f64::NAN, f64::NAN);

fn a11y_of(f: &mut Frames, id: u32) -> Value {
    f.build(id)
        .and_then(|(_, a)| a)
        .map_or(Value::Null, |a| parse(&a))
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
        list.items
            .iter()
            .any(|i| matches!(i, MarkItem::Line { .. })),
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
    assert_eq!(f.size(3), Some(((1118.0, 240.0), 1.0, (1118, 240))));
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
    assert_eq!(
        got.map(|j| norm(&parse(&j))),
        want.map(|j| norm(&parse(&j)))
    );
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
    assert!(f.create(4, None));
    assert!(f.set_spec(4, bars).is_ok());
    f.set_camera(4, window());
    f.resize(4, (300.0, 150.0), 1.0, (300, 150), 1);
    let Some((list, a11y)) = f.build(4) else {
        panic!("no build")
    };
    assert!(list.items.is_empty());
    let a = parse(&a11y.unwrap_or_default());
    assert_eq!(a["kind"], "bars");
    assert_eq!(
        (a["seriesTotal"].clone(), a["seriesShown"].clone()),
        (0.into(), 0.into())
    );
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
    let e = f.data_series(
        2,
        "00000000000000aa",
        vec![],
        vec![],
        &[1.0, 2.0, 3.0],
        &[1.0, 2.0],
    );
    assert_eq!(e.err().map(|e| e.to_string()).as_deref(), Some("length"));
    assert!(f.set_spec(2, r#"{"kind":"pie"}"#).is_err());
    assert!(matches!(f.build(2), Some((ref l, None)) if l.items.is_empty()));
}

#[test]
fn events_have_the_ts_shapes() {
    let a = parse(&events::a11y(3, r#"{"kind":"line"}"#));
    assert_eq!(
        a,
        serde_json::json!({"t": "a11y", "id": 3, "ev": {"kind": "line"}})
    );
    let p = Presented {
        seq: 9,
        rseq: 4,
        css: (1118.0, 240.0),
        dpr: 1.0,
        series: 50,
    };
    let d = parse(&events::drawn(3, &p, 10.5, 12.0));
    assert_eq!(
        norm(&d),
        norm(
            &serde_json::json!({"t": "drawn", "id": 3, "ev": {"cssWidth": 1118, "cssHeight": 240, "dpr": 1}, "startMs": 10.5, "endMs": 12, "series": 50, "seq": 9, "rseq": 4})
        )
    );
    assert_eq!(
        parse(&events::created(3)),
        serde_json::json!({"t": "created", "id": 3})
    );
    assert_eq!(
        parse(&events::applied(3, 0xFFFF_FFFF)),
        serde_json::json!({"t": "applied", "id": 3, "seq": 4_294_967_295_u32})
    );
    let fl = parse(&events::failed(3, events::FailReason::Readback));
    assert_eq!(
        fl,
        serde_json::json!({"t": "failed", "id": 3, "reason": "readback"})
    );
    let s = parse(&events::failed(1, events::FailReason::Surface));
    assert_eq!(s["reason"], "surface");
}

#[test]
fn frames_apply() {
    let (chunk, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, &json).is_ok());
    f.set_chunk(1, Some(Arc::new(chunk)));
    assert_eq!(f.apply(&resize_rec(1, 1, 1118.0, 240.0, 1.0)), Some(1));
    // No camera yet: the frame is cleared and reports nothing.
    let Some((list, a11y)) = f.build(1) else {
        panic!("no build")
    };
    assert!(list.items.is_empty());
    assert_eq!(a11y, None);
    // 12:00:00.25–12:59:59.75: the summary's window is the camera's view, unrounded.
    let view = (GALLERY_WINDOW.0 + 250.0, GALLERY_WINDOW.1 - 250.0);
    assert_eq!(f.apply(&camera_rec(1, 2, view, NAN2, f64::NAN)), Some(1));
    let a = a11y_of(&mut f, 1);
    assert_eq!(
        (a["fromMs"].as_f64(), a["toMs"].as_f64()),
        (Some(view.0), Some(view.1))
    );
    assert_eq!(a["valueAxis"]["manual"], false);
    let measured_x = a["plot"]["x"].as_f64();
    // A value range: the axis is manual at 0..10.
    assert_eq!(
        f.apply(&camera_rec(1, 3, view, (0.0, 10.0), f64::NAN)),
        Some(1)
    );
    let a = a11y_of(&mut f, 1);
    assert_eq!(
        norm(&a["valueAxis"]),
        norm(&serde_json::json!({"min": 0, "max": 10, "manual": true}))
    );
    // A fixed band of 60 px.
    assert_eq!(f.apply(&camera_rec(1, 4, view, (0.0, 10.0), 60.0)), Some(1));
    let a = a11y_of(&mut f, 1);
    assert_eq!(
        a["plot"]["x"].as_f64(),
        Some(layout_plot(VisKind::Line, 1118.0, 240.0, 60.0).x)
    );
    // NaN band: measured again.
    assert_eq!(f.apply(&camera_rec(1, 5, view, NAN2, f64::NAN)), Some(1));
    let a = a11y_of(&mut f, 1);
    assert_eq!(a["plot"]["x"].as_f64(), measured_x);
    assert!(measured_x.is_some());
    // hi = lo: rejected and counted; the camera stays, the frame presents again.
    assert_eq!(f.bad(), 0);
    assert_eq!(
        f.apply(&camera_rec(1, 6, (view.0, view.0), NAN2, f64::NAN)),
        Some(1)
    );
    assert_eq!(f.bad(), 1);
    // An unknown (disposed) frame: ignored, not bad.
    assert_eq!(f.apply(&camera_rec(9, 1, view, NAN2, f64::NAN)), None);
    assert_eq!(f.apply(&resize_rec(9, 2, 10.0, 10.0, 1.0)), None);
    assert_eq!(f.bad(), 1);
    // The value range and band checks of `from_record`.
    assert!(CameraIn::from_record((1.0, 2.0), (f64::NAN, 1.0), f64::NAN).is_none());
    assert!(CameraIn::from_record((1.0, 2.0), (3.0, 3.0), f64::NAN).is_none());
    assert!(CameraIn::from_record((1.0, 2.0), NAN2, -1.0).is_none());
    assert!(CameraIn::from_record((f64::INFINITY, 2.0), NAN2, f64::NAN).is_none());
    assert_eq!(
        CameraIn::from_record((1.0, 2.0), (0.0, 5.0), 0.0),
        Some(CameraIn {
            view: Range64 { lo: 1.0, hi: 2.0 },
            value: Some(Range64 { lo: 0.0, hi: 5.0 }),
            band: Some(0.0)
        })
    );
}

fn drawn_of(events: &[String]) -> Vec<Value> {
    events
        .iter()
        .map(|e| parse(e))
        .filter(|v| v["t"] == "drawn")
        .collect()
}

#[test]
fn presentation_capture() {
    let (chunk, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, &json).is_ok());
    f.set_chunk(1, Some(Arc::new(chunk)));
    let view = GALLERY_WINDOW;
    assert_eq!(f.apply(&resize_rec(1, 1, 300.0, 150.0, 1.0)), Some(1));
    assert_eq!(f.apply(&camera_rec(1, 2, view, NAN2, f64::NAN)), Some(1));
    assert!(f.build(1).is_some());
    let Some(p1) = f.submit(1) else {
        panic!("no presentation")
    };
    // Applied while p1 is in flight: p1 still reports what it was submitted with.
    assert_eq!(
        f.apply(&camera_rec(1, 3, (view.0, view.1 - 1.0), NAN2, f64::NAN)),
        Some(1)
    );
    assert_eq!(f.apply(&resize_rec(1, 4, 300.0, 150.0, 2.0)), Some(1));
    let d1 = drawn_of(&f.complete(1, &p1, 1.0, 2.0));
    assert_eq!(d1.len(), 1);
    assert_eq!(
        norm(&d1[0]["ev"]),
        norm(&serde_json::json!({"cssWidth": 300, "cssHeight": 150, "dpr": 1}))
    );
    assert_eq!(
        (d1[0]["seq"].as_u64(), d1[0]["rseq"].as_u64()),
        (Some(2), Some(1))
    );
    assert_eq!(d1[0]["series"], 50);
    assert!(f.build(1).is_some());
    let Some(p2) = f.submit(1) else {
        panic!("no presentation")
    };
    let d2 = drawn_of(&f.complete(1, &p2, 3.0, 4.0));
    assert_eq!(d2.len(), 1);
    assert_eq!(
        norm(&d2[0]["ev"]),
        norm(&serde_json::json!({"cssWidth": 300, "cssHeight": 150, "dpr": 2}))
    );
    assert_eq!(
        (d2[0]["seq"].as_u64(), d2[0]["rseq"].as_u64()),
        (Some(4), Some(4))
    );
    // A presentation dropped by its read-back (Rerun) is never completed: nothing is emitted for
    // it, and the acks are only `applied`.
    let _dropped = f.submit(1);
    assert!(drawn_of(&f.take_applied()).is_empty());
}

#[test]
fn seq_applied_once_per_frame_per_tick() {
    let mut f = Frames::new();
    assert!(f.create(5, None));
    assert!(f.create(6, None));
    // A zero-size frame Z = 5: records apply and are acked though it never draws.
    for cycle in 0..20u32 {
        let base = cycle * 1_500;
        for s in 1..=1_500u32 {
            let seq = base + s;
            assert_eq!(
                f.apply(&camera_rec(
                    5,
                    seq,
                    (1.0, 2.0 + f64::from(seq)),
                    NAN2,
                    f64::NAN
                )),
                Some(5)
            );
        }
        if cycle == 0 {
            assert_eq!(f.apply(&resize_rec(6, 1, 0.0, 0.0, 1.0)), Some(6));
        }
        let acks: Vec<Value> = f.take_applied().iter().map(|e| parse(e)).collect();
        let mut want = vec![serde_json::json!({"t": "applied", "id": 5, "seq": base + 1_500})];
        if cycle == 0 {
            want.push(serde_json::json!({"t": "applied", "id": 6, "seq": 1}));
        }
        assert_eq!(acks, want, "cycle {cycle}");
        assert!(f.take_applied().is_empty(), "none without records");
        let Some(p) = f.submit(5) else {
            panic!("no presentation")
        };
        assert!(f.complete(5, &p, 0.0, 0.0).is_empty(), "no drawn at size 0");
    }
}

#[test]
fn dispose_and_frame_ids() {
    let (_, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(3, None));
    assert!(f.set_spec(3, &json).is_ok());
    f.set_camera(3, window());
    // An id at or below the highest seen is refused; the first 3 is untouched.
    assert!(!f.create(3, Some("again".into())));
    assert!(!f.create(2, None));
    assert_eq!(f.frame_id(3), None);
    assert!(f.contains(3));
    assert!(f.create(4, None));
    // A disposed id is never taken again, and its later records are ignored.
    f.dispose(3);
    assert!(!f.create(3, None));
    assert_eq!(f.apply(&camera_rec(3, 7, (1.0, 2.0), NAN2, f64::NAN)), None);
    assert_eq!(f.bad(), 0);
    assert!(f.take_applied().is_empty());
}

/// Review r1 MINOR: a rejected Camera after a completed presentation still presents, so its seq
/// reaches a `drawn` (the adapter's settle) while the camera stays as it was.
#[test]
fn a_rejected_camera_still_presents() {
    let (chunk, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, &json).is_ok());
    f.set_chunk(1, Some(Arc::new(chunk)));
    assert_eq!(f.apply(&resize_rec(1, 1, 300.0, 150.0, 1.0)), Some(1));
    assert_eq!(
        f.apply(&camera_rec(1, 2, GALLERY_WINDOW, NAN2, f64::NAN)),
        Some(1)
    );
    let before = a11y_of(&mut f, 1);
    assert_eq!(
        (before["fromMs"].as_f64(), before["toMs"].as_f64()),
        (Some(GALLERY_WINDOW.0), Some(GALLERY_WINDOW.1))
    );
    let Some(p) = f.submit(1) else {
        panic!("no presentation")
    };
    let d = drawn_of(&f.complete(1, &p, 1.0, 2.0));
    assert_eq!(d[0]["seq"].as_u64(), Some(2));
    assert_eq!(f.take_applied().len(), 1);
    // The previous presentation completed; now a rejected Camera (hi < lo).
    let reversed = (GALLERY_WINDOW.1, GALLERY_WINDOW.0);
    assert_eq!(
        f.apply(&camera_rec(1, 3, reversed, NAN2, f64::NAN)),
        Some(1),
        "the frame presents again"
    );
    assert_eq!(f.bad(), 1);
    let Some((_, a11y)) = f.build(1) else {
        panic!("no build")
    };
    assert_eq!(a11y, None, "the camera is unchanged");
    let Some(p) = f.submit(1) else {
        panic!("no presentation")
    };
    let d = drawn_of(&f.complete(1, &p, 3.0, 4.0));
    assert_eq!(d.len(), 1);
    assert_eq!(
        (d[0]["seq"].as_u64(), d[0]["rseq"].as_u64()),
        (Some(3), Some(1))
    );
    let acks: Vec<Value> = f.take_applied().iter().map(|e| parse(e)).collect();
    assert_eq!(
        acks,
        [serde_json::json!({"t": "applied", "id": 1, "seq": 3})]
    );
}
