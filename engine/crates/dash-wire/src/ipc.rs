//! Arrow IPC messages for the B1 type set (plan #68 B2 §3.4): message framing, schema and
//! record-batch metadata, and the column layout checks. Supports exactly what B1 writes:
//! metadata V5, little-endian, no dictionaries, no compression, and the types of `Ty`.
#![deny(clippy::indexing_slicing)]

use crate::bytes::SharedBytes;
use crate::fb::{Fb, Spec, Table, utf8};

/// `Message`: 0 version (i16), 1 header_type (u8), 2 header, 3 bodyLength (i64).
pub(crate) const MESSAGE: Spec = &[(0, 2), (1, 1), (2, 4), (3, 8)];
/// `Schema`: 0 endianness (i16), 1 fields, 2 custom_metadata.
const SCHEMA: Spec = &[(0, 2), (1, 4), (2, 4)];
/// `Field`: 0 name, 1 nullable, 2 type_type, 3 type, 5 children.
const FIELD: Spec = &[(0, 4), (1, 1), (2, 1), (3, 4), (5, 4)];
/// `KeyValue`: 0 key, 1 value.
const KEY_VALUE: Spec = &[(0, 4), (1, 4)];
/// `Int`: 0 bitWidth (i32), 1 is_signed.
const INT: Spec = &[(0, 4), (1, 1)];
/// `FloatingPoint`: 0 precision (i16).
const FLOAT: Spec = &[(0, 2)];
/// `Timestamp`: 0 unit (i16), 1 timezone.
const TIMESTAMP: Spec = &[(0, 2), (1, 4)];
/// `FixedSizeList`: 0 listSize (i32).
const FIXED_SIZE_LIST: Spec = &[(0, 4)];
/// `Utf8`, `Bool`, `List`: no fields.
const EMPTY: Spec = &[];
/// `RecordBatch`: 0 length (i64), 1 nodes, 2 buffers, 4 variadicBufferCounts.
const RECORD_BATCH: Spec = &[(0, 8), (1, 4), (2, 4), (4, 4)];

/// Metadata V5.
const V5: i16 = 4;
const MAX_FIELDS: usize = 64;
const MAX_KEY_VALUES: usize = 64;
const MAX_NODES: usize = 128;
const MAX_BUFFERS: usize = 256;
const MAX_DEPTH: usize = 4;
/// The longest node (2³¹ values).
const MAX_NODE_LEN: i64 = 1 << 31;

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

