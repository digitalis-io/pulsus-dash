//! Engine data: immutable chunks of series values (T03-007). Part B adds the DSF and Arrow
//! decoders that produce them.

pub mod chunk;

pub use chunk::{Chunk, ChunkBuilder, ChunkError, ChunkId, SeriesMeta, TimeAxis};
