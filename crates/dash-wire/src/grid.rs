//! `metric_matrix.grid/1` (T04 §4.3): one row per series, `values` a fixed-size list of the grid's
//! samples. Encoded as Arrow IPC stream messages (T04-002); decoded zero-copy from a [`Slab`]
//! after a whole-message check (T04-010).
//!
//! Each slab holds exactly one encapsulated message: `FFFF FFFF`, the metadata length (LE u32),
//! the flatbuffer `Message`, then `bodyLength` body bytes. [`check_message`] verifies that shape
//! before Arrow reads the slab, so a short or long message is an error, never a partial batch.

use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::{Array, FixedSizeListArray, Float64Array, RecordBatch, UInt32Array};
use arrow_buffer::{NullBuffer, ScalarBuffer};
use arrow_ipc::reader::FileDecoder;
use arrow_ipc::writer::{IpcWriteOptions, StreamWriter};
use arrow_ipc::{Block, MessageHeader, MetadataVersion};
use arrow_schema::{DataType, Field, Schema, SchemaRef};

use crate::slab::Slab;

/// The schema id this module encodes and decodes.
pub const GRID_SCHEMA: &str = "metric_matrix.grid/1";

const SCHEMA_PREFIX: &str = "metric_matrix.grid/";
const KEY_SCHEMA: &str = "dash.schema";
const KEY_START: &str = "dash.grid.start_ms";
const KEY_STEP: &str = "dash.grid.step_ms";
const KEY_LEN: &str = "dash.grid.len";
const KEY_TIME_UNIT: &str = "dash.time_unit";
const TRUNCATED: &str = "truncated message";
const MISMATCH: &str = "message length mismatch";

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
    /// A field (or the message type) is wrong.
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
        match self {
            WireError::Ipc(m) => write!(f, "arrow ipc: {m}"),
            WireError::UnknownSchema(s) => write!(f, "unknown schema {s:?}"),
            WireError::Schema(field) => write!(f, "unexpected {field}"),
            WireError::Metadata(key) => write!(f, "missing or invalid metadata {key}"),
            WireError::NoSchema => f.write_str("not a schema message"),
            WireError::Alloc => f.write_str("slab allocation failed"),
        }
    }
}

impl std::error::Error for WireError {}

fn ipc(e: impl std::fmt::Display) -> WireError {
    WireError::Ipc(e.to_string())
}

fn item() -> Arc<Field> {
    Arc::new(Field::new("item", DataType::Float64, true))
}

fn list_len(len: u32) -> i32 {
    i32::try_from(len).unwrap_or(i32::MAX)
}

/// The Arrow schema of `m`: `series_id` UInt32 non-null; `values` FixedSizeList(Float64
/// nullable, `len`) non-null; the `dash.*` metadata (numbers as decimal strings).
pub fn grid_schema(m: &GridMeta) -> Schema {
    let md: HashMap<String, String> = [
        (KEY_SCHEMA, GRID_SCHEMA.to_string()),
        (KEY_TIME_UNIT, "ms".to_string()),
        (KEY_START, m.start_ms.to_string()),
        (KEY_STEP, m.step_ms.to_string()),
        (KEY_LEN, m.len.to_string()),
        ("dash.result", m.result.clone()),
        ("dash.source", m.source.clone()),
        ("dash.unit", m.unit.clone()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect();
    Schema::new(vec![
        Field::new("series_id", DataType::UInt32, false),
        Field::new(
            "values",
            DataType::FixedSizeList(item(), list_len(m.len)),
            false,
        ),
    ])
    .with_metadata(md)
}

/// Rows per record batch: `clamp(1 MiB / (8·len), 1, 64)` (≈ 1 MiB messages).
pub fn series_per_batch(len: u32) -> u32 {
    let per = 1_048_576 / (8 * u64::from(len.max(1)));
    per.clamp(1, 64) as u32
}

/// Encodes a grid as IPC stream messages, one message per call.
pub struct GridEncoder {
    writer: StreamWriter<Vec<u8>>,
    schema: SchemaRef,
    len: u32,
}

impl std::fmt::Debug for GridEncoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GridEncoder")
            .field("len", &self.len)
            .finish()
    }
}

