//! unit:layout-parity, plot (plan #68 §5, ADR-0014 §3): `value_axis` equals TS `valueAxis` with
//! `layoutPlot` on `layout.json`: plot rect, tick list (bits) and label texts.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use dash_axes::{Band, PlotRect, VisKind, value_axis};
use dash_units::Unit;

#[test]
fn value_axis_matches_ts() {
    let rows = fixture::load("layout.json");
    assert!(rows.len() >= 304, "layout.json has {} rows", rows.len());
    for (i, r) in rows.iter().enumerate() {
        let kind: VisKind = serde_json::from_value(r["kind"].clone()).unwrap_or(VisKind::Stat);
        let unit: Unit = serde_json::from_value(r["unit"].clone()).unwrap_or(Unit::Percent);
        let (w, h) = (fixture::num(&r["w"]), fixture::num(&r["h"]));
        let (min, max) = (fixture::num(&r["min"]), fixture::num(&r["max"]));
        let manual = r.get("manual").filter(|m| !m.is_null()).map(|m| dash_scales::Range64 {
            lo: fixture::num(&m["min"]),
            hi: fixture::num(&m["max"]),
        });
        let ax = value_axis(kind, w, h, min, max, manual, &unit, Band::Measure);
        let plot: Option<PlotRect> = serde_json::from_value(r["plot"].clone()).ok();
        assert_eq!(Some(ax.plot), plot, "row {i}: plot");
        let ticks = fixture::nums(&r["ticks"]);
        assert_eq!(ax.ticks.len(), ticks.len(), "row {i}: ticks {:?} vs {ticks:?}", ax.ticks);
        for (a, b) in ax.ticks.iter().zip(&ticks) {
            assert!(fixture::same(*a, *b), "row {i}: tick {a:e} vs {b:e}");
        }
        let labels: Vec<String> = r["labels"]
            .as_array()
            .map(|a| a.iter().map(|s| s.as_str().unwrap_or_default().to_owned()).collect())
            .unwrap_or_default();
        let got: Vec<String> = ax.labels.iter().map(|l| l.text.clone()).collect();
        assert_eq!(got, labels, "row {i}: labels");
    }
}
