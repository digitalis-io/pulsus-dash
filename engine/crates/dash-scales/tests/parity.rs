//! unit:layout-parity, ticks (plan #68 §5): `value_ticks` equals TS `valueTicks` bit for bit on
//! `ticks.json`.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use dash_scales::value_ticks;

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
        match value_ticks(min, max, h, l, base) {
            Some(vt) => {
                let ok = fixture::same(vt.min, fixture::num(&want["min"]))
                    && fixture::same(vt.max, fixture::num(&want["max"]))
                    && vt.ticks.len() == wt.len()
                    && vt.ticks.iter().zip(&wt).all(|(a, b)| fixture::same(*a, *b));
                if !ok {
                    bad.push(format!("{min:e}..{max:e} h{h} b{base}: {vt:?} != {want}"));
                }
            }
            None => bad.push(format!("{min:e}..{max:e} h{h} b{base}: None")),
        }
    }
    assert!(bad.is_empty(), "{} mismatches, first: {:?}", bad.len(), &bad[..bad.len().min(5)]);
}