impl SchemaDesc {
    /// The value of metadata `key` (the first, if repeated).
    pub(crate) fn meta(&self, key: &str) -> Option<&str> {
        self.metadata
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
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

/// One decoded column; every slice is cut to its logical length.
#[derive(Debug)]
pub(crate) struct Col {
    pub(crate) len: usize,
    pub(crate) nulls: usize,
    /// `⌈len/8⌉` bytes, LSB first, 1 = valid; `None` when the buffer is empty.
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

/// `true` when every byte of `s` is 0 (memcmp against a zero block).
pub(crate) fn all_zero(s: &[u8]) -> bool {
    const ZEROS: [u8; 256] = [0; 256];
    s.chunks(ZEROS.len())
        .all(|c| ZEROS.get(..c.len()).is_some_and(|z| z == c))
}

/// The number of 0 bits among the first `len` bits of `bytes` (LSB first).
fn zero_bits(bytes: &[u8], len: usize) -> usize {
    let full = len / 8;
    let ones: usize = bytes
        .get(..full)
        .unwrap_or_default()
        .iter()
        .map(|b| b.count_ones() as usize)
        .sum();
    let rem = len % 8;
    let tail = if rem == 0 {
        0
    } else {
        bytes
            .get(full)
            .map_or(0, |b| (b & ((1u8 << rem) - 1)).count_ones() as usize)
    };
    len - ones - tail
}

fn bit(bytes: &[u8], i: usize) -> bool {
    bytes.get(i / 8).is_some_and(|b| b >> (i % 8) & 1 == 1)
}

fn offset_at(offsets: &[u8], i: usize) -> Option<usize> {
    let a = offsets.get(4 * i..4 * i + 4)?;
    let v = i32::from_le_bytes(<[u8; 4]>::try_from(a).ok()?);
    usize::try_from(v).ok()
}

impl Col {
    /// Row `r` is valid (not null).
    pub(crate) fn valid(&self, r: usize) -> bool {
        self.validity.as_ref().is_none_or(|v| bit(v.as_bytes(), r))
    }

    /// The little-endian bytes of fixed-width row `r`.
    pub(crate) fn fixed<const N: usize>(&self, r: usize) -> Option<[u8; N]> {
        match &self.data {
            ColData::Fixed { width, bytes } if *width == N => bytes
                .as_bytes()
                .get(r * N..r * N + N)
                .and_then(|s| <[u8; N]>::try_from(s).ok()),
            _ => None,
        }
    }

    pub(crate) fn bool_at(&self, r: usize) -> Option<bool> {
        match &self.data {
            ColData::Bool(b) => Some(bit(b.as_bytes(), r)),
            _ => None,
        }
    }

    /// The string of Utf8 row `r` (validated by `columns`).
    pub(crate) fn str_at(&self, r: usize) -> Option<&str> {
        match &self.data {
            ColData::Utf8 { offsets, bytes } => {
                let o = offsets.as_bytes();
                let s = bytes
                    .as_bytes()
                    .get(offset_at(o, r)?..offset_at(o, r + 1)?)?;
                std::str::from_utf8(s).ok()
            }
            _ => None,
        }
    }

    /// The strings of `List<Utf8>` row `r`.
    pub(crate) fn list_at(&self, r: usize) -> Option<Vec<String>> {
        match &self.data {
            ColData::List { offsets, child } => {
                let o = offsets.as_bytes();
                (offset_at(o, r)?..offset_at(o, r + 1)?)
                    .map(|k| child.str_at(k).map(str::to_owned))
                    .collect()
            }
            _ => None,
        }
    }
}

/// One encapsulated message at `at` in `payload`: `FF FF FF FF`, `i32 L` (0 < L, L ≡ 0 mod 8,
/// in range), metadata, body of exactly `bodyLength`. The body's response-body offset
/// `payload_offset + at + 8 + L` must be ≡ 0 (mod 64), and `L` the least such value for the
/// flatbuffer's length (B1 §3.2), with zero padding. Returns the message and the offset after it.
pub(crate) fn read_message(
    payload: &SharedBytes,
    payload_offset: u64,
    at: usize,
) -> Result<(Msg, usize), IpcError> {
    let p = payload.as_bytes();
    let head = at.checked_add(8).ok_or(IpcError::Bounds)?;
    let prefix: [u8; 8] = p
        .get(at..head)
        .and_then(|s| s.try_into().ok())
        .ok_or(IpcError::Bounds)?;
    let [c0, c1, c2, c3, l0, l1, l2, l3] = prefix;
    if [c0, c1, c2, c3] != [0xFF; 4] {
        return Err(IpcError::Layout("continuation"));
    }
    let l = i32::from_le_bytes([l0, l1, l2, l3]);
    if l <= 0 || l % 8 != 0 {
        return Err(IpcError::Layout("metadata length"));
    }
    let l = l as usize;
    let meta_end = head.checked_add(l).ok_or(IpcError::Bounds)?;
    let meta = p.get(head..meta_end).ok_or(IpcError::Bounds)?;
    let body_abs = payload_offset
        .checked_add(meta_end as u64)
        .ok_or(IpcError::Bounds)?;
    if !body_abs.is_multiple_of(64) {
        return Err(IpcError::Layout("body align"));
    }
    let fb = Fb::new(meta);
    let m = fb.root(MESSAGE)?;
    if m.i16(0, 0)? != V5 {
        return Err(IpcError::Version);
    }
    let header_type = m.u8(1, 0)?;
    let body_len = m.i64(3, 0)?;
    let msg = match header_type {
        1 => {
            if body_len != 0 {
                return Err(IpcError::Layout("body length"));
            }
            let h = m.table(2, SCHEMA)?.ok_or(IpcError::Flatbuffer)?;
            Some(schema(&h)?)
        }
        3 => {
            if body_len < 0 || body_len % 8 != 0 {
                return Err(IpcError::Layout("body length"));
            }
            None
        }
        _ => return Err(IpcError::Unsupported("message type")),
    };
    let batch = match msg {
        Some(_) => None,
        None => {
            let h = m.table(2, RECORD_BATCH)?.ok_or(IpcError::Flatbuffer)?;
            Some(record_batch(&h)?)
        }
    };
    let high = fb.finish()?;
    // Minimal L for the flatbuffer's own length m = round_up(high, 8), then zero padding.
    let m8 = high.div_ceil(8) * 8;
    let base = (payload_offset.wrapping_add(head as u64) % 64) as usize;
    let want = m8 + (64 - (base + m8) % 64) % 64;
    if l != want {
        return Err(IpcError::Layout("metadata length"));
    }
    if !meta.get(high..).is_none_or(all_zero) {
        return Err(IpcError::Layout("padding"));
    }
    let body_len = usize::try_from(body_len).map_err(|_| IpcError::Bounds)?;
    let end = meta_end.checked_add(body_len).ok_or(IpcError::Bounds)?;
    // Pass 2: only now are strings and vectors copied out of the verified metadata.
    let mut budget = meta.len();
    let msg = match (msg, batch) {
        (Some(s), _) => Msg::Schema(own_schema(s, &mut budget)?),
        (None, Some((length, nodes, buffers))) => Msg::Batch {
            length,
            nodes: pairs(nodes),
            buffers: pairs(buffers),
            body: payload.slice(meta_end, body_len).ok_or(IpcError::Bounds)?,
        },
        (None, None) => return Err(IpcError::Messages),
    };
    Ok((msg, end))
}

/// Pass 1 of a Schema: the verified structure, with every string still a borrowed slice of
/// the metadata (nothing is copied before `Fb::finish` has rejected aliased objects).
struct RawSchema<'a> {
    fields: Vec<RawField<'a>>,
    metadata: Vec<(&'a [u8], &'a [u8])>,
}

struct RawField<'a> {
    name: &'a [u8],
    nullable: bool,
    ty: RawTy<'a>,
}

enum RawTy<'a> {
    Leaf(Ty),
    List(Box<RawField<'a>>),
    Fsl(i32, Box<RawField<'a>>),
}

fn schema<'a>(t: &Table<'a>) -> Result<RawSchema<'a>, IpcError> {
    if t.i16(0, 0)? != 0 {
        return Err(IpcError::Unsupported("big-endian"));
    }
    let fields = t
        .tables(1, MAX_FIELDS, FIELD)?
        .iter()
        .map(|f| field(f, 1))
        .collect::<Result<Vec<_>, _>>()?;
    let mut metadata = Vec::new();
    for kv in t.tables(2, MAX_KEY_VALUES, KEY_VALUE)? {
        let k = kv.str(0)?.ok_or(IpcError::Flatbuffer)?;
        let v = kv.str(1)?.ok_or(IpcError::Flatbuffer)?;
        metadata.push((k, v));
    }
    Ok(RawSchema { fields, metadata })
}

