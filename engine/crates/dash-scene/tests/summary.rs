//! unit:frame-summary-parity (plan #68 §5, ADR-0014 §3 `a11y`, ADR-0020 (3)): the built summary
//! of each gallery line entry equals the TS `frameSummary` in `summary.json`.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::sync::Arc;

use dash_scene::{Band, Camera, PlotCamera, Range64, Size64, Theme, Viewport, VisSpec, build};
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};
use serde_json::Value;

/// Numbers compared as f64 (serde_json keeps 1 and 1.0 apart).
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

#[test]
fn summaries_match_ts() {
    let rows = fixture::load("summary.json");
    assert_eq!(rows.len(), 4, "summary.json has {} entries", rows.len());
    for r in &rows {
        let id = r["id"].as_str().unwrap_or_default();
        let Some(which) = GalleryLine::ALL.into_iter().find(|g| g.id() == id) else {
            panic!("unknown entry {id}");
        };
        let (chunk, spec) = gallery_line(which, GALLERY_WINDOW);
        let window = Range64::from(GALLERY_WINDOW);
        let spec = VisSpec::Line(spec);
        let v = Viewport {
            id: 0,
            frame_id: None,
            css: Size64 {
                w: 1118.0,
                h: 240.0,
            },
            dpr: 1.0,
            theme: Theme::Dark,
            camera: Camera::Plot2D(PlotCamera::idle(window, &spec)),
            spec,
            data: Some(Arc::new(chunk)),
            band: Band::Measure,
            events: std::sync::Arc::from([]),
            selection: Default::default(),
        };
        let got = build(&v)
            .1
            .map(|s| serde_json::to_value(s).unwrap_or_default());
        assert_eq!(got.as_ref().map(norm), Some(norm(&r["summary"])), "{id}");
    }
    let line600 = rows
        .iter()
        .find(|r| r["id"] == "line-600")
        .map(|r| &r["summary"]);
    assert_eq!(
        line600.map(|s| (s["seriesTotal"].clone(), s["seriesShown"].clone())),
        Some((serde_json::json!(600), serde_json::json!(500)))
    );
}
