//! Line-chart presets (T05-010): seeded random-walk series on a regular grid with gaps, nulls,
//! spikes and isolated samples.
//!
//! Series `id` draws from `SplitMix64::new(seed ^ (id + 1)·φ)`, in this order: level `10 + 90f`,
//! amplitude `1 + 9f`, gap count `u % 4`, per gap start `u % n` and length `1 000 + u % 4 001`,
//! then per sample `uw`, `us`, `un` (`f` = `next_f64`, `u` = `next_u64`). The value is a daily
//! triangle wave plus a random walk; `us < 1e-4` adds a spike of `20·amp`; `un < null_ratio`
//! makes the sample NULL. Only `+ − × ÷ abs` on `f64`, so wasm32 and native agree bit for bit.

use crate::rng::SplitMix64;

/// A line dataset: `series` × `points` samples, `step_ms` apart from `start_ms`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LinePreset {
    pub name: &'static str,
    pub series: u32,
    pub points: u32,
    pub start_ms: i64,
    pub step_ms: i64,
    /// Probability of a NULL per sample.
    pub null_ratio: f64,
    /// `> 0`: every `k % isolate_every == isolate_every / 2` is an isolated valid sample.
    pub isolate_every: u32,
}

const START_MS: i64 = 1_700_000_000_000;
const STEP_MS: i64 = 10_000;

/// The `bench:frame-line-1e8` volume: 1 000 series × 100 000 points.
pub const LINE_1E8: LinePreset = LinePreset {
    name: "line-1e8",
    series: 1_000,
    points: 100_000,
    start_ms: START_MS,
    step_ms: STEP_MS,
    null_ratio: 0.0,
    isolate_every: 0,
};

/// A small preset for unit and golden tests.
pub const LINE_SMALL: LinePreset = LinePreset {
    name: "line-small",
    series: 8,
    points: 50_000,
    start_ms: START_MS,
    step_ms: STEP_MS,
    null_ratio: 0.0,
    isolate_every: 0,
};

/// Dense random NULLs and isolated samples.
pub const LINE_GAPPY: LinePreset = LinePreset {
    name: "line-gappy",
    series: 64,
    points: 200_000,
    start_ms: START_MS,
    step_ms: STEP_MS,
    null_ratio: 0.02,
    isolate_every: 997,
};

/// `series` × `points` with the [`LINE_1E8`] grid, no NULLs and no isolated samples.
pub fn custom(series: u32, points: u32) -> LinePreset {
    LinePreset {
        name: "line-custom",
        series,
        points,
        ..LINE_1E8
    }
}

/// One generated series; invalid samples hold `0.0`.
#[derive(Clone, Debug, PartialEq)]
pub struct SynthSeries {
    pub values: Vec<f64>,
    pub valid: Vec<bool>,
    /// Valid samples that carry a spike.
    pub spikes: u32,
}

/// Series `id` of preset `p` at `seed`.
pub fn series(seed: u64, p: &LinePreset, id: u32) -> SynthSeries {
    let mut rng = SplitMix64::new(seed ^ (u64::from(id) + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let n = p.points as usize;
    let level = 10.0 + 90.0 * rng.next_f64();
    let amp = 1.0 + 9.0 * rng.next_f64();
    let mut valid = vec![true; n];
    let gaps = rng.next_u64() % 4;
    for _ in 0..gaps {
        let start = rng.next_u64() % u64::from(p.points.max(1));
        let len = 1_000 + rng.next_u64() % 4_001;
        let end = (start + len).min(n as u64);
        for v in &mut valid[start as usize..end as usize] {
            *v = false;
        }
    }
    let period = (86_400_000 / p.step_ms.max(1)).max(1);
    let mut w = 0.0f64;
    let mut values = Vec::with_capacity(n);
    let mut spiked: Vec<usize> = Vec::new();
    for (k, ok) in valid.iter_mut().enumerate() {
        let uw = rng.next_f64();
        let us = rng.next_f64();
        let un = rng.next_f64();
        w += (uw - 0.5) * 0.2 * amp;
        let phase = (k as i64 % period) as f64 / period as f64;
        let tri = (phase * 4.0 - 2.0).abs() - 1.0;
        let mut v = level + amp * tri + w;
        if us < 1e-4 {
            v += 20.0 * amp;
            spiked.push(k);
        }
        if un < p.null_ratio {
            *ok = false;
        }
        values.push(v);
    }
    if p.isolate_every > 0 && n >= 3 {
        let e = p.isolate_every as usize;
        let mut k = e / 2;
        while k < n - 1 {
            if k > 0 {
                valid[k - 1] = false;
                valid[k] = true;
                valid[k + 1] = false;
            }
            k += e;
        }
    }
    for (v, ok) in values.iter_mut().zip(&valid) {
        if !ok {
            *v = 0.0;
        }
    }
    let spikes = spiked.iter().filter(|k| valid[**k]).count() as u32;
    SynthSeries {
        values,
        valid,
        spikes,
    }
}

/// Totals of a preset at a seed, for the committed golden file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineStats {
    pub series: u32,
    pub points: u64,
    pub nulls: u64,
    pub spikes: u64,
    /// FNV-1a 64 of the valid values' bits (little-endian) of series 0, S/2 and S − 1.
    pub fnv: [u64; 3],
}

/// FNV-1a 64 of the valid values' bits (little-endian).
fn fnv(s: &SynthSeries) -> u64 {
    let mut h: u64 = 0xCBF2_9CE4_8422_2325;
    for (v, ok) in s.values.iter().zip(&s.valid) {
        if *ok {
            for b in v.to_bits().to_le_bytes() {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0000_0100_0000_01B3);
            }
        }
    }
    h
}

pub fn stats(seed: u64, p: &LinePreset) -> LineStats {
    let mut out = LineStats {
        series: p.series,
        points: u64::from(p.series) * u64::from(p.points),
        nulls: 0,
        spikes: 0,
        fnv: [0; 3],
    };
    let picks = [0, p.series / 2, p.series.saturating_sub(1)];
    for id in 0..p.series {
        let s = series(seed, p, id);
        out.nulls += s.valid.iter().filter(|v| !**v).count() as u64;
        out.spikes += u64::from(s.spikes);
        for (slot, pick) in picks.iter().enumerate() {
            if *pick == id {
                out.fnv[slot] = fnv(&s);
            }
        }
    }
    out
}