/// Pass 2, after `Fb::finish`: copies the strings and checks their UTF-8. Because no two
/// verified objects overlap, each metadata byte backs at most one copied byte, so the copies
/// total at most the metadata length; `budget` (= that length) enforces it.
fn own_schema(raw: RawSchema<'_>, budget: &mut usize) -> Result<SchemaDesc, IpcError> {
    let fields = raw
        .fields
        .into_iter()
        .map(|f| own_field(f, budget))
        .collect::<Result<Vec<_>, _>>()?;
    let metadata = raw
        .metadata
        .into_iter()
        .map(|(k, v)| Ok((own_str(k, budget)?, own_str(v, budget)?)))
        .collect::<Result<Vec<_>, IpcError>>()?;
    Ok(SchemaDesc { fields, metadata })
}

fn own_str(b: &[u8], budget: &mut usize) -> Result<String, IpcError> {
    *budget = budget.checked_sub(b.len()).ok_or(IpcError::Flatbuffer)?;
    utf8(b).map(str::to_owned)
}

fn own_field(f: RawField<'_>, budget: &mut usize) -> Result<FieldDesc, IpcError> {
    let ty = match f.ty {
        RawTy::Leaf(t) => t,
        RawTy::List(c) => Ty::List(Box::new(own_field(*c, budget)?)),
        RawTy::Fsl(n, c) => Ty::Fsl(n, Box::new(own_field(*c, budget)?)),
    };
    Ok(FieldDesc {
        name: own_str(f.name, budget)?,
        nullable: f.nullable,
        ty,
    })
}

