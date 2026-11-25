//! The per-part decoder: DSF frames → `Chunk`, `Coverage` and `ErrorRow` events (plan #68 B2
//! §3.5, §4.1; T04-001, T04-002, T04-009, T04-010).
#![deny(clippy::indexing_slicing)]

use crate::chunk::Chunk;
use crate::coverage::{Coverage, ErrorRow};
use crate::dsf::{DsfError, Frame};
use crate::ipc::IpcError;

/// The largest grid (= B1 `MaxGridLen`, the YAML maximum).
pub const MAX_GRID_LEN: u32 = 1 << 22;

/// A data part's grid, from its `metric_matrix.grid/1` schema metadata.
#[derive(Clone, Debug, PartialEq)]
pub struct GridInfo {
    pub start_ms: i64,
    pub requested_start_ms: i64,
    pub step_ms: i64,
    pub len: u32,
    pub result: String,
    pub source: String,
    pub unit: Option<String>,
    pub planned: Option<String>,
}

/// Why one part failed; the caller reports `internal`.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum PartError {
    #[error("schema: {0}")]
    Schema(String),
    #[error("ipc: {0}")]
    Ipc(IpcError),
    #[error("order: {0}")]
    Order(&'static str),
    #[error("shape: {0}")]
    Shape(&'static str),
    #[error("series {0} has no labels")]
    MissingLabels(u32),
    #[error("series {0} repeated")]
    DuplicateSeries(u32),
    #[error("null slot without the canonical NaN bits")]
    NullBits,
    #[error("rank changed within the part")]
    Rank,
    #[error("value out of its closed set: {0}")]
    Value(&'static str),
    #[error("limit: {0}")]
    Limit(&'static str),
    #[error("stream: {0}")]
    Stream(DsfError),
}

/// The body-level result: `Complete` only if END arrived and nothing failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Complete,
    Incomplete(&'static str),
}

/// One decoder output.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Grid {
        part: u32,
        rank: u16,
        info: GridInfo,
    },
    Chunk {
        part: u32,
        rank: u16,
        flags: u16,
        chunk: Chunk,
    },
    Coverage {
        part: u32,
        coverage: Coverage,
    },
    Upstream {
        part: u32,
        error: ErrorRow,
    },
    /// The caller reports `internal`.
    Failed {
        part: u32,
        reason: PartError,
    },
    PartEnd {
        part: u32,
    },
    End,
    /// Input ended without END (from `finish`).
    Truncated,
    /// Always the last event of `finish`.
    Verdict(Verdict),
}

/// Decodes one response body, frame by frame.
#[derive(Debug)]
pub struct BodyDecoder {}

impl BodyDecoder {
    pub fn new(_first_chunk_id: u64) -> Self {
        Self {}
    }

    pub fn frame(&mut self, _f: Frame) -> Vec<Event> {
        Vec::new()
    }

    /// Fails every open part.
    pub fn fail_stream(&mut self, _e: DsfError) -> Vec<Event> {
        Vec::new()
    }

    /// The stream-level ERROR (part 0), if one arrived: the response is incomplete.
    pub fn stream_error(&self) -> Option<&ErrorRow> {
        None
    }

    /// `Some` after `finish`.
    pub fn verdict(&self) -> Option<&Verdict> {
        None
    }

    /// End of input. Idempotent; later frames are ignored.
    pub fn finish(&mut self) -> Vec<Event> {
        Vec::new()
    }
}
