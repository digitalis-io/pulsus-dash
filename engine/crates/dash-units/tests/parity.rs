//! unit:number-format (plan #68 §5, VL-012): `format_value` equals TS `formatValue` byte for byte
//! on the `format.json` corpus.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use dash_units::{Unit, format_value, js_round, to_precision};

#[test]
fn format_value_matches_ts() {
    let rows = fixture::load("format.json");
    assert!(rows.len() >= 2000, "format.json has {} rows", rows.len());
    let mut bad = Vec::new();
    for r in &rows {
        let v = fixture::num(&r["v"]);
        let unit: Unit = match serde_json::from_value(r["unit"].clone()) {
            Ok(u) => u,
            Err(e) => panic!("unit {}: {e}", r["unit"]),
        };
        let want = r["out"].as_str().unwrap_or_default();
        let got = format_value(v, &unit);
        if got != want {
            bad.push(format!("{v:e} {unit:?}: {got:?} != {want:?}"));
        }
    }
    assert!(bad.is_empty(), "{} mismatches, first: {:?}", bad.len(), &bad[..bad.len().min(10)]);
}

#[test]
fn ecmascript_rounding_rules() {
    assert_eq!(to_precision(1.125, 3), "1.13");
    assert_eq!(to_precision(99.95, 3), "100");
    assert_eq!(to_precision(1.5e-7, 3), "1.50e-7");
    assert_eq!(to_precision(123456.0, 3), "1.23e+5");
    assert_eq!(js_round(-2.5), -2.0);
    assert_eq!(js_round(2.5), 3.0);
}
