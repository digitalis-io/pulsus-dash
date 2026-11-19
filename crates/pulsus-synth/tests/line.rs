#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Line presets (T05-010): plan #24 tests 1–3.

use pulsus_synth::SplitMix64;
use pulsus_synth::line::{LINE_1E8, LINE_GAPPY, LINE_SMALL, LinePreset, LineStats, series, stats};

const GOLDEN: &str = "tests/golden/line-stats.toml";
const PRESETS: [LinePreset; 3] = [LINE_1E8, LINE_SMALL, LINE_GAPPY];

#[test]
fn synth_line_deterministic() {
    let a = series(24, &LINE_SMALL, 3);
    let b = series(24, &LINE_SMALL, 3);
    assert_eq!(a, b);
    assert_eq!(a.values.len(), 50_000);
    assert_eq!(a.valid.len(), 50_000);
    assert_ne!(series(25, &LINE_SMALL, 3), a);
    assert_eq!(SplitMix64::new(0).next_u64(), 0xE220_A839_7B1D_CDAF);
}

/// The gap ranges of series `id`, recomputed from the documented draw order.
fn gaps(seed: u64, p: &LinePreset, id: u32) -> Vec<(u32, u32)> {
    let mut rng = SplitMix64::new(seed ^ (u64::from(id) + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    rng.next_f64();
    rng.next_f64();
    let n = u64::from(p.points);
    (0..rng.next_u64() % 4)
        .map(|_| {
            let start = rng.next_u64() % n;
            let len = 1000 + rng.next_u64() % 4001;
            (start as u32, (start + len).min(n) as u32)
        })
        .collect()
}

#[test]
fn synth_line_invariants() {
    for id in 0..LINE_SMALL.series {
        let s = series(24, &LINE_SMALL, id);
        let g = gaps(24, &LINE_SMALL, id);
        assert!(g.len() <= 3);
        for &(a, b) in &g {
            assert!(b - a <= 5000 && (b - a >= 1000 || b == LINE_SMALL.points));
        }
        for k in 0..LINE_SMALL.points {
            let in_gap = g.iter().any(|&(a, b)| (a..b).contains(&k));
            assert_eq!(s.valid[k as usize], !in_gap, "series {id} k {k}");
        }
        assert!(s.values.iter().all(|v| v.is_finite()));
    }
    for id in [0, 31, 63] {
        let s = series(24, &LINE_GAPPY, id);
        let n = LINE_GAPPY.points as usize;
        assert_eq!(s.values.len(), n);
        for k in (1..n - 1).filter(|k| k % 997 == 498) {
            assert!(s.valid[k], "series {id} k {k} valid");
            assert!(
                !s.valid[k - 1] && !s.valid[k + 1],
                "series {id} k {k} isolated"
            );
        }
        for k in 0..n {
            if s.valid[k] {
                assert!(s.values[k].is_finite());
            } else {
                assert_eq!(s.values[k], 0.0);
            }
        }
        assert!(s.valid.iter().filter(|v| !**v).count() > n / 100);
    }
}

fn hex(v: u64) -> String {
    format!("0x{v:016x}")
}

/// The golden file's text for `rows`.
fn render(rows: &[(LinePreset, LineStats)]) -> String {
    let mut out = String::from(
        "# Seed-24 statistics of the pulsus-synth line presets (T05-010).\n# Written by `cargo test -p pulsus-synth --release -- --ignored write_line_stats`.\n",
    );
    for (p, s) in rows {
        out.push_str(&format!(
            "\n[{}]\nseed = 24\nseries = {}\npoints = {}\nnulls = {}\nspikes = {}\nfnv = [\"{}\", \"{}\", \"{}\"]\n",
            p.name,
            s.series,
            s.points,
            s.nulls,
            s.spikes,
            hex(s.fnv[0]),
            hex(s.fnv[1]),
            hex(s.fnv[2])
        ));
    }
    out
}

#[test]
fn synth_line_golden_stats() {
    let text = std::fs::read_to_string(GOLDEN).expect("tests/golden/line-stats.toml");
    let t: toml::Table = text.parse().unwrap();
    for p in PRESETS {
        let s = stats(24, &p);
        let g = t[p.name].as_table().unwrap();
        assert_eq!(g["seed"].as_integer(), Some(24));
        assert_eq!(
            g["series"].as_integer(),
            Some(i64::from(s.series)),
            "{}",
            p.name
        );
        assert_eq!(
            g["points"].as_integer(),
            Some(s.points as i64),
            "{}",
            p.name
        );
        assert_eq!(g["nulls"].as_integer(), Some(s.nulls as i64), "{}", p.name);
        assert_eq!(
            g["spikes"].as_integer(),
            Some(s.spikes as i64),
            "{}",
            p.name
        );
        let fnv: Vec<&str> = g["fnv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(fnv, s.fnv.map(hex).to_vec(), "{}", p.name);
    }
    let points: Vec<i64> = PRESETS
        .iter()
        .map(|p| t[p.name]["points"].as_integer().unwrap())
        .collect();
    assert_eq!(points, vec![100_000_000, 400_000, 12_800_000]);
}

/// Regenerates the golden file (run deliberately; the result is committed).
#[test]
#[ignore = "writes tests/golden/line-stats.toml"]
fn write_line_stats() {
    let rows: Vec<(LinePreset, LineStats)> = PRESETS.iter().map(|p| (*p, stats(24, p))).collect();
    std::fs::write(GOLDEN, render(&rows)).unwrap();
}
