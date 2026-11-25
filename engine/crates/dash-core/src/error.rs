//! The render worker's errors; their text is what the adapter logs (plan #68 C1 §3.3).

use dash_scene::SpecError;
use dash_wire::ChunkError;

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum CoreError {
    /// A series key that is not 16 lower-case hex digits.
    #[error("key")]
    Key,
    /// The chunk builder's code: `length`, `order`, `too many samples`, `ids`.
    #[error("{0}")]
    Chunk(ChunkError),
    #[error("{0}")]
    Spec(SpecError),
    /// No frame with this id.
    #[error("frame")]
    NoFrame,
}