impl GridEncoder {
    /// The encoder and the schema message.
    pub fn new(m: &GridMeta) -> Result<(GridEncoder, Vec<u8>), WireError> {
        let schema = Arc::new(grid_schema(m));
        let opts = IpcWriteOptions::try_new(64, false, MetadataVersion::V5).map_err(ipc)?;
        let mut writer =
            StreamWriter::try_new_with_options(Vec::new(), &schema, opts).map_err(ipc)?;
        let bytes = std::mem::take(writer.get_mut());
        Ok((
            GridEncoder {
                writer,
                schema,
                len: m.len,
            },
            bytes,
        ))
    }

    /// One record-batch message of `rows` (values, validity), series ids from `first_id`.
    pub fn batch(
        &mut self,
        first_id: u32,
        rows: &[(&[f64], &[bool])],
    ) -> Result<Vec<u8>, WireError> {
        let len = self.len as usize;
        if rows.iter().any(|(v, ok)| v.len() != len || ok.len() != len) {
            return Err(WireError::Schema("values"));
        }
        let ids: UInt32Array = (0..rows.len() as u32).map(|r| first_id + r).collect();
        let mut values = Vec::with_capacity(rows.len() * len);
        let mut valid = Vec::with_capacity(rows.len() * len);
        for (v, ok) in rows {
            values.extend_from_slice(v);
            valid.extend_from_slice(ok);
        }
        let child = Float64Array::new(values.into(), Some(NullBuffer::from(valid)));
        let lists = FixedSizeListArray::try_new(item(), list_len(self.len), Arc::new(child), None)
            .map_err(ipc)?;
        let batch = RecordBatch::try_new(self.schema.clone(), vec![Arc::new(ids), Arc::new(lists)])
            .map_err(ipc)?;
        self.writer.write(&batch).map_err(ipc)?;
        Ok(std::mem::take(self.writer.get_mut()))
    }
}

/// One decoded series: views into the slab (no copy).
#[derive(Clone, Debug, PartialEq)]
pub struct GridSeries {
    pub series_id: u32,
    pub values: ScalarBuffer<f64>,
    pub validity: Option<NullBuffer>,
}

impl GridSeries {
    /// Whether sample `k` is non-NULL.
    pub fn is_valid(&self, k: usize) -> bool {
        self.validity.as_ref().is_none_or(|n| n.is_valid(k))
    }
}

/// Whole-message check: `(metadata end, body length)` of the one message `m` must be. Arithmetic
/// is in `u64` with checked conversions, so 32- and 64-bit targets behave alike.
pub fn check_message(m: &[u8]) -> Result<(i32, i64), WireError> {
    let truncated = || WireError::Ipc(TRUNCATED.into());
    let len = m.len() as u64;
    let (Some(marker), Some(meta)) = (m.get(0..4), m.get(4..8)) else {
        return Err(truncated());
    };
    if marker != [0xFF; 4] {
        return Err(truncated());
    }
    let meta_len = u32::from_le_bytes([meta[0], meta[1], meta[2], meta[3]]);
    let meta_end = 8 + u64::from(meta_len);
    if meta_end > len {
        return Err(truncated());
    }
    let end = usize::try_from(meta_end).map_err(|_| truncated())?;
    let msg = arrow_ipc::root_as_message(&m[8..end]).map_err(ipc)?;
    let body = msg.bodyLength();
    let rest = len - meta_end;
    match u64::try_from(body) {
        Err(_) => return Err(WireError::Ipc(MISMATCH.into())),
        Ok(b) if b < rest => return Err(WireError::Ipc(MISMATCH.into())),
        Ok(b) if b > rest => return Err(truncated()),
        Ok(_) => {}
    }
    let too_large = |_| WireError::Ipc("message too large".into());
    Ok((i32::try_from(meta_end).map_err(too_large)?, body))
}

