//! unit:number-format (plan #68 §5, VL-012): `format_value` equals TS `formatValue` byte for byte
//! on the `format.json` corpus.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use dash_units::{Unit, format_value, js_round, to_precision};

#[test]
fn format_value_matches_ts() {
    let rows = fixture::load("format.json");
    // The 9-unit block and the 10 units of #290 (`NEW_UNITS`), each over the same 2 000 values.
    assert!(rows.len() >= 38_000, "format.json has {} rows", rows.len());
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
    assert!(
        bad.is_empty(),
        "{} mismatches, first: {:?}",
        bad.len(),
        &bad[..bad.len().min(10)]
    );
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

/// T21-013: a converted value c ≥ 1e21 or 0 < c < 1e−12 takes the exponent form plus the base
/// tail; every other output is unchanged (plan #208 §5).
#[test]
fn out_of_range_form() {
    let rps = Unit::Suffix {
        suffix: "rps".into(),
    };
    let ns = Unit::Time {
        base: dash_units::TimeBase::Ns,
    };
    for (v, unit, want) in [
        (1e21, &Unit::None, "1e+21"),
        (2.5e22, &Unit::None, "2.5e+22"),
        (1e-4, &ns, "1e-13 s"),
        (1e22, &Unit::Bytes, "1e+22 B"),
        (5e21, &rps, "5e+21 rps"),
        (1e19, &Unit::Percentunit, "1e+21 %"),
        (1e-13, &Unit::None, "1e-13"),
        (-2.5e22, &Unit::None, "-2.5e+22"),
    ] {
        assert_eq!(format_value(v, unit), want, "{v:e} {unit:?}");
    }
}

/// #290 §3.4: the new kinds round-trip as the TS `Unit` JSON; absent fields are their defaults and
/// defaults are not written.
#[test]
fn unit_json_round_trip() {
    for text in [
        r#"{"kind":"bits","prefix":"si","perSecond":true}"#,
        r#"{"kind":"bits","prefix":"iec"}"#,
        r#"{"kind":"bytes"}"#,
        r#"{"kind":"bytes","prefix":"si"}"#,
        r#"{"kind":"bytes","perSecond":true}"#,
        r#"{"kind":"bytes","prefix":"iec","perSecond":true}"#,
        r#"{"kind":"plain"}"#,
        r#"{"kind":"none"}"#,
        r#"{"kind":"suffix","suffix":"req/s"}"#,
    ] {
        let unit: Result<Unit, _> = serde_json::from_str(text);
        let back = unit
            .as_ref()
            .ok()
            .and_then(|u| serde_json::to_string(u).ok());
        assert_eq!(back.as_deref(), Some(text), "{text}: {unit:?}");
    }
}