fn field<'a>(f: &Table<'a>, depth: usize) -> Result<RawField<'a>, IpcError> {
    if depth > MAX_DEPTH {
        return Err(IpcError::Flatbuffer);
    }
    let name = f.str(0)?.unwrap_or_default();
    let nullable = f.bool(1, false)?;
    let type_type = f.u8(2, 0)?;
    let spec = match type_type {
        2 => INT,
        3 => FLOAT,
        5 | 6 | 12 => EMPTY,
        10 => TIMESTAMP,
        16 => FIXED_SIZE_LIST,
        _ => return Err(IpcError::Unsupported("type")),
    };
    let ty_table = f.table(3, spec)?.ok_or(IpcError::Flatbuffer)?;
    let children = f.tables(5, 1, FIELD)?;
    let nested = matches!(type_type, 12 | 16);
    if children.len() != usize::from(nested) {
        return Err(IpcError::Unsupported("children"));
    }
    let child = || -> Result<Box<RawField<'a>>, IpcError> {
        let c = children.first().ok_or(IpcError::Unsupported("children"))?;
        field(c, depth + 1).map(Box::new)
    };
    let ty = match type_type {
        2 => {
            let width = ty_table.i32(0, 0)?;
            if ty_table.bool(1, false)? {
                return Err(IpcError::Unsupported("signed int"));
            }
            RawTy::Leaf(match width {
                8 => Ty::U8,
                16 => Ty::U16,
                32 => Ty::U32,
                64 => Ty::U64,
                _ => return Err(IpcError::Unsupported("int width")),
            })
        }
        3 => {
            if ty_table.i16(0, 0)? != 2 {
                return Err(IpcError::Unsupported("float precision"));
            }
            RawTy::Leaf(Ty::F64)
        }
        5 => RawTy::Leaf(Ty::Utf8),
        6 => RawTy::Leaf(Ty::Bool),
        10 => {
            if ty_table.i16(0, 0)? != 1 {
                return Err(IpcError::Unsupported("time unit"));
            }
            if ty_table.str(1)? != Some(&b"UTC"[..]) {
                return Err(IpcError::Unsupported("timezone"));
            }
            RawTy::Leaf(Ty::TsMs)
        }
        12 => RawTy::List(child()?),
        _ => {
            let size = ty_table.i32(0, 0)?;
            if size < 1 {
                return Err(IpcError::Unsupported("list size"));
            }
            RawTy::Fsl(size, child()?)
        }
    };
    Ok(RawField { name, nullable, ty })
}

fn pairs(bytes: &[u8]) -> Vec<(i64, i64)> {
    bytes
        .as_chunks::<16>()
        .0
        .iter()
        .map(|c| {
            let (a, b) = c.split_at(8);
            let mut x = [0u8; 8];
            let mut y = [0u8; 8];
            x.copy_from_slice(a);
            y.copy_from_slice(b);
            (i64::from_le_bytes(x), i64::from_le_bytes(y))
        })
        .collect()
}

/// Pass 1 of a RecordBatch: the length and the borrowed `FieldNode` and `Buffer` vectors.
type BatchMeta<'a> = (i64, &'a [u8], &'a [u8]);

fn record_batch<'a>(t: &Table<'a>) -> Result<BatchMeta<'a>, IpcError> {
    let length = t.i64(0, 0)?;
    let nodes = t.structs(1, 16, MAX_NODES)?;
    let buffers = t.structs(2, 16, MAX_BUFFERS)?;
    if !t.structs(4, 8, MAX_BUFFERS)?.is_empty() {
        return Err(IpcError::Unsupported("variadic buffers"));
    }
    Ok((length, nodes, buffers))
}

/// How many bytes (or bits) of a buffer the column uses; everything else must be zero.
#[derive(Clone, Copy, Debug)]
enum Used {
    Bytes(usize),
    Bits(usize),
}

struct Walk<'a> {
    nodes: std::slice::Iter<'a, (i64, i64)>,
    peek: Option<(usize, usize)>,
    bufs: std::iter::Enumerate<std::slice::Iter<'a, (usize, usize)>>,
    used: Vec<Used>,
    body: &'a SharedBytes,
    length: usize,
}

