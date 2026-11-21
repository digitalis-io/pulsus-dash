//! `Chunk`: the engine's in-memory form of one query result (plan #68 §3.6).

/// Identifies a chunk for caches (encoded values, column ranges).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ChunkId(pub u64);

/// The time axis of a chunk.
#[derive(Clone, Debug, PartialEq)]
pub enum TimeAxis {
    /// t_k = start_ms + k·step_ms, k < len, identical for every series (metric_matrix.grid/1).
    Grid { start_ms: i64, step_ms: i64, len: u32 },
    /// Per-sample ms, parallel to `values`, strictly increasing per series.
    Explicit { t_ms: Vec<f64> },
}

/// One series' identity.
#[derive(Clone, Debug, PartialEq)]
pub struct SeriesMeta {
    pub key_hash: u64,
    pub labels: Vec<(String, String)>,
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

/// Builds a `Chunk` series by series.
#[derive(Debug)]
pub struct ChunkBuilder {
    chunk: Chunk,
}

impl ChunkBuilder {
    pub fn grid(id: ChunkId, start_ms: i64, step_ms: i64, len: u32) -> Self {
        Self::with_time(id, TimeAxis::Grid { start_ms, step_ms, len })
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

    pub fn push_series(
        &mut self,
        meta: SeriesMeta,
        t_ms: Option<&[f64]>,
        values: &[f64],
    ) -> Result<(), ChunkError> {
        let _ = (meta, t_ms, values);
        Ok(())
    }

    pub fn finish(self) -> Chunk {
        self.chunk
    }
}
