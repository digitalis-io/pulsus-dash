//! `metric_matrix.grid/1` (T04 §4.3): one row per series, `values` a fixed-size list of the grid's
//! samples. Encoded as Arrow IPC stream messages (T04-002); decoded zero-copy from a [`Slab`]
//! after a whole-message check (T04-010).

use std::sync::Arc;

use crate::slab::Slab;

/// The schema id this module encodes and decodes.
pub const GRID_SCHEMA: &str = "metric_matrix.grid/1";

/// Grid metadata (`dash.*` schema metadata).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GridMeta {
    pub start_ms: i64,
    pub step_ms: i64,
    pub len: u32,
    pub result: String,
    pub source: String,
    pub unit: String,
}

/// Why a message could not be encoded or decoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WireError {
    /// An Arrow IPC error, or a malformed message.
    Ipc(String),
    /// `dash.schema` is not a supported `metric_matrix.grid` version.
    UnknownSchema(String),
    /// A field has the wrong type or size.
    Schema(&'static str),
    /// A `dash.*` metadata key is missing or invalid.
    Metadata(&'static str),
    /// The message is not a schema message.
    NoSchema,
    /// The slab allocation failed.
    Alloc,
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for WireError {}

/// The Arrow schema of `m`.
pub fn grid_schema(_m: &GridMeta) -> arrow_schema::Schema {
    arrow_schema::Schema::empty()
}

/// Rows per record batch: `clamp(1 MiB / (8·len), 1, 64)`.
pub fn series_per_batch(_len: u32) -> u32 {
    0
}

/// Encodes a grid as IPC stream messages.
#[derive(Debug)]
pub struct GridEncoder {}

impl GridEncoder {
    /// The encoder and the schema message.
    pub fn new(_m: &GridMeta) -> Result<(GridEncoder, Vec<u8>), WireError> {
        Err(WireError::Alloc)
    }

    /// One record-batch message of `rows` (values, validity), series ids from `first_id`.
    pub fn batch(
        &mut self,
        _first_id: u32,
        _rows: &[(&[f64], &[bool])],
    ) -> Result<Vec<u8>, WireError> {
        Err(WireError::Alloc)
    }
}

/// One decoded series: views into the slab.
#[derive(Clone, Debug, PartialEq)]
pub struct GridSeries {
    pub series_id: u32,
    pub values: arrow_buffer::ScalarBuffer<f64>,
    pub validity: Option<arrow_buffer::NullBuffer>,
}

impl GridSeries {
    pub fn is_valid(&self, _k: usize) -> bool {
        false
    }
}

/// Whole-message check: `(metadata end, body length)`.
pub fn check_message(_m: &[u8]) -> Result<(i32, i64), WireError> {
    Ok((0, 0))
}

/// Decodes record-batch slabs of one grid.
#[derive(Debug)]
pub struct GridDecoder {
    meta: GridMeta,
}

impl GridDecoder {
    /// From the schema message slab.
    pub fn new(_schema: &Arc<Slab>) -> Result<GridDecoder, WireError> {
        Err(WireError::NoSchema)
    }

    pub fn meta(&self) -> &GridMeta {
        &self.meta
    }

    /// One record-batch message per slab → one [`GridSeries`] per row.
    pub fn decode(&self, _slab: &Arc<Slab>) -> Result<Vec<GridSeries>, WireError> {
        Ok(Vec::new())
    }
}

/// Hostile messages for the whole-message check: `(name, bytes, expected error)`.
#[cfg(feature = "test-cases")]
pub fn hostile_cases() -> Vec<(&'static str, Vec<u8>, String)> {
    Vec::new()
}
