//! `Chunk`: the engine's in-memory form of one query result (plan #68 §3.6).

/// Identifies a chunk for caches (encoded values, column ranges).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChunkId(pub u64);

/// The time axis of a chunk.
#[derive(Clone, Debug, PartialEq)]
pub enum TimeAxis {
    /// t_k = start_ms + k·step_ms, k < len, identical for every series (metric_matrix.grid/1).
    Grid {
        start_ms: i64,
        step_ms: i64,
        len: u32,
    },
    /// Per-sample ms, parallel to `values`, strictly increasing per series.
    Explicit { t_ms: Vec<f64> },
}

/// One series' identity. Labels are shared and immutable: built once per series by the
/// decoder, then only `Arc`-cloned into every chunk that references the series.
#[derive(Clone, Debug, PartialEq)]
pub struct SeriesMeta {
    pub key_hash: u64,
    pub labels: std::sync::Arc<[(String, String)]>,
}

/// An immutable chunk (T03-007).
#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub id: ChunkId,
    pub time: TimeAxis,
    pub series: Vec<SeriesMeta>,
    /// Series s is values[offsets[s]..offsets[s+1]]; len = series + 1.
    pub offsets: Vec<u32>,
    /// f64 originals (T04 §5.7); null and NaN/±Inf are all gaps when drawn.
    pub values: Vec<f64>,
    /// Arrow validity, 1 = present (Part B); None = all present. Kept for tooltips (#69).
    pub present: Option<Vec<u64>>,
    /// Finite (min, max) over all values; None when there is no finite value.
    pub finite: Option<(f64, f64)>,
}

/// Why `ChunkBuilder::push_series` rejected a series.
#[derive(Debug, PartialEq, thiserror::Error)]
pub enum ChunkError {
    #[error("length")]
    Length,
    #[error("order")]
    Order,
    #[error("too many samples")]
    TooLarge,
}

/// The most samples in one chunk.
pub const MAX_SAMPLES: usize = 1 << 31;

/// Builds a `Chunk` series by series.
#[derive(Debug)]
pub struct ChunkBuilder {
    chunk: Chunk,
}

impl ChunkBuilder {
    pub fn grid(id: ChunkId, start_ms: i64, step_ms: i64, len: u32) -> Self {
        Self::with_time(
            id,
            TimeAxis::Grid {
                start_ms,
                step_ms,
                len,
            },
        )
    }

    pub fn explicit(id: ChunkId) -> Self {
        Self::with_time(id, TimeAxis::Explicit { t_ms: Vec::new() })
    }

    fn with_time(id: ChunkId, time: TimeAxis) -> Self {
        Self {
            chunk: Chunk {
                id,
                time,
                series: Vec::new(),
                offsets: vec![0],
                values: Vec::new(),
                present: None,
                finite: None,
            },
        }
    }

    /// Appends one series. Rejects a length mismatch (grid: `len` values; explicit: as many
    /// timestamps as values), non-increasing or non-finite timestamps, and a chunk above 2³¹
    /// samples (so `G + total` fits the u32 counters of the decimation passes).
    pub fn push_series(
        &mut self,
        meta: SeriesMeta,
        t_ms: Option<&[f64]>,
        values: &[f64],
    ) -> Result<(), ChunkError> {
        match (&mut self.chunk.time, t_ms) {
            (TimeAxis::Grid { len, .. }, None) => {
                if values.len() != *len as usize {
                    return Err(ChunkError::Length);
                }
            }
            (TimeAxis::Explicit { .. }, Some(ts)) => {
                if ts.len() != values.len() {
                    return Err(ChunkError::Length);
                }
                let increasing =
                    ts.iter().all(|t| t.is_finite()) && ts.windows(2).all(|w| w[1] > w[0]);
                if !increasing {
                    return Err(ChunkError::Order);
                }
            }
            _ => return Err(ChunkError::Length),
        }
        let total = self.chunk.values.len() + values.len();
        if total > MAX_SAMPLES {
            return Err(ChunkError::TooLarge);
        }
        if let (TimeAxis::Explicit { t_ms: all }, Some(ts)) = (&mut self.chunk.time, t_ms) {
            all.extend_from_slice(ts);
        }
        for v in values.iter().filter(|v| v.is_finite()) {
            self.chunk.finite = Some(match self.chunk.finite {
                None => (*v, *v),
                Some((lo, hi)) => (lo.min(*v), hi.max(*v)),
            });
        }
        self.chunk.values.extend_from_slice(values);
        // total ≤ 2³¹, so it fits u32.
        self.chunk.offsets.push(total as u32);
        self.chunk.series.push(meta);
        Ok(())
    }

    pub fn finish(self) -> Chunk {
        self.chunk
    }
}

impl Chunk {
    /// Number of series.
    pub fn len(&self) -> usize {
        self.series.len()
    }

    pub fn is_empty(&self) -> bool {
        self.series.is_empty()
    }

    /// Timestamp (ms) of sample `k` of series `s`.
    pub fn t_ms(&self, s: usize, k: usize) -> f64 {
        match &self.time {
            TimeAxis::Grid {
                start_ms, step_ms, ..
            } => (start_ms + step_ms * k as i64) as f64,
            TimeAxis::Explicit { t_ms } => t_ms[self.offsets[s] as usize + k],
        }
    }

    /// The values of series `s`.
    pub fn series_values(&self, s: usize) -> &[f64] {
        &self.values[self.offsets[s] as usize..self.offsets[s + 1] as usize]
    }
}
