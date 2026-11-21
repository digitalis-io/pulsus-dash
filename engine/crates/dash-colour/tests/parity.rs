//! unit:colour-hash (plan #68 §5, T02-005, VL-002): `series_colour_index` equals TS
//! `seriesColourIndex` on `palette.json`.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use dash_colour::series_colour_index;

#[test]
fn series_colour_index_matches_ts() {
    let rows = fixture::load("palette.json");
    assert!(rows.len() >= 200, "palette.json has {} rows", rows.len());
    for r in &rows {
        let key = r["key"].as_str().unwrap_or_default();
        let hash = u64::from_str_radix(key, 16).unwrap_or(u64::MAX);
        let labels: Vec<(String, String)> = r["labels"]
            .as_object()
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned())).collect())
            .unwrap_or_default();
        let want = r["index"].as_u64().unwrap_or(99);
        assert_eq!(u64::from(series_colour_index(hash, &labels)), want, "{key} {labels:?}");
    }
}
