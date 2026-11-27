//! unit:layout-event-band (plan #68 C2c1 §5 `layout_event_band`; ADR-0023): `layout_plot` and
//! `value_axis` with the event label band equal TS `layoutPlot(…, eventBand)` and draw.ts's
//! `valueAxis` on every `layer.json` frame (the band is reserved once the frame holds an event, in
//! view or not); `layout.json`, unchanged, still holds with `event_band` 0.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use dash_axes::{Band, PlotRect, VisKind, event_band, layout_plot, value_axis};
use dash_scales::Range64;
use dash_units::Unit;
use serde_json::Value;

fn plot_of(v: &Value) -> PlotRect {
    PlotRect {
        x: fixture::num(&v["x"]),
        y: fixture::num(&v["y"]),
        width: fixture::num(&v["width"]),
        height: fixture::num(&v["height"]),
    }
}

#[test]
fn layout_event_band() {
    let rows = fixture::load("layer.json");
    assert!(!rows.is_empty(), "layer.json is empty");
    let mut banded = 0;
    for r in &rows {
        let case = r["case"].as_str().unwrap_or_default();
        let spec: Value =
            serde_json::from_str(r["spec"].as_str().unwrap_or_default()).unwrap_or(Value::Null);
        let unit: Unit = serde_json::from_value(spec["unit"].clone()).unwrap_or(Unit::Percent);
        let manual = spec
            .get("valueRange")
            .filter(|m| !m.is_null())
            .map(|m| Range64 {
                lo: fixture::num(&m["min"]),
                hi: fixture::num(&m["max"]),
            });
        let n_events = r["events"].as_array().map_or(0, Vec::len);
        for f in r["frames"].as_array().into_iter().flatten() {
            let what = format!("{case} {}×{}", f["w"], f["h"]);
            let (w, h) = (fixture::num(&f["w"]), fixture::num(&f["h"]));
            let eb = fixture::num(&f["eventBand"]);
            assert_eq!(event_band(VisKind::Line, n_events), eb, "{what}: band");
            assert_eq!(event_band(VisKind::Stat, n_events), 0.0, "{what}: stat");
            if eb > 0.0 {
                banded += 1;
            }
            let label_w = fixture::num(&f["labelW"]);
            assert_eq!(
                layout_plot(VisKind::Line, w, h, label_w, eb),
                plot_of(&f["layoutPlot"]),
                "{what}: layout_plot"
            );
            let (lo, hi) = (
                fixture::num(&f["axisIn"]["min"]),
                fixture::num(&f["axisIn"]["max"]),
            );
            let ax = value_axis(
                VisKind::Line,
                w,
                h,
                lo,
                hi,
                manual,
                &unit,
                Band::Measure,
                eb,
            );
            assert_eq!(ax.plot, plot_of(&f["plot"]), "{what}: plot");
            assert!(
                fixture::same(ax.domain.lo, fixture::num(&f["domain"]["min"]))
                    && fixture::same(ax.domain.hi, fixture::num(&f["domain"]["max"])),
                "{what}: domain {:?} vs {}",
                ax.domain,
                f["domain"]
            );
            assert_eq!(ax.band_w, label_w, "{what}: band width");
            let labels: Vec<String> = f["labels"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| s.as_str().unwrap_or_default().to_owned())
                .collect();
            let got: Vec<String> = ax.labels.iter().map(|l| l.text.clone()).collect();
            assert_eq!(got, labels, "{what}: labels");
        }
    }
    assert!(banded >= 20, "{banded} frames with the event band");
    // `layout.json` is not regenerated: its plots with no band.
    let rows = fixture::load("layout.json");
    assert!(rows.len() >= 304, "layout.json has {} rows", rows.len());
    for (i, r) in rows.iter().enumerate() {
        let unit: Unit = serde_json::from_value(r["unit"].clone()).unwrap_or(Unit::Percent);
        let (w, h) = (fixture::num(&r["w"]), fixture::num(&r["h"]));
        let (min, max) = (fixture::num(&r["min"]), fixture::num(&r["max"]));
        let ax = value_axis(
            VisKind::Line,
            w,
            h,
            min,
            max,
            None,
            &unit,
            Band::Measure,
            0.0,
        );
        assert_eq!(ax.plot, plot_of(&r["plot"]), "layout.json row {i}");
    }
}

/// #290 §4.5 (F5): `layout.json`'s appended rows, one per new unit at 1118 × 240 over
/// [0, 3 145 728]: each unit parses, and plot, band and labels equal TS.
#[test]
fn layout_new_units() {
    let rows = fixture::load("layout.json");
    let new: Vec<&Value> = rows
        .iter()
        .filter(|r| r["id"].as_str().is_some_and(|id| id.starts_with("unit-")))
        .collect();
    assert_eq!(new.len(), 10, "layout.json rows of the new units");
    for r in new {
        let what = r["id"].as_str().unwrap_or_default();
        let unit: Unit = match serde_json::from_value(r["unit"].clone()) {
            Ok(u) => u,
            Err(e) => panic!("{what}: unit {}: {e}", r["unit"]),
        };
        let (w, h) = (fixture::num(&r["w"]), fixture::num(&r["h"]));
        let (min, max) = (fixture::num(&r["min"]), fixture::num(&r["max"]));
        let ax = value_axis(
            VisKind::Line,
            w,
            h,
            min,
            max,
            None,
            &unit,
            Band::Measure,
            0.0,
        );
        assert_eq!(ax.plot, plot_of(&r["plot"]), "{what}: plot");
        let labels: Vec<String> = r["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| s.as_str().unwrap_or_default().to_owned())
            .collect();
        let got: Vec<String> = ax.labels.iter().map(|l| l.text.clone()).collect();
        assert_eq!(got, labels, "{what}: labels");
    }
}