impl Walk<'_> {
    fn node(&mut self) -> Result<(usize, usize), IpcError> {
        if let Some(n) = self.peek.take() {
            return Ok(n);
        }
        let &(len, nulls) = self.nodes.next().ok_or(IpcError::Messages)?;
        if !(0..=MAX_NODE_LEN).contains(&len) || !(0..=len).contains(&nulls) {
            return Err(IpcError::Layout("node"));
        }
        Ok((len as usize, nulls as usize))
    }

    /// The next node's length, without consuming it.
    fn peek_len(&mut self) -> Result<usize, IpcError> {
        let n = self.node()?;
        self.peek = Some(n);
        Ok(n.0)
    }

    /// The next buffer: (index, offset, declared length).
    fn buf(&mut self) -> Result<(usize, usize, usize), IpcError> {
        let (i, &(off, len)) = self.bufs.next().ok_or(IpcError::Messages)?;
        Ok((i, off, len))
    }

    fn use_buf(&mut self, i: usize, u: Used) {
        if let Some(slot) = self.used.get_mut(i) {
            *slot = u;
        }
    }

    fn slice(&self, off: usize, len: usize) -> Result<SharedBytes, IpcError> {
        self.body.slice(off, len).ok_or(IpcError::Bounds)
    }

    /// Offsets of `len` rows: at least `(len + 1) × 4` bytes, first 0, non-decreasing.
    /// Returns the slice and the last offset.
    fn offsets(&mut self, len: usize) -> Result<(SharedBytes, usize), IpcError> {
        let (i, off, blen) = self.buf()?;
        let need = len
            .checked_add(1)
            .and_then(|n| n.checked_mul(4))
            .ok_or(IpcError::Layout("offsets"))?;
        if blen < need {
            return Err(IpcError::Layout("offsets"));
        }
        let s = self.slice(off, need)?;
        let mut prev = 0usize;
        for k in 0..=len {
            let v = offset_at(s.as_bytes(), k).ok_or(IpcError::Layout("offsets"))?;
            if k == 0 && v != 0 {
                return Err(IpcError::Layout("first offset"));
            }
            if v < prev {
                return Err(IpcError::Layout("offsets"));
            }
            prev = v;
        }
        self.use_buf(i, Used::Bytes(need));
        Ok((s, prev))
    }

    fn col(&mut self, f: &FieldDesc, top: bool) -> Result<Col, IpcError> {
        let (len, nulls) = self.node()?;
        if top && len != self.length {
            return Err(IpcError::Layout("length"));
        }
        if !f.nullable && nulls != 0 {
            return Err(IpcError::Layout("nulls"));
        }
        let (vi, voff, vlen) = self.buf()?;
        let validity = if vlen == 0 {
            if nulls != 0 {
                return Err(IpcError::Layout("nulls"));
            }
            None
        } else {
            let need = len.div_ceil(8);
            if vlen < need {
                return Err(IpcError::Layout("nulls"));
            }
            let v = self.slice(voff, need)?;
            if zero_bits(v.as_bytes(), len) != nulls {
                return Err(IpcError::Layout("nulls"));
            }
            self.use_buf(vi, Used::Bits(len));
            Some(v)
        };
        let fixed = |w: usize| Some(w);
        let width = match &f.ty {
            Ty::U8 => fixed(1),
            Ty::U16 => fixed(2),
            Ty::U32 => fixed(4),
            Ty::U64 | Ty::F64 | Ty::TsMs => fixed(8),
            _ => None,
        };
        let data = match (&f.ty, width) {
            (_, Some(width)) => {
                let (i, off, blen) = self.buf()?;
                let need = len.checked_mul(width).ok_or(IpcError::Layout("data"))?;
                if blen < need {
                    return Err(IpcError::Layout("data"));
                }
                self.use_buf(i, Used::Bytes(need));
                ColData::Fixed {
                    width,
                    bytes: self.slice(off, need)?,
                }
            }
            (Ty::Bool, _) => {
                let (i, off, blen) = self.buf()?;
                let need = len.div_ceil(8);
                if blen < need {
                    return Err(IpcError::Layout("bool data"));
                }
                self.use_buf(i, Used::Bits(len));
                ColData::Bool(self.slice(off, need)?)
            }
            (Ty::Utf8, _) => {
                let (offsets, last) = self.offsets(len)?;
                let (i, off, blen) = self.buf()?;
                if last > blen {
                    return Err(IpcError::Layout("offsets"));
                }
                let bytes = self.slice(off, last)?;
                self.use_buf(i, Used::Bytes(last));
                let o = offsets.as_bytes();
                for k in 0..len {
                    let (a, b) = (offset_at(o, k), offset_at(o, k + 1));
                    let s = a
                        .zip(b)
                        .and_then(|(a, b)| bytes.as_bytes().get(a..b))
                        .ok_or(IpcError::Layout("offsets"))?;
                    std::str::from_utf8(s).map_err(|_| IpcError::Utf8)?;
                }
                ColData::Utf8 { offsets, bytes }
            }
            (Ty::List(child), _) => {
                let (offsets, last) = self.offsets(len)?;
                if self.peek_len()? != last {
                    return Err(IpcError::Layout("list child"));
                }
                let child = Box::new(self.col(child, false)?);
                ColData::List { offsets, child }
            }
            (Ty::Fsl(size, child), _) => {
                let size = *size as usize;
                let want = len.checked_mul(size).ok_or(IpcError::Layout("fsl child"))?;
                if self.peek_len()? != want {
                    return Err(IpcError::Layout("fsl child"));
                }
                let child = Box::new(self.col(child, false)?);
                ColData::Fsl { size, child }
            }
            _ => return Err(IpcError::Unsupported("type")),
        };
        Ok(Col {
            len,
            nulls,
            validity,
            data,
        })
    }
}

