//! unit:layout-parity, ticks (plan #68 §5, #97): `value_ticks`, falling back to `extreme_ticks`,
//! equals TS `valueTicks` bit for bit on `ticks.json`, and numerically on `ticks-extreme.json`.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use dash_scales::js_pow::{pow_base, pow10};
use dash_scales::{extreme_ticks, value_ticks};

#[test]
fn value_ticks_match_ts() {
    let rows = fixture::load("ticks.json");
    assert!(rows.len() >= 500, "ticks.json has {} rows", rows.len());
    let mut bad = Vec::new();
    for r in &rows {
        let (min, max) = (fixture::num(&r["min"]), fixture::num(&r["max"]));
        let (h, l) = (fixture::num(&r["height"]), fixture::num(&r["label"]));
        let base = r["base"].as_u64().unwrap_or(0) as u32;
        let want = &r["out"];
        let wt = fixture::nums(&want["ticks"]);
        let vt = value_ticks(min, max, h, l, base).unwrap_or_else(|| extreme_ticks(min, max, h, l));
        let ok = fixture::same(vt.min, fixture::num(&want["min"]))
            && fixture::same(vt.max, fixture::num(&want["max"]))
            && vt.ticks.len() == wt.len()
            && vt.ticks.iter().zip(&wt).all(|(a, b)| fixture::same(*a, *b));
        if !ok {
            bad.push(format!("{min:e}..{max:e} h{h} b{base}: {vt:?} != {want}"));
        }
    }
    assert!(
        bad.is_empty(),
        "{} mismatches, first: {:?}",
        bad.len(),
        &bad[..bad.len().min(5)]
    );
}

/// #97: every row of `ticks-extreme.json` (fixed, fallback-fit, edge and seeded rows) through its
/// `fn`, under numeric equality (JSON writes −0 as 0).
#[test]
fn value_ticks_or_extreme_match_ts() {
    let rows = fixture::load("ticks-extreme.json");
    assert_eq!(
        rows.len(),
        397,
        "ticks-extreme.json has {} rows",
        rows.len()
    );
    let eq = |a: f64, b: f64| a == b || (a.is_nan() && b.is_nan());
    let mut bad = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let (min, max) = (fixture::num(&r["min"]), fixture::num(&r["max"]));
        let (h, l) = (fixture::num(&r["height"]), fixture::num(&r["label"]));
        let base = r["base"].as_u64().unwrap_or(0) as u32;
        let want = &r["out"];
        let wt = fixture::nums(&want["ticks"]);
        let vt = match r["fn"].as_str() {
            Some("extremeTicks") => extreme_ticks(min, max, h, l),
            Some("valueTicks") => {
                value_ticks(min, max, h, l, base).unwrap_or_else(|| extreme_ticks(min, max, h, l))
            }
            other => panic!("row {i}: unknown fn {other:?}"),
        };
        let ok = eq(vt.min, fixture::num(&want["min"]))
            && eq(vt.max, fixture::num(&want["max"]))
            && vt.ticks.len() == wt.len()
            && vt.ticks.iter().zip(&wt).all(|(a, b)| eq(*a, *b));
        if !ok {
            bad.push(format!(
                "row {i} {min:e}..{max:e} h{h} b{base}: {vt:?} != {want}"
            ));
        }
    }
    assert!(
        bad.is_empty(),
        "{} mismatches, first: {:?}",
        bad.len(),
        &bad[..bad.len().min(10)]
    );
}

/// The integer powers `valueTicks` takes, as the JS engine computes them (`js_pow`).
#[test]
fn powers_match_the_js_engine() {
    let rows = fixture::load("pow.json");
    assert_eq!(
        rows.len(),
        649 + 2 * 103,
        "pow.json has {} rows",
        rows.len()
    );
    for r in &rows {
        let (base, p, v) = (
            r["base"].as_u64().unwrap_or(0) as u32,
            fixture::num(&r["p"]),
            fixture::num(&r["v"]),
        );
        let got = if base == 10 {
            pow10(p)
        } else {
            pow_base(base, p).unwrap_or(f64::NAN)
        };
        assert!(fixture::same(got, v), "{base} ** {p}: {got:e} vs {v:e}");
    }
}
