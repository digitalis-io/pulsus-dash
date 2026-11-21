//! unit:columns-parity (plan #68 §5, A.15.2): CPU `decimate` reproduces TS `lineColumns` per
//! column: count class, `first`, `last`, every run in order (inline and spilled) and the break flag.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;
mod common;

use common::*;
use dash_scales::decimate::ColOut;

const GAP_LEAD: u32 = 1 << 3;
const GAP_INNER: u32 = 1 << 4;
const GAP_TRAIL: u32 = 1 << 5;
const ALL_GAP: u32 = 1 << 6;

#[test]
fn decimate_matches_line_columns() {
    let rows = fixture::load("columns.json");
    assert!(rows.len() >= 300, "columns.json has {} rows", rows.len());
    let mut multi_run_columns = 0;
    for (ri, r) in rows.iter().enumerate() {
        let ts = fixture::nums(&r["ts"]);
        let vs = fixture::nums(&r["vs"]);
        let (from, to) = (fixture::num(&r["w"]["fromMs"]), fixture::num(&r["w"]["toMs"]));
        let n = fixture::num(&r["width"]).floor().max(0.0) as u32;
        let chunk = explicit(&[(ts, vs)]);
        let enc = encoding_for(&chunk);
        let p = prepare(&chunk, &enc, from, to, n);
        let d = run(&chunk, &p);
        let cols = r["columns"].as_array().cloned().unwrap_or_default();
        assert_eq!(cols.len(), n as usize, "row {ri}: column count");
        assert_eq!(d.cols.len(), n as usize, "row {ri}: ColOut count");
        let mut pending = false;
        for (c, want) in cols.iter().enumerate() {
            let got: &ColOut = &d.cols[c];
            let class = got.meta & 3;
            if want.is_null() {
                assert_eq!(class, 0, "row {ri} col {c}: class");
                if got.meta & ALL_GAP != 0 {
                    pending = true;
                }
                continue;
            }
            let count = want["count"].as_u64().unwrap_or(0);
            assert_eq!(class as u64, count.min(2), "row {ri} col {c}: class");
            assert_eq!(got.last.to_bits(), enc.encode(fixture::num(&want["last"])), "row {ri} col {c}: last");
            assert_eq!(got.first.to_bits(), enc.encode(fixture::num(&want["first"])), "row {ri} col {c}: first");
            let runs = want["runs"].as_array().cloned().unwrap_or_default();
            assert_eq!(got.n_runs as usize, runs.len(), "row {ri} col {c}: n_runs");
            let brk = pending || got.meta & (GAP_LEAD | GAP_INNER) != 0;
            assert_eq!(brk, want["breakBefore"].as_bool().unwrap_or(false), "row {ri} col {c}: break");
            pending = got.meta & GAP_TRAIL != 0;
            if count >= 2 {
                if runs.len() > 2 {
                    multi_run_columns += 1;
                }
                let spans: Vec<[u32; 2]> = d
                    .instances
                    .iter()
                    .filter(|i| column(i) == c as u32 && kind(i) != KIND_SEGMENT)
                    .map(|i| [i.va.to_bits(), i.vb.to_bits()])
                    .collect();
                let want_spans: Vec<[u32; 2]> = runs
                    .iter()
                    .map(|run| [enc.encode(fixture::num(&run["max"])), enc.encode(fixture::num(&run["min"]))])
                    .collect();
                assert_eq!(spans, want_spans, "row {ri} col {c}: spans");
            }
        }
    }
    assert!(multi_run_columns > 0, "the corpus has no column with more than two runs");
}