fn header_type(m: &[u8], meta_end: i32) -> Result<MessageHeader, WireError> {
    let end = usize::try_from(meta_end).map_err(ipc)?;
    Ok(arrow_ipc::root_as_message(&m[8..end])
        .map_err(ipc)?
        .header_type())
}

fn meta_str<'a>(s: &'a Schema, key: &'static str) -> Result<&'a str, WireError> {
    s.metadata()
        .get(key)
        .map(String::as_str)
        .ok_or(WireError::Metadata(key))
}

fn meta_num<T: std::str::FromStr>(s: &Schema, key: &'static str) -> Result<T, WireError> {
    meta_str(s, key)?
        .parse()
        .map_err(|_| WireError::Metadata(key))
}

/// Validates a decoded schema (plan §3.2) and returns its metadata.
fn validate(s: &Schema) -> Result<GridMeta, WireError> {
    let id = meta_str(s, KEY_SCHEMA)?;
    let major = id
        .strip_prefix(SCHEMA_PREFIX)
        .and_then(|v| v.parse::<u32>().ok());
    if major != Some(1) {
        return Err(WireError::UnknownSchema(id.to_string()));
    }
    let start_ms: i64 = meta_num(s, KEY_START)?;
    let step_ms: i64 = meta_num(s, KEY_STEP)?;
    if step_ms <= 0 {
        return Err(WireError::Metadata(KEY_STEP));
    }
    let len: u32 = meta_num(s, KEY_LEN)?;
    if meta_str(s, KEY_TIME_UNIT)? != "ms" {
        return Err(WireError::Metadata(KEY_TIME_UNIT));
    }
    let text = |key| s.metadata().get(key).cloned().unwrap_or_default();
    let fields = s.fields();
    // Both parent fields are non-nullable: a nullable one is a malformed grid.
    match fields
        .first()
        .map(|f| (f.name().as_str(), f.data_type(), f.is_nullable()))
    {
        Some(("series_id", DataType::UInt32, false)) => {}
        _ => return Err(WireError::Schema("series_id")),
    }
    match fields
        .get(1)
        .map(|f| (f.name().as_str(), f.data_type(), f.is_nullable()))
    {
        Some(("values", DataType::FixedSizeList(item, n), false))
            if *item.data_type() == DataType::Float64 && *n == list_len(len) => {}
        _ => return Err(WireError::Schema("values")),
    }
    if fields.len() != 2 {
        return Err(WireError::Schema("fields"));
    }
    Ok(GridMeta {
        start_ms,
        step_ms,
        len,
        result: text("dash.result"),
        source: text("dash.source"),
        unit: text("dash.unit"),
    })
}

/// Decodes the record-batch slabs of one grid.
#[derive(Debug)]
pub struct GridDecoder {
    meta: GridMeta,
    decoder: FileDecoder,
}

impl GridDecoder {
    /// From the schema message slab (not a schema → [`WireError::NoSchema`]), validated.
    pub fn new(schema: &Arc<Slab>) -> Result<GridDecoder, WireError> {
        let m = schema.bytes();
        let (meta_end, _) = check_message(m)?;
        if header_type(m, meta_end)? != MessageHeader::Schema {
            return Err(WireError::NoSchema);
        }
        let s = arrow_ipc::convert::try_schema_from_ipc_buffer(m).map_err(ipc)?;
        let meta = validate(&s)?;
        let decoder =
            FileDecoder::new(Arc::new(s), MetadataVersion::V5).with_require_alignment(true);
        Ok(GridDecoder { meta, decoder })
    }

    pub fn meta(&self) -> &GridMeta {
        &self.meta
    }

