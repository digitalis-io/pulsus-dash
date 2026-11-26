//! Engine data: immutable chunks of series values (T03-007), the DSF splitter and the Arrow IPC
//! reader and decoder that produce them (plan #68 B2).

#[cfg(target_endian = "big")]
compile_error!("dash-wire reads little-endian Arrow buffers; big-endian targets are unsupported");

pub mod bytes;
pub mod chunk;
pub mod coverage;
pub mod decode;
pub mod dsf;
pub(crate) mod fb;
pub(crate) mod ipc;
pub mod limits;
pub(crate) mod schema;

#[cfg(test)]
#[path = "../tests/common/mod.rs"]
pub(crate) mod testkit;

pub use bytes::{SharedBytes, slabs_from};
pub use chunk::{Chunk, ChunkBuilder, ChunkError, ChunkId, IdAlloc, IdSpace, SeriesMeta, TimeAxis};
pub use coverage::{Coverage, ErrorRow, Phase, STR_LIST_ELEMENT_BYTES, StrList};
pub use decode::{BodyDecoder, Event, GridInfo, MAX_GRID_LEN, PartError, Verdict};
pub use dsf::{DsfError, Frame, FrameHeader, FrameSplitter, FrameType, HEADER_LEN, MAX_PAYLOAD};
pub use ipc::IpcError;
pub use limits::{Limits, MAX_CHUNK, SOURCE_BUFFER};
