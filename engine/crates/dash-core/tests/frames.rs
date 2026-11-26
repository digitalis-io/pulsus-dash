//! unit:engine-frames (plan #68 C1 §3.3, §3.4, §5; VIZ-001, D-ROUTE): the render worker's frame
//! table, without a GPU. A line frame builds its draw list and reports `a11y` once per change,
//! with the TS `FrameSummary` keys; a kind the engine does not draw clears and reports an empty
//! summary; data errors carry the TS issue codes. Part C2a1 (§4.3, §5 `frames_apply`,
//! `presentation_capture`, `seq`, `dispose`): input records set the camera and the size, each
//! presentation reports the state it was submitted with, the acks are one per frame per tick, and
//! a frame id is never taken twice. Part C2a2 (§3.3, §5 `stage_presented`, `stage_zero_size`): a
//! completed presentation of the frame's current Resize reports the stage it was submitted with,
//! once per change, before its `drawn`.
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
        .and_then(|(_, a, _)| a)
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
    let Some((list, a11y, _)) = f.build(3) else {
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
    assert!(matches!(f.build(3), Some((_, None, _))));
    f.set_theme(3, Theme::Light);
    let Some((light, again, _)) = f.build(3) else {
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
    let want = direct.build(1).and_then(|(_, a, _)| a);
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
    let Some((list, got, _)) = f.build(1) else {
        panic!("no build")
    };
    assert_eq!(
        got.map(|j| norm(&parse(&j))),
        want.map(|j| norm(&parse(&j)))
    );
    let id = list.items.iter().find_map(|i| match i {
        MarkItem::Line { chunk, .. } => Some(chunk.id.0),
        _ => None,
    });
    assert!(id.is_some_and(|id| id >= 1 << 63), "local id space: {id:?}");
    f.data_clear(1);
    assert!(matches!(f.build(1), Some((ref l, _, _)) if l.items.is_empty()));
}

#[test]
fn an_unsupported_kind_clears_and_reports_an_empty_summary() {
    let bars = r#"{"kind":"bars","title":"b","unit":{"kind":"none"},"stacking":"normal","categoryLabel":"level","categoryOrder":[]}"#;
    let mut f = Frames::new();
    assert!(f.create(4, None));
    assert!(f.set_spec(4, bars).is_ok());
    f.set_camera(4, window());
    f.resize(4, (300.0, 150.0), 1.0, (300, 150), 1);
    let Some((list, a11y, _)) = f.build(4) else {
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
    assert!(matches!(f.build(2), Some((ref l, None, _)) if l.items.is_empty()));
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
        stage: None,
        pick: None,
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
    let Some((list, a11y, _)) = f.build(1) else {
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
        Some(layout_plot(VisKind::Line, 1118.0, 240.0, 60.0, 0.0).x)
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
    let Some((_, a11y, _)) = f.build(1) else {
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

fn events_of(events: &[String]) -> Vec<Value> {
    events.iter().map(|e| parse(e)).collect()
}

/// Builds and submits frame `id`: the presentation, its list's CSS size and its summary.
fn present(f: &mut Frames, id: u32) -> (Presented, (f64, f64), Value) {
    let Some((list, a11y, _)) = f.build(id) else {
        panic!("no build")
    };
    let Some(p) = f.submit(id) else {
        panic!("no presentation")
    };
    (p, list.css, a11y.map_or(Value::Null, |a| parse(&a)))
}

/// The `stage` events of a completion, and whether each came before the `drawn`.
fn stages_of(events: &[Value]) -> Vec<Value> {
    let drawn_at = events.iter().position(|e| e["t"] == "drawn");
    events
        .iter()
        .enumerate()
        .filter(|(_, e)| e["t"] == "stage")
        .map(|(k, e)| {
            assert!(
                drawn_at.is_some_and(|d| k < d),
                "stage before its drawn: {events:?}"
            );
            e.clone()
        })
        .collect()
}

/// The stage of a line-50 presentation (C2b: with its pick count, line-50's 1 440 samples).
fn stage_json(plot: dash_axes::PlotRect, domain: (f64, f64), label_w: f64) -> Value {
    norm(&serde_json::json!({
        "plot": {"x": plot.x, "y": plot.y, "width": plot.width, "height": plot.height},
        "domain": {"min": domain.0, "max": domain.1},
        "labelW": label_w,
        "pickCount": 1440,
    }))
}

fn domain_of(a: &Value) -> (f64, f64) {
    (
        a["valueAxis"]["min"].as_f64().unwrap_or(f64::NAN),
        a["valueAxis"]["max"].as_f64().unwrap_or(f64::NAN),
    )
}

/// Plan #68 C2a2 §5 `stage_presented` (r1 #1, #2): the stage of a completed presentation, never of
/// a dropped or pending one, null for an empty plot, re-reported only when it changes.
#[test]
fn stage_presented() {
    let (chunk, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, &json).is_ok());
    f.set_chunk(1, Some(Arc::new(chunk)));
    let view = GALLERY_WINDOW;
    assert_eq!(f.apply(&resize_rec(1, 1, 1118.0, 240.0, 1.0)), Some(1));
    assert_eq!(f.apply(&camera_rec(1, 2, view, NAN2, 60.0)), Some(1));
    let (p1, _, a1) = present(&mut f, 1);
    let e1 = events_of(&f.complete(1, &p1, 1.0, 2.0));
    let s1 = stages_of(&e1);
    assert_eq!(s1.len(), 1, "{e1:?}");
    assert_eq!(
        (s1[0]["id"].as_u64(), s1[0]["rseq"].as_u64()),
        (Some(1), Some(1))
    );
    let plot = layout_plot(VisKind::Line, 1118.0, 240.0, 60.0, 0.0);
    assert_eq!(
        norm(&s1[0]["stage"]),
        stage_json(plot, domain_of(&a1), 60.0)
    );

    // (a) A Resize whose presentation is dropped (Retry): nothing for it; the next one reports.
    assert_eq!(f.apply(&resize_rec(1, 3, 600.0, 240.0, 1.0)), Some(1));
    // The summary changes with the first build after the Resize (p2's).
    let (_p2, _, a3) = present(&mut f, 1);
    let (p3, _, _) = present(&mut f, 1);
    let s3 = stages_of(&events_of(&f.complete(1, &p3, 3.0, 4.0)));
    assert_eq!(s3.len(), 1);
    assert_eq!(s3[0]["rseq"].as_u64(), Some(3));
    let plot600 = layout_plot(VisKind::Line, 600.0, 240.0, 60.0, 0.0);
    assert_eq!(
        norm(&s3[0]["stage"]),
        stage_json(plot600, domain_of(&a3), 60.0)
    );

    // (b) Awaiting its read-back: nothing until it completes.
    assert_eq!(f.apply(&resize_rec(1, 4, 900.0, 240.0, 1.0)), Some(1));
    let (p4, _, a4) = present(&mut f, 1);
    assert!(stages_of(&events_of(&f.take_applied())).is_empty());
    let s4 = stages_of(&events_of(&f.complete(1, &p4, 5.0, 6.0)));
    assert_eq!(s4.len(), 1);
    let plot900 = layout_plot(VisKind::Line, 900.0, 240.0, 60.0, 0.0);
    assert_eq!(
        norm(&s4[0]["stage"]),
        stage_json(plot900, domain_of(&a4), 60.0)
    );

    // (c) An empty plot withdraws the stage; a valid size reports it again.
    assert_eq!(f.apply(&resize_rec(1, 5, 10.0, 10.0, 1.0)), Some(1));
    let (p6, css6, _) = present(&mut f, 1);
    assert_eq!(css6, (10.0, 10.0));
    let s6 = stages_of(&events_of(&f.complete(1, &p6, 7.0, 8.0)));
    assert_eq!(s6.len(), 1);
    assert_eq!(s6[0]["stage"], Value::Null);
    assert_eq!(s6[0]["rseq"].as_u64(), Some(5));
    assert_eq!(f.apply(&resize_rec(1, 6, 1118.0, 240.0, 1.0)), Some(1));
    let (p7, _, a7) = present(&mut f, 1);
    let s7 = stages_of(&events_of(&f.complete(1, &p7, 9.0, 10.0)));
    assert_eq!(s7.len(), 1);
    assert_eq!(
        norm(&s7[0]["stage"]),
        stage_json(plot, domain_of(&a7), 60.0)
    );

    // (d) A NaN band: the measured width; the same stage is not reported again.
    assert_eq!(f.apply(&camera_rec(1, 7, view, NAN2, f64::NAN)), Some(1));
    let (p8, _, a8) = present(&mut f, 1);
    let s8 = stages_of(&events_of(&f.complete(1, &p8, 11.0, 12.0)));
    assert_eq!(s8.len(), 1);
    let x = a8["plot"]["x"].as_f64().unwrap_or(f64::NAN);
    let measured = s8[0]["stage"]["labelW"].as_f64().unwrap_or(f64::NAN);
    assert_eq!(
        layout_plot(VisKind::Line, 1118.0, 240.0, measured, 0.0).x,
        x
    );
    assert_ne!(
        measured, 60.0,
        "precondition: the measured band is not the held one"
    );
    let (p9, _, _) = present(&mut f, 1);
    let e9 = events_of(&f.complete(1, &p9, 13.0, 14.0));
    assert!(stages_of(&e9).is_empty(), "{e9:?}");
    assert_eq!(e9.iter().filter(|e| e["t"] == "drawn").count(), 1);
}

/// Plan #68 C2a2 §5 `stage_zero_size` (r3 #4): a completion of an older Resize never reports; the
/// first completion after any applied Resize always does, also with the same content.
#[test]
fn stage_zero_size() {
    let (chunk, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, &json).is_ok());
    f.set_chunk(1, Some(Arc::new(chunk)));
    assert_eq!(f.apply(&resize_rec(1, 1, 800.0, 240.0, 1.0)), Some(1));
    assert_eq!(
        f.apply(&camera_rec(1, 2, GALLERY_WINDOW, NAN2, f64::NAN)),
        Some(1)
    );
    let (p1, _, _) = present(&mut f, 1);
    let s1 = stages_of(&events_of(&f.complete(1, &p1, 1.0, 2.0)));
    assert_eq!(s1.len(), 1);
    let stage1 = s1[0]["stage"].clone();
    assert!(stage1.is_object());
    // An r1 submission in flight; then Resize 0×240 (r2): the worker presents nothing at r2.
    let (late, _, _) = present(&mut f, 1);
    assert_eq!(f.apply(&resize_rec(1, 3, 0.0, 240.0, 1.0)), Some(1));
    let Some((list, _, _)) = f.build(1) else {
        panic!("no build")
    };
    assert_eq!(list.css.0, 0.0, "no presentation at size 0");
    let e = events_of(&f.complete(1, &late, 3.0, 4.0));
    assert!(stages_of(&e).is_empty(), "a stale completion: {e:?}");
    // r3, then r4: each reports S1 with its own rseq.
    for (seq, at) in [(4u32, 5.0), (5, 7.0)] {
        assert_eq!(f.apply(&resize_rec(1, seq, 800.0, 240.0, 1.0)), Some(1));
        let (p, _, _) = present(&mut f, 1);
        let s = stages_of(&events_of(&f.complete(1, &p, at, at + 1.0)));
        assert_eq!(s.len(), 1, "rseq {seq}");
        assert_eq!(s[0]["rseq"].as_u64(), Some(u64::from(seq)));
        assert_eq!(s[0]["stage"], stage1);
    }
}

// Plan #68 C2b §5: hover, select and the overlay on engine frames.

/// C2a2 §5's `lineData`: 61 samples over 12:00–13:00, value `30·i/60`, key `…a1`.
const T0: f64 = GALLERY_WINDOW.0;
const W0: (f64, f64) = (GALLERY_WINDOW.0, GALLERY_WINDOW.0 + 3_600_000.0);

fn line_data(f: &mut Frames, id: u32, n: usize) {
    let t: Vec<f64> = (0..n).map(|i| T0 + 60_000.0 * i as f64).collect();
    let v: Vec<f64> = (0..n).map(|i| 30.0 * i as f64 / 60.0).collect();
    f.data_begin(id);
    if n > 0 {
        let r = f.data_series(id, "00000000000000a1", Vec::new(), Vec::new(), &t, &v);
        assert!(r.is_ok(), "{r:?}");
    }
    assert!(f.data_end(id).is_ok());
}

const LINE: &str = r#"{"kind":"line","title":"T","unit":{"kind":"none"}}"#;

fn overlay_rec(frame: u32, seq: u32, hover: u8, x: f64, y: f64, key: u32) -> Decoded {
    Decoded {
        seq,
        t_ms: 0.0,
        rec: Record::Overlay {
            frame,
            hover,
            boxed: 0,
            x,
            y,
            key,
            box_x0: 0.0,
            box_x: 0.0,
        },
    }
}

fn select_rec(frame: u32, seq: u32, x: f64, y: f64) -> Decoded {
    Decoded {
        seq,
        t_ms: 0.0,
        rec: Record::Select { frame, x, y },
    }
}

/// A presented line frame (Resize s1 800×240, Camera s2 at `view`), completed: its presentation.
fn presented(f: &mut Frames, data: impl FnOnce(&mut Frames), view: (f64, f64)) -> Presented {
    assert!(f.create(1, None));
    assert!(f.set_spec(1, LINE).is_ok());
    data(f);
    assert_eq!(f.apply(&resize_rec(1, 1, 800.0, 240.0, 1.0)), Some(1));
    assert_eq!(f.apply(&camera_rec(1, 2, view, NAN2, f64::NAN)), Some(1));
    let (p, _, _) = present(f, 1);
    let _ = f.complete(1, &p, 1.0, 2.0);
    let _ = f.take_applied();
    p
}

fn plot_of(p: &Presented) -> dash_axes::PlotRect {
    match &p.stage {
        Some(s) => s.plot,
        None => panic!("no stage"),
    }
}

/// The overlay item of a list.
fn overlay_of(list: &dash_marks::DrawList) -> Vec<dash_marks::OverlayShape> {
    let items: Vec<_> = list
        .items
        .iter()
        .filter_map(|i| match i {
            MarkItem::Overlay { shapes } => Some(shapes.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(items.len(), 1, "one overlay item: {:?}", list.items.len());
    assert!(
        matches!(list.items.last(), Some(MarkItem::Overlay { .. })),
        "the overlay is last"
    );
    items.into_iter().next().unwrap_or_default()
}

/// Builds frame `id`: its list and its `hover` event (parsed).
fn build_hover(f: &mut Frames, id: u32) -> (dash_marks::DrawList, Value) {
    let Some((list, _, hover)) = f.build(id) else {
        panic!("no build")
    };
    (list, hover.map_or(Value::Null, |h| parse(&h)))
}

/// Plan #68 C2b §5 `overlay_order` (r1 #1, T02-024): the list drawn in a tick carries the hover
/// that tick emits.
#[test]
fn overlay_order() {
    let (chunk, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, &json).is_ok());
    f.set_chunk(1, Some(Arc::new(chunk)));
    assert_eq!(f.apply(&resize_rec(1, 1, 1118.0, 240.0, 1.0)), Some(1));
    assert_eq!(
        f.apply(&camera_rec(1, 2, GALLERY_WINDOW, NAN2, f64::NAN)),
        Some(1)
    );
    let (p, _, _) = present(&mut f, 1);
    let _ = f.complete(1, &p, 1.0, 2.0);
    let plot = plot_of(&p);
    let mid = plot.y + plot.height / 2.0;
    let mut seen = Vec::new();
    for (seq, frac) in [(3u32, 0.3), (4, 0.6)] {
        let x = plot.x + frac * plot.width;
        assert_eq!(f.apply(&overlay_rec(1, seq, 1, x, mid, 0)), Some(1));
        let (list, h) = build_hover(&mut f, 1);
        assert_eq!(h["oseq"].as_u64(), Some(u64::from(seq)), "{h}");
        let x_css = h["ev"]["xCss"].as_f64().unwrap_or(f64::NAN);
        assert!(x_css.is_finite(), "a hover at {frac}: {h}");
        let shapes = overlay_of(&list);
        let Some(dash_marks::OverlayShape::Rect { css, .. }) = shapes.first() else {
            panic!("no crosshair: {shapes:?}")
        };
        assert_eq!(css[0], dash_scene::camera::js_round(x_css) as f32, "{frac}");
        seen.push(css[0]);
    }
    assert_ne!(seen[0], seen[1]);
    assert_eq!(f.apply(&overlay_rec(1, 5, 0, 0.0, 0.0, 0)), Some(1));
    let (list, h) = build_hover(&mut f, 1);
    assert_eq!(h["oseq"].as_u64(), Some(5));
    assert!(h["ev"].is_null(), "{h}");
    assert!(overlay_of(&list).is_empty(), "no crosshair and no dot");
}

/// Plan #68 C2b §5 `frames_overlay` (T02-024): one `hover` per applied Overlay, from the build
/// after it; an Overlay does not rebuild the layer, a Camera does; a bad Overlay is counted.
#[test]
fn frames_overlay() {
    let (chunk, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, &json).is_ok());
    f.set_chunk(1, Some(Arc::new(chunk)));
    assert_eq!(f.apply(&resize_rec(1, 1, 1118.0, 240.0, 1.0)), Some(1));
    assert_eq!(
        f.apply(&camera_rec(1, 2, GALLERY_WINDOW, NAN2, f64::NAN)),
        Some(1)
    );
    let (p, _, _) = present(&mut f, 1);
    let _ = f.complete(1, &p, 1.0, 2.0);
    let Some(pick) = p.pick.clone() else {
        panic!("the presentation has no pick")
    };
    let plot = plot_of(&p);
    let (x, y) = (plot.x + 0.3 * plot.width, plot.y + 20.0);
    let builds = f.layer_builds();
    assert_eq!(f.apply(&overlay_rec(1, 5, 1, x, y, 0)), Some(1));
    let (_, h) = build_hover(&mut f, 1);
    let want = dash_scene::hover::hover_at(&pick, dash_scene::hover::HoverAt::Pointer { x, y });
    assert!(want.is_some(), "precondition: a hover there");
    assert_eq!(
        norm(&h),
        norm(&serde_json::json!({"t": "hover", "id": 1, "oseq": 5, "ev": want}))
    );
    // The next build emits nothing: no Overlay since.
    let (_, h) = build_hover(&mut f, 1);
    assert!(h.is_null(), "{h}");
    assert_eq!(f.apply(&overlay_rec(1, 6, 0, 0.0, 0.0, 0)), Some(1));
    let (_, h) = build_hover(&mut f, 1);
    assert_eq!(
        norm(&h),
        norm(&serde_json::json!({"t": "hover", "id": 1, "oseq": 6, "ev": null}))
    );
    assert_eq!(
        f.layer_builds(),
        builds,
        "an Overlay does not rebuild the layer"
    );
    // hover 3: rejected, counted, acked.
    let bad = f.bad();
    assert_eq!(f.apply(&overlay_rec(1, 7, 3, x, y, 0)), Some(1));
    assert_eq!(f.bad(), bad + 1);
    assert_eq!(
        events_of(&f.take_applied()),
        [serde_json::json!({"t": "applied", "id": 1, "seq": 7})]
    );
    let (_, h) = build_hover(&mut f, 1);
    assert!(h.is_null(), "a bad Overlay emits no hover: {h}");
    // Non-finite pointer and box coordinates are rejected too.
    for d in [
        overlay_rec(1, 8, 1, f64::NAN, y, 0),
        Decoded {
            seq: 9,
            t_ms: 0.0,
            rec: Record::Overlay {
                frame: 1,
                hover: 0,
                boxed: 1,
                x: 0.0,
                y: 0.0,
                key: 0,
                box_x0: 10.0,
                box_x: f64::INFINITY,
            },
        },
        Decoded {
            seq: 10,
            t_ms: 0.0,
            rec: Record::Overlay {
                frame: 1,
                hover: 0,
                boxed: 2,
                x: 0.0,
                y: 0.0,
                key: 0,
                box_x0: 0.0,
                box_x: 0.0,
            },
        },
    ] {
        let before = f.bad();
        assert_eq!(f.apply(&d), Some(1));
        assert_eq!(f.bad(), before + 1, "{d:?}");
    }
    // A Camera rebuilds the layer and emits no hover.
    let before = f.layer_builds();
    assert_eq!(
        f.apply(&camera_rec(
            1,
            11,
            (GALLERY_WINDOW.0, GALLERY_WINDOW.1 + 1.0),
            NAN2,
            f64::NAN
        )),
        Some(1)
    );
    let (_, h) = build_hover(&mut f, 1);
    assert!(h.is_null(), "{h}");
    assert_eq!(f.layer_builds(), before + 1);
}

/// Plan #68 C2b §5 `frames_select` (ADR-0025, T25-005): a click picks on the presentation on
/// screen, never a newer state; nothing without one.
#[test]
fn frames_select() {
    // (a) No completion yet: no event, but the frame is dirtied and the record acked.
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, LINE).is_ok());
    line_data(&mut f, 1, 61);
    assert_eq!(f.apply(&resize_rec(1, 1, 800.0, 240.0, 1.0)), Some(1));
    assert_eq!(f.apply(&camera_rec(1, 2, W0, NAN2, f64::NAN)), Some(1));
    assert_eq!(f.apply(&select_rec(1, 3, 300.0, 100.0)), Some(1));
    assert!(f.take_events().is_empty());
    assert_eq!(
        events_of(&f.take_applied()),
        [serde_json::json!({"t": "applied", "id": 1, "seq": 3})]
    );

    // (b) p1 (W0) completed; Camera W1 applied and p2 submitted, not completed: W0's pick.
    let mut f = Frames::new();
    let p1 = presented(&mut f, |f| line_data(f, 1, 61), W0);
    let plot = plot_of(&p1);
    let w1 = (W0.0 + 1_800_000.0, W0.1 + 1_800_000.0);
    assert_eq!(f.apply(&camera_rec(1, 3, w1, NAN2, f64::NAN)), Some(1));
    let (_p2, _, _) = present(&mut f, 1);
    let x = plot.x + 0.3 * plot.width;
    let Some(s) = p1.pick.as_ref() else {
        panic!("p1 has no pick")
    };
    let y = s.axis.y(9.0);
    assert_eq!(f.apply(&select_rec(1, 4, x, y)), Some(1));
    let ev = events_of(&f.take_events());
    assert_eq!(
        norm(&serde_json::Value::Array(ev)),
        norm(&serde_json::json!([{"t": "select", "id": 1, "item": {
            "kind": "point", "key": "00000000000000a1", "tMs": T0 + 18.0 * 60_000.0, "value": 9.0
        }}]))
    );

    // (c) A zero-size presentation completed: nothing is on screen.
    assert_eq!(f.apply(&resize_rec(1, 5, 0.0, 240.0, 1.0)), Some(1));
    let (p0, css, _) = present(&mut f, 1);
    assert_eq!(css.0, 0.0);
    let _ = f.complete(1, &p0, 3.0, 4.0);
    assert_eq!(f.apply(&select_rec(1, 6, x, y)), Some(1));
    assert!(f.take_events().is_empty());

    // (d) A non-finite click is rejected.
    let bad = f.bad();
    assert_eq!(f.apply(&select_rec(1, 7, f64::NAN, y)), Some(1));
    assert_eq!(f.bad(), bad + 1);
    assert!(f.take_events().is_empty());
}

/// Plan #68 C2b §5 `stage_pick_count`: the stage carries the samples of series 0 (the keyboard
/// crosshair's range), 0 without a series.
#[test]
fn stage_pick_count() {
    for (n, want) in [(61usize, 61u64), (0, 0)] {
        let mut f = Frames::new();
        assert!(f.create(1, None));
        assert!(f.set_spec(1, LINE).is_ok());
        line_data(&mut f, 1, n);
        assert_eq!(f.apply(&resize_rec(1, 1, 800.0, 240.0, 1.0)), Some(1));
        assert_eq!(f.apply(&camera_rec(1, 2, W0, NAN2, f64::NAN)), Some(1));
        let (p, _, _) = present(&mut f, 1);
        let s = stages_of(&events_of(&f.complete(1, &p, 1.0, 2.0)));
        assert_eq!(s.len(), 1, "{n} samples");
        assert_eq!(
            s[0]["stage"]["pickCount"].as_u64(),
            Some(want),
            "{n} samples: {s:?}"
        );
    }
}

/// Code review r1 (plan #68 C2b): a key index from the previous stage's `pickCount` after
/// `setData` shortened series 0 (the new stage not yet on main) is clamped to the last sample of
/// the presented data: a finite hover of the new data's last sample, never a NaN time. With no
/// sample at all there is no hover.
#[test]
fn key_index_past_new_data() {
    let mut f = Frames::new();
    let _ = presented(&mut f, |f| line_data(f, 1, 61), W0);
    // The data shrinks to 31 samples; main still has pickCount 61 and sends End (60).
    line_data(&mut f, 1, 31);
    assert_eq!(f.apply(&overlay_rec(1, 3, 2, 0.0, 0.0, 60)), Some(1));
    let (_, h) = build_hover(&mut f, 1);
    let ev = &h["ev"];
    assert_eq!(ev["source"], "keyboard", "{h}");
    assert_eq!(ev["tMs"].as_f64(), Some(T0 + 30.0 * 60_000.0), "{h}");
    assert!(ev["xCss"].as_f64().is_some_and(f64::is_finite), "{h}");
    assert_eq!(ev["rows"][0]["value"].as_f64(), Some(15.0), "{h}");
    // No series left: no hover.
    line_data(&mut f, 1, 0);
    assert_eq!(f.apply(&overlay_rec(1, 4, 2, 0.0, 0.0, 30)), Some(1));
    let (_, h) = build_hover(&mut f, 1);
    assert!(h["ev"].is_null(), "{h}");
}

/// Plan #68 C2c1 §5 `frames_events` (§4.2, ADR-0023): `set_events` is a layer input; the band moves
/// the stage's plot down by `EVENT_BAND` (18 px) at the next completion, and back without events;
/// the summary's label boxes stay empty until #69; an Overlay alone after it reuses the layer.
#[test]
fn frames_events() {
    let (chunk, json) = line50();
    let mut f = Frames::new();
    assert!(f.create(1, None));
    assert!(f.set_spec(1, &json).is_ok());
    f.set_chunk(1, Some(Arc::new(chunk)));
    assert_eq!(f.apply(&resize_rec(1, 1, 1118.0, 240.0, 1.0)), Some(1));
    assert_eq!(
        f.apply(&camera_rec(1, 2, GALLERY_WINDOW, NAN2, f64::NAN)),
        Some(1)
    );
    let (p0, _, _) = present(&mut f, 1);
    let _ = f.complete(1, &p0, 1.0, 2.0);
    let plot0 = plot_of(&p0);
    let builds = f.layer_builds();
    f.set_events(1, vec![GALLERY_WINDOW.0 + 1_800_000.0]);
    let (p1, _, a1) = present(&mut f, 1);
    assert_eq!(f.layer_builds(), builds + 1, "events rebuild the layer");
    assert_eq!(a1["thresholdLabels"], serde_json::json!([]), "{a1}");
    assert_eq!(a1["eventLabels"], serde_json::json!([]), "{a1}");
    let s1 = stages_of(&events_of(&f.complete(1, &p1, 3.0, 4.0)));
    assert_eq!(s1.len(), 1, "the band flip is reported");
    assert_eq!(s1[0]["stage"]["plot"]["y"].as_f64(), Some(plot0.y + 18.0));
    assert_eq!(
        s1[0]["stage"]["plot"]["height"].as_f64(),
        Some(plot0.height - 18.0)
    );
    // An Overlay alone: the layer (with its event line) is reused, the hover overlay after it.
    let builds = f.layer_builds();
    let plot1 = plot_of(&p1);
    let x = plot1.x + 0.3 * plot1.width;
    assert_eq!(
        f.apply(&overlay_rec(1, 3, 1, x, plot1.y + 20.0, 0)),
        Some(1)
    );
    let (list, _) = build_hover(&mut f, 1);
    assert_eq!(
        f.layer_builds(),
        builds,
        "an Overlay does not rebuild the layer"
    );
    let overlays = list
        .items
        .iter()
        .filter(|i| matches!(i, MarkItem::Overlay { .. }))
        .count();
    assert_eq!(overlays, 2, "the layer Overlay, then the hover's");
    // No events: the band goes.
    f.set_events(1, Vec::new());
    let (p2, _, _) = present(&mut f, 1);
    assert_eq!(f.layer_builds(), builds + 1);
    let s2 = stages_of(&events_of(&f.complete(1, &p2, 5.0, 6.0)));
    assert_eq!(s2.len(), 1);
    assert_eq!(s2[0]["stage"]["plot"]["y"].as_f64(), Some(plot0.y));
}
