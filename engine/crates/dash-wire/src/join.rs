//! `join_grid` (plan #68 D2 §3.2, ADR-0034): a streamed grid part's batch chunks joined into one
//! chunk, so a frame draws one chunk (T02-002).
#![deny(clippy::indexing_slicing)]

use crate::chunk::{Chunk, ChunkId};

/// Why the batch chunks of a grid part cannot be joined.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum JoinError {
    /// No batch chunk: the caller builds the empty chunk from the grid.
    #[error("no batch chunk")]
    Empty,
    /// The joined chunk's size overflows, or exceeds `MAX_SAMPLES`.
    #[error("joined size")]
    Size,
    /// The chunks are not of one grid, or a chunk's layout is inconsistent.
    #[error("chunk shape")]
    Shape,
}

/// The values of a joined chunk of `series` series of `len` points each, checked.
pub fn joined_size(series: usize, len: usize) -> Result<usize, JoinError> {
    let _ = (series, len);
    Err(JoinError::Size)
}

/// The grid part's chunks in arrival order → one chunk.
pub fn join_grid(parts: Vec<Chunk>, id: ChunkId) -> Result<Chunk, JoinError> {
    let _ = (parts, id);
    Err(JoinError::Empty)
}
