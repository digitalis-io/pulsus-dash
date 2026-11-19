//! Line-chart presets (T05-010): seeded random-walk series on a regular grid with gaps, nulls,
//! spikes and isolated samples.

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
pub fn series(_seed: u64, _p: &LinePreset, _id: u32) -> SynthSeries {
    SynthSeries {
        values: Vec::new(),
        valid: Vec::new(),
        spikes: 0,
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

pub fn stats(_seed: u64, _p: &LinePreset) -> LineStats {
    LineStats {
        series: 0,
        points: 0,
        nulls: 0,
        spikes: 0,
        fnv: [0; 3],
    }
}
