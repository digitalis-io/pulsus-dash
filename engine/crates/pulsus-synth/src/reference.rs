//! The decimation reference fixtures of plan #68 A.4 and A.15.2 (F1a–F6): seeded data on a
//! 1 000-column window of 1 000 s, so column c holds t ∈ [c·1000, (c+1)·1000) ms.

use dash_scales::Range64;
use dash_wire::{Chunk, ChunkBuilder, ChunkError, ChunkId, SeriesMeta};

use crate::hash01;

/// The window of every fixture, ms.
pub const WINDOW: (f64, f64) = (0.0, 1_000_000.0);
/// Columns of the fixture plot.
pub const COLUMNS: u32 = 1000;

/// One fixture: data and its manual axis (None = auto).
#[derive(Clone, Debug)]
pub struct RefFixture {
    pub name: &'static str,
    pub chunk: Chunk,
    pub manual: Option<Range64>,
}

fn meta(s: usize) -> SeriesMeta {
    SeriesMeta {
        key_hash: s as u64,
        labels: vec![("s".into(), s.to_string())].into(),
    }
}

fn grid(
    id: u64,
    series: usize,
    per_series: u32,
    value: impl Fn(usize, u32) -> f64,
) -> Result<Chunk, ChunkError> {
    let step = (WINDOW.1 / f64::from(per_series)) as i64;
    let mut b = ChunkBuilder::grid(ChunkId(id), 0, step, per_series);
    for s in 0..series {
        let vs: Vec<f64> = (0..per_series).map(|k| value(s, k)).collect();
        b.push_series(meta(s), None, &vs)?;
    }
    Ok(b.finish())
}

/// Explicit series from per-column sample lists; samples spread evenly inside their column.
fn columns(id: u64, series: &[Vec<(u32, Vec<f64>)>]) -> Result<Chunk, ChunkError> {
    let mut b = ChunkBuilder::explicit(ChunkId(id));
    for (s, cols) in series.iter().enumerate() {
        let (mut ts, mut vs) = (Vec::new(), Vec::new());
        for (c, samples) in cols {
            let len = samples.len() as f64;
            for (i, v) in samples.iter().enumerate() {
                ts.push(f64::from(*c) * 1000.0 + (i as f64 + 0.5) * 1000.0 / len);
                vs.push(*v);
            }
        }
        b.push_series(meta(s), Some(&ts), &vs)?;
    }
    Ok(b.finish())
}

fn slope(s: usize, k: u32) -> f64 {
    let p = 37.0 + 40.0 * s as f64;
    1000.0 * (2.0 * std::f64::consts::PI * f64::from(k) / p).sin() + 10.0 * s as f64
}

/// F1a: 100 series of slopes, no NaN (F1c: `series` 1 000 × 10⁵ for the nightly volume).
pub fn f1a(series: usize, per_series: u32) -> Result<RefFixture, ChunkError> {
    Ok(RefFixture {
        name: "F1a",
        chunk: grid(0xF1A, series, per_series, slope)?,
        manual: None,
    })
}

/// F1b: 8 series, one sample every 7 columns, alternating 0 and 100 + s.
pub fn f1b() -> Result<RefFixture, ChunkError> {
    let series: Vec<Vec<(u32, Vec<f64>)>> = (0..8)
        .map(|s| {
            (0..143u32)
                .map(|k| (7 * k, vec![if k % 2 == 0 { 0.0 } else { 100.0 + s as f64 }]))
                .collect()
        })
        .collect();
    Ok(RefFixture {
        name: "F1b",
        chunk: columns(0xF1B, &series)?,
        manual: None,
    })
}

/// F2: 100 series with seeded NaN bursts (density ≈ 0.3, bursts of 1–20 samples).
pub fn f2(series: usize, per_series: u32) -> Result<RefFixture, ChunkError> {
    let mut gaps = vec![false; series * per_series as usize];
    for s in 0..series {
        let mut k = 0u32;
        while k < per_series {
            if hash01(&[0xF2, s as i64, i64::from(k)]) < 0.0408 {
                let len = 1 + (20.0 * hash01(&[0xF2, s as i64, i64::from(k), 1])) as u32;
                for b in k..(k + len).min(per_series) {
                    gaps[s * per_series as usize + b as usize] = true;
                }
                k += len + 1;
            } else {
                k += 1;
            }
        }
    }
    let chunk = grid(0xF2, series, per_series, |s, k| {
        if gaps[s * per_series as usize + k as usize] {
            f64::NAN
        } else {
            slope(s, k)
        }
    })?;
    Ok(RefFixture {
        name: "F2",
        chunk,
        manual: None,
    })
}

/// F3: isolated runs: a 3-run column 300 and a 5-run column 500, all-NaN neighbours.
pub fn f3() -> Result<RefFixture, ChunkError> {
    let nan = f64::NAN;
    let cols = vec![
        (299, vec![nan, nan, nan]),
        (300, vec![10.0, 10.2, nan, 50.0, 50.3, nan, 90.0, 89.8]),
        (301, vec![nan, nan, nan]),
        (499, vec![nan, nan, nan]),
        (
            500,
            vec![
                10.0, nan, 30.0, nan, 50.0, nan, nan, 70.0, 70.1, nan, 90.0, 90.2, 90.1,
            ],
        ),
        (501, vec![nan, nan, nan]),
    ];
    Ok(RefFixture {
        name: "F3",
        chunk: columns(0xF3, &[cols])?,
        manual: Some(Range64 { lo: 0.0, hi: 100.0 }),
    })
}

const UNIT: Range64 = Range64 { lo: 0.0, hi: 1.0 };

/// F4a: one far segment from −1e300 (column 0) to 2e300 (column 900) on [0, 1].
pub fn f4a() -> Result<RefFixture, ChunkError> {
    let chunk = columns(0xF4A, &[vec![(0, vec![-1e300]), (900, vec![2e300])]])?;
    Ok(RefFixture {
        name: "F4a",
        chunk,
        manual: Some(UNIT),
    })
}

/// F4b: one in-range segment from 0.2 (column 100) to 0.7 (column 800) on [0, 1].
pub fn f4b() -> Result<RefFixture, ChunkError> {
    let chunk = columns(0xF4B, &[vec![(100, vec![0.2]), (800, vec![0.7])]])?;
    Ok(RefFixture {
        name: "F4b",
        chunk,
        manual: Some(UNIT),
    })
}

/// F5: the first sample decides the join: column 300 `0.1`, column 700 `[0.9, 0.5]`.
pub fn f5() -> Result<RefFixture, ChunkError> {
    let chunk = columns(0xF5, &[vec![(300, vec![0.1]), (700, vec![0.9, 0.5])]])?;
    Ok(RefFixture {
        name: "F5",
        chunk,
        manual: Some(UNIT),
    })
}

/// F6: a far column with several samples (a far item).
pub fn f6() -> Result<RefFixture, ChunkError> {
    let chunk = columns(
        0xF6,
        &[vec![
            (200, vec![-1e300, 0.5, 0.6]),
            (600, vec![2e300]),
            (800, vec![0.4]),
        ]],
    )?;
    Ok(RefFixture {
        name: "F6",
        chunk,
        manual: Some(UNIT),
    })
}