    /// Exactly one record-batch message per slab → one [`GridSeries`] per row, zero-copy.
    pub fn decode(&self, slab: &Arc<Slab>) -> Result<Vec<GridSeries>, WireError> {
        let m = slab.bytes();
        let (meta_end, body) = check_message(m)?;
        if header_type(m, meta_end)? != MessageHeader::RecordBatch {
            return Err(WireError::Schema("message type"));
        }
        let batch = self
            .decoder
            .read_record_batch(&Block::new(0, meta_end, body), &slab.buffer())
            .map_err(ipc)?
            .ok_or(WireError::Schema("message type"))?;
        let ids = batch
            .column(0)
            .as_any()
            .downcast_ref::<UInt32Array>()
            .ok_or(WireError::Schema("series_id"))?;
        let lists = batch
            .column(1)
            .as_any()
            .downcast_ref::<FixedSizeListArray>()
            .ok_or(WireError::Schema("values"))?;
        let child = lists
            .values()
            .as_any()
            .downcast_ref::<Float64Array>()
            .ok_or(WireError::Schema("values"))?;
        // The decoder's schema is non-nullable, so Arrow already rejects null parents; checked
        // again before any row is extracted.
        if ids.null_count() > 0 {
            return Err(WireError::Schema("series_id"));
        }
        if lists.null_count() > 0 {
            return Err(WireError::Schema("values"));
        }
        let len = self.meta.len as usize;
        (0..batch.num_rows())
            .map(|r| {
                let at = lists.value_offset_at(r);
                if at + len > child.len() {
                    return Err(WireError::Schema("values"));
                }
                let validity = child
                    .nulls()
                    .map(|n| n.slice(at, len))
                    .filter(|n| n.null_count() > 0);
                Ok(GridSeries {
                    series_id: ids.value(r),
                    values: child.values().slice(at, len),
                    validity,
                })
            })
            .collect()
    }
}

/// Hostile messages for the whole-message check: `(name, bytes, expected error)`. Two 16-byte
/// slabs with huge metadata lengths, and a record-batch message declaring an impossible
/// `bodyLength` (`i64::MAX`, −1).
#[cfg(feature = "test-cases")]
pub fn hostile_cases() -> Vec<(&'static str, Vec<u8>, String)> {
    let truncated = format!("{:?}", WireError::Ipc(TRUNCATED.into()));
    let mismatch = format!("{:?}", WireError::Ipc(MISMATCH.into()));
    let meta_len = |l: u32| {
        let mut m = vec![0xFF; 4];
        m.extend_from_slice(&l.to_le_bytes());
        m.extend_from_slice(&[0; 8]);
        m
    };
    vec![
        (
            "meta-len-7fffffff",
            meta_len(0x7FFF_FFFF),
            truncated.clone(),
        ),
        (
            "meta-len-fffffff8",
            meta_len(0xFFFF_FFF8),
            truncated.clone(),
        ),
        ("body-length-max", batch_message(i64::MAX), truncated),
        ("body-length-negative", batch_message(-1), mismatch),
    ]
}

/// An encapsulated, empty record-batch message whose `bodyLength` is `body` (no body bytes).
#[cfg(feature = "test-cases")]
fn batch_message(body: i64) -> Vec<u8> {
    let mut fbb = flatbuffers::FlatBufferBuilder::new();
    let rb = {
        let mut b = arrow_ipc::RecordBatchBuilder::new(&mut fbb);
        b.add_length(0);
        b.finish()
    };
    let mut mb = arrow_ipc::MessageBuilder::new(&mut fbb);
    mb.add_version(MetadataVersion::V5);
    mb.add_header_type(MessageHeader::RecordBatch);
    mb.add_header(rb.as_union_value());
    mb.add_bodyLength(body);
    let msg = mb.finish();
    fbb.finish(msg, None);
    let mut meta = fbb.finished_data().to_vec();
    meta.resize(meta.len().next_multiple_of(8), 0);
    let mut out = vec![0xFF; 4];
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta);
    out
}
