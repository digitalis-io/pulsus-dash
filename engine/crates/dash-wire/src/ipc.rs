//! Arrow IPC messages for the B1 type set (plan #68 B2 §3.4): message framing, schema and
//! record-batch metadata, and the column layout checks.
#![deny(clippy::indexing_slicing)]

use crate::bytes::SharedBytes;

use crate::fb::Spec;

/// `Message`: 0 version (i16), 1 header_type (u8), 2 header, 3 bodyLength (i64).
pub(crate) const MESSAGE: Spec = &[(0, 2), (1, 1), (2, 4), (3, 8)];

/// A column type of the v1 schemas.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Ty {
    U8,
    U16,
    U32,
    U64,
    F64,
    Bool,
    Utf8,
    TsMs,
    List(Box<FieldDesc>),
    Fsl(i32, Box<FieldDesc>),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct FieldDesc {
    pub(crate) name: String,
    pub(crate) nullable: bool,
    pub(crate) ty: Ty,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SchemaDesc {
    pub(crate) fields: Vec<FieldDesc>,
    pub(crate) metadata: Vec<(String, String)>,
}

#[derive(Debug)]
pub(crate) enum Msg {
    Schema(SchemaDesc),
    Batch {
        length: i64,
        nodes: Vec<(i64, i64)>,
        buffers: Vec<(i64, i64)>,
        body: SharedBytes,
    },
}

/// Why an IPC message was rejected.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum IpcError {
    #[error("malformed flatbuffer")]
    Flatbuffer,
    #[error("metadata version is not V5")]
    Version,
    #[error("unsupported: {0}")]
    Unsupported(&'static str),
    #[error("buffer out of bounds")]
    Bounds,
    #[error("layout: {0}")]
    Layout(&'static str),
    #[error("invalid UTF-8")]
    Utf8,
    #[error("message, node or buffer count")]
    Messages,
}

/// One decoded column.
#[derive(Debug)]
pub(crate) struct Col {
    pub(crate) len: usize,
    pub(crate) nulls: usize,
    pub(crate) validity: Option<SharedBytes>,
    pub(crate) data: ColData,
}

#[derive(Debug)]
pub(crate) enum ColData {
    Fixed {
        width: usize,
        bytes: SharedBytes,
    },
    Bool(SharedBytes),
    Utf8 {
        offsets: SharedBytes,
        bytes: SharedBytes,
    },
    List {
        offsets: SharedBytes,
        child: Box<Col>,
    },
    Fsl {
        size: usize,
        child: Box<Col>,
    },
}

/// One encapsulated message at `at` in `payload`; returns it and the offset after it.
pub(crate) fn read_message(
    _payload: &SharedBytes,
    _payload_offset: u64,
    _at: usize,
) -> Result<(Msg, usize), IpcError> {
    Err(IpcError::Messages)
}

/// The batch's columns, depth-first, with the layout checks.
pub(crate) fn columns(_schema: &SchemaDesc, _batch: &Msg) -> Result<Vec<Col>, IpcError> {
    Err(IpcError::Messages)
}
