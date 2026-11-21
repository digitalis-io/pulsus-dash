//! Value ticks, value encoding, column ranges and the CPU decimation reference (plan #68 §3.4).

pub mod decimate;
pub mod encode;

/// A closed f64 interval.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range64 {
    pub lo: f64,
    pub hi: f64,
}

impl From<(f64, f64)> for Range64 {
    fn from((lo, hi): (f64, f64)) -> Self {
        Self { lo, hi }
    }
}

/// Nice value-axis ticks.
#[derive(Clone, Debug, PartialEq)]
pub struct ValueTicks {
    pub min: f64,
    pub max: f64,
    pub ticks: Vec<f64>,
}

/// Port of `canvas2d/valueTicks.ts`, bit-identical on its finite domain (A.3.2). Returns None
/// outside that domain, after 64 loop iterations, or on any non-finite output.
pub fn value_ticks(
    data_min: f64,
    data_max: f64,
    height_px: f64,
    label_height_px: f64,
    base: u32,
) -> Option<ValueTicks> {
    let _ = (data_min, data_max, height_px, label_height_px, base);
    None
}

/// Ticks for ranges `value_ticks` cannot handle (A.3.2).
pub fn extreme_ticks(lo: f64, hi: f64) -> ValueTicks {
    ValueTicks { min: lo, max: hi, ticks: Vec::new() }
}

/// Column of a sample: clamp(floor((t − from)/(to − from) · n), 0, n − 1), in f64.
pub fn column_of(t: f64, from: f64, to: f64, n: u32) -> u32 {
    let _ = (t, from, to, n);
    0
}

/// Sample index ranges per column: entry c..c+1 is column c (len n + 1). One table for a grid
/// chunk (relative to the series start), one per series for explicit timestamps (absolute).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ColumnRanges {
    Grid(Vec<u32>),
    PerSeries { n: u32, table: Vec<u32> },
}

impl ColumnRanges {
    /// Columns per series.
    pub fn n(&self) -> u32 {
        match self {
            Self::Grid(t) => t.len().saturating_sub(1) as u32,
            Self::PerSeries { n, .. } => *n,
        }
    }

    /// Absolute sample range of column `c` of local series `s`, whose values start at `base`.
    pub fn range(&self, s: usize, c: usize, base: u32) -> (u32, u32) {
        match self {
            Self::Grid(t) => (base + t[c], base + t[c + 1]),
            Self::PerSeries { n, table } => {
                let row = s * (*n as usize + 1);
                (table[row + c], table[row + c + 1])
            }
        }
    }

    /// The table as uploaded (u32 words).
    pub fn words(&self) -> &[u32] {
        match self {
            Self::Grid(t) => t,
            Self::PerSeries { table, .. } => table,
        }
    }
}

/// Column ranges of `series` of `chunk` over the window [from, to] in `n` columns.
pub fn column_ranges(
    chunk: &dash_wire::Chunk,
    series: std::ops::Range<u32>,
    from: f64,
    to: f64,
    n: u32,
) -> ColumnRanges {
    let _ = (chunk, series, from, to);
    ColumnRanges::Grid(vec![0; n as usize + 1])
}
