//! unit:synth-parity (plan #68 §5, T02-030 corpus): the gallery's line data equals the TS
//! `synthLines` on the sampled points of `synth.json`, and the series keys are equal.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use dash_wire::TimeAxis;
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};

#[test]
fn gallery_lines_match_ts() {
    let rows = fixture::load("synth.json");
    assert_eq!(rows.len(), 4, "synth.json has {} entries", rows.len());
    for r in &rows {
        let id = r["id"].as_str().unwrap_or_default();
        let Some(which) = GalleryLine::ALL.into_iter().find(|g| g.id() == id) else {
            panic!("unknown entry {id}");
        };
        let (chunk, _) = gallery_line(which, GALLERY_WINDOW);
        let keys: Vec<String> = chunk.series.iter().map(|s| format!("{:016x}", s.key_hash)).collect();
        let want: Vec<String> = r["keys"]
            .as_array()
            .map(|a| a.iter().map(|k| k.as_str().unwrap_or_default().to_owned()).collect())
            .unwrap_or_default();
        assert_eq!(keys, want, "{id}: keys");
        let samples = r["samples"].as_array().cloned().unwrap_or_default();
        assert_eq!(samples.len(), 64, "{id}");
        for s in &samples {
            let (j, k) = (s["j"].as_u64().unwrap_or(0) as usize, s["k"].as_u64().unwrap_or(0) as usize);
            let (t, v) = (fixture::num(&s["t"]), fixture::num(&s["v"]));
            let TimeAxis::Grid { start_ms, step_ms, .. } = chunk.time else {
                panic!("{id}: not a grid chunk");
            };
            assert_eq!((start_ms + step_ms * k as i64) as f64, t, "{id} j{j} k{k}: t");
            let got = chunk.values[chunk.offsets[j] as usize + k];
            if v.is_nan() {
                assert!(got.is_nan(), "{id} j{j} k{k}: {got} is not NaN");
            } else {
                assert!(((got - v) / v).abs() <= 1e-9, "{id} j{j} k{k}: {got} vs {v}");
            }
        }
    }
}
