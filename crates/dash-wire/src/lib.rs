//! DSF framing, Arrow schemas, coverage (shared with the BFF). Design: T04.
//!
//! #24 adds the `metric_matrix.grid/1` Arrow IPC schema ([`grid`], T04 §4.3) and the 64-byte
//! aligned [`slab`] the browser decodes from without a copy (T04-015). DSF framing and coverage
//! follow with the data plane (epic #2).

pub mod grid;
pub mod slab;

#[cfg(feature = "test-cases")]
pub use grid::hostile_cases;
pub use grid::{
    GRID_SCHEMA, GridDecoder, GridEncoder, GridMeta, GridSeries, WireError, check_message,
    grid_schema, series_per_batch,
};
pub use slab::Slab;