/// Every byte of `body` outside the logical extent of a buffer is 0 (B1 writes zeros).
fn zero_padding(body: &[u8], bufs: &[(usize, usize)], used: &[Used]) -> Result<(), IpcError> {
    let nz = IpcError::Layout("nonzero padding");
    let zero = |a: usize, b: usize| body.get(a..b).is_none_or(all_zero);
    let mut pos = 0;
    for (&(off, len), u) in bufs.iter().zip(used) {
        if !zero(pos, off) {
            return Err(nz);
        }
        let logical = match *u {
            Used::Bytes(n) => n,
            Used::Bits(bits) => {
                let n = bits.div_ceil(8);
                if !bits.is_multiple_of(8) {
                    let last = body.get(off + n - 1).copied().unwrap_or_default();
                    if last >> (bits % 8) != 0 {
                        return Err(nz);
                    }
                }
                n
            }
        };
        if !zero(off + logical, off + len) {
            return Err(nz);
        }
        pos = off + len;
    }
    if !zero(pos, body.len()) {
        return Err(nz);
    }
    Ok(())
}

/// Walks the fields depth-first, consuming nodes and buffers, with the §3.4 layout checks.
/// `align64`: every buffer offset ≡ 0 (mod 64) (`metric_matrix.grid/1`, B1 §3.2).
pub(crate) fn columns(schema: &SchemaDesc, batch: &Msg) -> Result<Vec<Col>, IpcError> {
    let Msg::Batch {
        length,
        nodes,
        buffers,
        body,
    } = batch
    else {
        return Err(IpcError::Messages);
    };
    let align64 = schema.meta("dash.schema") == Some("metric_matrix.grid/1");
    let blen = body.len();
    let mut bufs = Vec::with_capacity(buffers.len());
    let mut prev_end = 0usize;
    for &(off, len) in buffers {
        let off = usize::try_from(off).map_err(|_| IpcError::Bounds)?;
        let len = usize::try_from(len).map_err(|_| IpcError::Bounds)?;
        let end = off.checked_add(len).ok_or(IpcError::Bounds)?;
        if end > blen {
            return Err(IpcError::Bounds);
        }
        if off < prev_end {
            return Err(IpcError::Layout("overlap"));
        }
        if !off.is_multiple_of(8) || (align64 && !off.is_multiple_of(64)) {
            return Err(IpcError::Layout("align"));
        }
        prev_end = end;
        bufs.push((off, len));
    }
    let length = usize::try_from(*length).map_err(|_| IpcError::Layout("length"))?;
    let mut w = Walk {
        nodes: nodes.iter(),
        peek: None,
        bufs: bufs.iter().enumerate(),
        used: vec![Used::Bytes(0); bufs.len()],
        body,
        length,
    };
    let cols = schema
        .fields
        .iter()
        .map(|f| w.col(f, true))
        .collect::<Result<Vec<_>, _>>()?;
    if w.peek.is_some() || w.nodes.next().is_some() || w.bufs.next().is_some() {
        return Err(IpcError::Messages);
    }
    zero_padding(body.as_bytes(), &bufs, &w.used)?;
    Ok(cols)
}
