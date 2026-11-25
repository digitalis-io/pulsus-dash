//! The per-part decoder: DSF frames → `Chunk`, `Coverage` and `ErrorRow` events (plan #68 B2
//! §3.5, §4.1; T04-001, T04-002, T04-009, T04-010).
#![deny(clippy::indexing_slicing)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use crate::chunk::{Chunk, ChunkId, SeriesMeta, TimeAxis};
use crate::coverage::{self, Coverage, ErrorRow, Phase};
use crate::dsf::{DsfError, Frame, FrameHeader, FrameType};
use crate::ipc::{self, Col, ColData, IpcError, Msg, SchemaDesc};
use crate::schema::{Kind, check_schema, grid_info, schema_err};

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

/// The canonical null slot (B1 §3.1).
const NULL_BITS: u64 = 0x7FF8_0000_0000_0000;
/// The per-part flag bits fixed by a part's first frame (`LAST` excluded).
const PART_FLAGS: u16 = FrameHeader::VOLATILE | FrameHeader::CACHED;
/// The end-of-stream marker after a META/ERROR stream.
const EOS: [u8; 8] = [0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0];

// ---------------------------------------------------------------------------------------------
// Payloads

fn ipc_err(e: IpcError) -> PartError {
    PartError::Ipc(e)
}

/// A SCHEMA/BATCH payload: exactly one message ending at the payload end.
fn one_message(f: &Frame) -> Result<Msg, PartError> {
    let (m, end) = ipc::read_message(&f.payload, f.payload_offset, 0).map_err(ipc_err)?;
    if end != f.payload.len() {
        return Err(ipc_err(IpcError::Messages));
    }
    Ok(m)
}

fn one_schema(f: &Frame) -> Result<SchemaDesc, PartError> {
    match one_message(f)? {
        Msg::Schema(s) => Ok(s),
        Msg::Batch { .. } => Err(ipc_err(IpcError::Messages)),
    }
}

/// A META/ERROR payload: schema, one-row batch, EOS; checked against `kind`; its columns.
fn stream(f: &Frame, kind: Kind) -> Result<Vec<Col>, PartError> {
    let (schema, at) = ipc::read_message(&f.payload, f.payload_offset, 0).map_err(ipc_err)?;
    let Msg::Schema(schema) = schema else {
        return Err(ipc_err(IpcError::Messages));
    };
    let (batch, at) = ipc::read_message(&f.payload, f.payload_offset, at).map_err(ipc_err)?;
    if !matches!(batch, Msg::Batch { .. }) {
        return Err(ipc_err(IpcError::Messages));
    }
    let tail = f.payload.as_bytes().get(at..);
    if tail != Some(&EOS[..]) {
        return Err(ipc_err(IpcError::Messages));
    }
    check_schema(&schema, kind, true)?;
    ipc::columns(&schema, &batch).map_err(ipc_err)
}

fn u32_cell(c: Option<&Col>, r: usize) -> Result<u32, PartError> {
    c.and_then(|c| c.fixed::<4>(r))
        .map(u32::from_le_bytes)
        .ok_or(ipc_err(IpcError::Layout("column")))
}

fn u64_cell(c: Option<&Col>, r: usize) -> Result<u64, PartError> {
    c.and_then(|c| c.fixed::<8>(r))
        .map(u64::from_le_bytes)
        .ok_or(ipc_err(IpcError::Layout("column")))
}

fn opt_str(c: Option<&Col>, r: usize) -> Result<Option<&str>, PartError> {
    let c = c.ok_or(ipc_err(IpcError::Messages))?;
    if !c.valid(r) {
        return Ok(None);
    }
    c.str_at(r)
        .map(Some)
        .ok_or(ipc_err(IpcError::Layout("column")))
}

// ---------------------------------------------------------------------------------------------
// Part state

#[derive(Debug)]
struct Labels {
    schema: SchemaDesc,
    series: BTreeMap<u32, SeriesMeta>,
}

#[derive(Debug)]
struct Data {
    schema: SchemaDesc,
    labels_part: u32,
    start_ms: i64,
    step_ms: i64,
    len: u32,
    seen: BTreeSet<u32>,
}

#[derive(Debug)]
enum State {
    New,
    LabelsOpen(Box<Labels>),
    LabelsDone(Box<Labels>),
    DataPlanned,
    DataOpen(Box<Data>),
    /// A partial coverage was emitted; the part's ERROR|LAST must follow.
    Closing {
        labels_part: u32,
    },
    /// The final (or partial) coverage with LAST is held until the labels part finishes.
    Awaiting {
        labels_part: u32,
        coverage: Box<Coverage>,
    },
    Done,
    Failed,
}

impl State {
    /// The labels part of a data part that is linked and not yet done.
    fn linked(&self) -> Option<u32> {
        match self {
            State::DataOpen(d) => Some(d.labels_part),
            State::Closing { labels_part } | State::Awaiting { labels_part, .. } => {
                Some(*labels_part)
            }
            _ => None,
        }
    }
    fn open(&self) -> bool {
        !matches!(self, State::Done | State::Failed | State::LabelsDone(_))
    }
    fn labels(&self) -> Option<&Labels> {
        match self {
            State::LabelsOpen(l) | State::LabelsDone(l) => Some(l),
            _ => None,
        }
    }
}

#[derive(Debug)]
struct Part {
    rank: u16,
    flags: u16,
    state: State,
}

/// Decodes one response body, frame by frame (single owner: Part D's data worker).
#[derive(Debug)]
pub struct BodyDecoder {
    parts: BTreeMap<u32, Part>,
    next: Option<u64>,
    ended: bool,
    stream_failed: bool,
    finished: bool,
    any_failed: bool,
    stream_error: Option<ErrorRow>,
    verdict: Option<Verdict>,
}

impl BodyDecoder {
    pub fn new(first_chunk_id: u64) -> Self {
        Self {
            parts: BTreeMap::new(),
            next: Some(first_chunk_id),
            ended: false,
            stream_failed: false,
            finished: false,
            any_failed: false,
            stream_error: None,
            verdict: None,
        }
    }

    /// Decodes one frame. At most 3 events, plus 2 per data part linked to a labels part that
    /// finishes or fails here; an END frame: one per open part plus `End`.
    pub fn frame(&mut self, f: Frame) -> Vec<Event> {
        if self.finished || self.stream_failed {
            return Vec::new();
        }
        let h = f.header;
        if self.ended {
            self.any_failed = true;
            return vec![Event::Failed {
                part: h.part_id,
                reason: PartError::Stream(DsfError::AfterEnd),
            }];
        }
        if h.flags & !FrameHeader::KNOWN_FLAGS != 0 {
            return self.fail_stream(DsfError::Flags(h.flags));
        }
        match h.kind {
            FrameType::End => {
                if !f.payload.is_empty() || h.part_id != 0 || h.rank != 0 || h.flags != 0 {
                    return self.fail_stream(DsfError::Malformed("end"));
                }
                return self.end();
            }
            FrameType::Ping => {
                if !f.payload.is_empty() || h.part_id != 0 {
                    return self.fail_stream(DsfError::Malformed("ping"));
                }
                return Vec::new();
            }
            FrameType::Progress | FrameType::Event => {
                return self.fail_stream(DsfError::FrameType(h.kind as u8));
            }
            _ => {}
        }
        if f.payload.len() != h.payload_len as usize || !h.payload_len.is_multiple_of(8) {
            return self.fail_stream(DsfError::Malformed("frame length"));
        }
        if h.part_id == 0 {
            return self.stream_level(&f);
        }
        self.part_frame(&f)
    }

    /// The one stream-level ERROR (B1 §3.3 refusal contract); any other part-0 frame fails
    /// the stream.
    fn stream_level(&mut self, f: &Frame) -> Vec<Event> {
        let h = f.header;
        if h.kind == FrameType::Error
            && h.flags & FrameHeader::LAST != 0
            && self.stream_error.is_none()
            && let Ok(error) = stream(f, Kind::Error).and_then(|c| coverage::error_row(&c))
        {
            self.stream_error = Some(error.clone());
            return vec![Event::Upstream { part: 0, error }];
        }
        self.fail_stream(DsfError::Malformed("part 0"))
    }

    fn part_frame(&mut self, f: &Frame) -> Vec<Event> {
        let h = f.header;
        let id = h.part_id;
        let mut ev = Vec::new();
        let part = self.parts.entry(id).or_insert(Part {
            rank: h.rank,
            flags: h.flags & PART_FLAGS,
            state: State::New,
        });
        match part.state {
            State::Failed => return ev,
            State::Done | State::LabelsDone(_) => {
                self.fail(id, PartError::Order("frame for a finished part"), &mut ev);
                return ev;
            }
            _ => {}
        }
        if part.rank != h.rank {
            self.fail(id, PartError::Rank, &mut ev);
            return ev;
        }
        if part.flags != h.flags & PART_FLAGS {
            self.fail(id, PartError::Order("flags"), &mut ev);
            return ev;
        }
        let state = std::mem::replace(&mut part.state, State::Failed);
        match self.step(id, state, f, &mut ev) {
            Ok(next) => {
                if let Some(p) = self.parts.get_mut(&id) {
                    p.state = next;
                }
            }
            Err(reason) => self.fail(id, reason, &mut ev),
        }
        ev
    }

    /// One state transition (§4.1); `Err` fails the part.
    fn step(
        &mut self,
        id: u32,
        state: State,
        f: &Frame,
        ev: &mut Vec<Event>,
    ) -> Result<State, PartError> {
        let h = f.header;
        let last = h.flags & FrameHeader::LAST != 0;
        match (state, h.kind) {
            (State::New, FrameType::Schema) => {
                if last {
                    return Err(PartError::Order("SCHEMA with LAST"));
                }
                let schema = one_schema(f)?;
                check_schema(&schema, Kind::Labels, false)?;
                Ok(State::LabelsOpen(Box::new(Labels {
                    schema,
                    series: BTreeMap::new(),
                })))
            }
            (State::New, FrameType::Meta) => {
                if last {
                    return Err(PartError::Order("planned META with LAST"));
                }
                let c = coverage::coverage_row(&stream(f, Kind::Coverage)?)?;
                if c.phase != Phase::Planned {
                    return Err(PartError::Value("phase"));
                }
                Ok(State::DataPlanned)
            }
            (State::New | State::DataOpen(_) | State::Closing { .. }, FrameType::Error) => {
                if !last {
                    return Err(PartError::Order("ERROR without LAST"));
                }
                let error = coverage::error_row(&stream(f, Kind::Error)?)?;
                ev.push(Event::Upstream { part: id, error });
                ev.push(Event::PartEnd { part: id });
                Ok(State::Done)
            }
            (State::LabelsOpen(mut l), FrameType::Batch) => {
                let rows = labels_batch(&l, f)?;
                l.series.extend(rows);
                if !last {
                    return Ok(State::LabelsOpen(l));
                }
                ev.push(Event::PartEnd { part: id });
                self.release_awaiting(id, ev);
                Ok(State::LabelsDone(l))
            }
            (State::DataPlanned, FrameType::Schema) => {
                if last {
                    return Err(PartError::Order("SCHEMA with LAST"));
                }
                let schema = one_schema(f)?;
                check_schema(&schema, Kind::Grid, false)?;
                let (info, labels_part) = grid_info(&schema)?;
                self.check_link(id, labels_part, h)?;
                let data = Data {
                    schema,
                    labels_part,
                    start_ms: info.start_ms,
                    step_ms: info.step_ms,
                    len: info.len,
                    seen: BTreeSet::new(),
                };
                ev.push(Event::Grid {
                    part: id,
                    rank: h.rank,
                    info,
                });
                Ok(State::DataOpen(Box::new(data)))
            }
            (State::DataOpen(mut d), FrameType::Batch) => {
                if last {
                    return Err(PartError::Order("data BATCH with LAST"));
                }
                let chunk = self.data_batch(&mut d, f)?;
                ev.push(Event::Chunk {
                    part: id,
                    rank: h.rank,
                    flags: h.flags,
                    chunk,
                });
                Ok(State::DataOpen(d))
            }
            (State::DataOpen(d), FrameType::Meta) => {
                let coverage = coverage::coverage_row(&stream(f, Kind::Coverage)?)?;
                let labels_part = d.labels_part;
                match (coverage.phase, last) {
                    (Phase::Planned, _) => Err(PartError::Value("phase")),
                    (Phase::Final, false) => Err(PartError::Order("final META without LAST")),
                    (Phase::Partial, false) => {
                        ev.push(Event::Coverage { part: id, coverage });
                        Ok(State::Closing { labels_part })
                    }
                    (_, true) => {
                        let done = self
                            .parts
                            .get(&labels_part)
                            .is_some_and(|p| matches!(p.state, State::LabelsDone(_)));
                        if done {
                            ev.push(Event::Coverage { part: id, coverage });
                            ev.push(Event::PartEnd { part: id });
                            Ok(State::Done)
                        } else {
                            Ok(State::Awaiting {
                                labels_part,
                                coverage: Box::new(coverage),
                            })
                        }
                    }
                }
            }
            _ => Err(PartError::Order("frame out of order")),
        }
    }

    /// `dash.labels_part` (§4.1): an existing, not failed labels part other than this one,
    /// with the same rank and part flags.
    fn check_link(&self, id: u32, labels_part: u32, h: FrameHeader) -> Result<(), PartError> {
        let target = self
            .parts
            .get(&labels_part)
            .filter(|p| labels_part != id && p.state.labels().is_some())
            .ok_or_else(|| schema_err("labels_part"))?;
        if target.rank != h.rank {
            return Err(schema_err("labels_part rank"));
        }
        if target.flags != h.flags & PART_FLAGS {
            return Err(PartError::Order("flags"));
        }
        Ok(())
    }

    /// The labels part `id` finished: every data part waiting on it emits its held coverage.
    fn release_awaiting(&mut self, id: u32, ev: &mut Vec<Event>) {
        for (part, p) in self.parts.iter_mut() {
            if matches!(&p.state, State::Awaiting { labels_part, .. } if *labels_part == id)
                && let State::Awaiting { coverage, .. } =
                    std::mem::replace(&mut p.state, State::Done)
            {
                ev.push(Event::Coverage {
                    part: *part,
                    coverage: *coverage,
                });
                ev.push(Event::PartEnd { part: *part });
            }
        }
    }

    /// Fails `id` and every data part linked to it that is not yet done.
    fn fail(&mut self, id: u32, reason: PartError, ev: &mut Vec<Event>) {
        if let Some(p) = self.parts.get_mut(&id) {
            p.state = State::Failed;
        }
        self.any_failed = true;
        ev.push(Event::Failed { part: id, reason });
        for (part, p) in self.parts.iter_mut() {
            if p.state.linked() == Some(id) {
                p.state = State::Failed;
                ev.push(Event::Failed {
                    part: *part,
                    reason: PartError::Order("labels part failed"),
                });
            }
        }
    }

    fn end(&mut self) -> Vec<Event> {
        let mut ev = Vec::new();
        let ids: Vec<u32> = self.parts.keys().copied().collect();
        for id in ids {
            if self.parts.get(&id).is_some_and(|p| p.state.open()) {
                self.fail(id, PartError::Order("open at END"), &mut ev);
            }
        }
        ev.push(Event::End);
        self.ended = true;
        self.parts.clear();
        ev
    }

    /// Every open part fails with `reason`, in part-id order.
    fn fail_open(&mut self, reason: &PartError) -> Vec<Event> {
        let mut ev = Vec::new();
        for (part, p) in self.parts.iter_mut() {
            if p.state.open() {
                p.state = State::Failed;
                ev.push(Event::Failed {
                    part: *part,
                    reason: reason.clone(),
                });
            }
        }
        if !ev.is_empty() {
            self.any_failed = true;
        }
        ev
    }

    /// Fails every open part; the stream is not read further.
    pub fn fail_stream(&mut self, e: DsfError) -> Vec<Event> {
        if self.finished || self.stream_failed {
            return Vec::new();
        }
        self.stream_failed = true;
        let ev = self.fail_open(&PartError::Stream(e));
        self.parts.clear();
        ev
    }

    /// The stream-level ERROR (part 0, B1 §3.3 refusal contract), if one arrived: the response
    /// is incomplete.
    pub fn stream_error(&self) -> Option<&ErrorRow> {
        self.stream_error.as_ref()
    }

    /// `Some` after `finish`.
    pub fn verdict(&self) -> Option<&Verdict> {
        self.verdict.as_ref()
    }

    /// End of input: every open part → `Failed(Stream(Truncated))` in part-id order; then
    /// `Truncated` if END was not seen; then the `Verdict`. Idempotent; later frames are
    /// ignored.
    pub fn finish(&mut self) -> Vec<Event> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut ev = if self.ended || self.stream_failed {
            Vec::new()
        } else {
            self.fail_open(&PartError::Stream(DsfError::Truncated))
        };
        if !self.ended {
            ev.push(Event::Truncated);
        }
        let verdict = if self.stream_failed {
            Verdict::Incomplete("stream failed")
        } else if !self.ended {
            Verdict::Incomplete("no END")
        } else if self.stream_error.is_some() {
            Verdict::Incomplete("stream error")
        } else if self.any_failed {
            Verdict::Incomplete("part failed")
        } else {
            Verdict::Complete
        };
        ev.push(Event::Verdict(verdict.clone()));
        self.verdict = Some(verdict);
        self.parts.clear();
        ev
    }

    /// A grid batch → one chunk: values and validity copied once into exact-size buffers.
    fn data_batch(&mut self, d: &mut Data, f: &Frame) -> Result<Chunk, PartError> {
        let id = self.next.ok_or(PartError::Limit("chunk ids"))?;
        let labels = self
            .parts
            .get(&d.labels_part)
            .and_then(|p| p.state.labels())
            .ok_or(PartError::Order("labels part failed"))?;
        let msg = one_message(f)?;
        let cols = ipc::columns(&d.schema, &msg).map_err(ipc_err)?;
        let (ids, vals) = match cols.as_slice() {
            [ids, vals] => (ids, vals),
            _ => return Err(ipc_err(IpcError::Messages)),
        };
        let ColData::Fsl { size, child } = &vals.data else {
            return Err(ipc_err(IpcError::Messages));
        };
        if *size != d.len as usize {
            return Err(PartError::Shape("list size"));
        }
        let ColData::Fixed { bytes, .. } = &child.data else {
            return Err(ipc_err(IpcError::Messages));
        };
        let rows = ids.len;
        let mut series = Vec::with_capacity(rows);
        for r in 0..rows {
            let sid = u32_cell(Some(ids), r)?;
            let meta = labels
                .series
                .get(&sid)
                .ok_or(PartError::MissingLabels(sid))?;
            if !d.seen.insert(sid) {
                return Err(PartError::DuplicateSeries(sid));
            }
            series.push(meta.clone());
        }
        let n = child.len;
        let total = u32::try_from(n).map_err(|_| PartError::Limit("chunk size"))?;
        // B3 charges value_budget here, before the allocations below.
        let validity = if child.nulls > 0 {
            child.validity.as_ref().map(|v| v.as_bytes())
        } else {
            None
        };
        let mut values = Vec::with_capacity(n);
        let mut present = validity.map(|_| vec![0u64; n.div_ceil(64)]);
        let mut finite: Option<(f64, f64)> = None;
        for (i, c) in bytes.as_bytes().as_chunks::<8>().0.iter().enumerate() {
            let bits = u64::from_le_bytes(*c);
            let on = validity.is_none_or(|v| v.get(i / 8).is_some_and(|x| x >> (i % 8) & 1 == 1));
            if on {
                if let Some(w) = present.as_mut().and_then(|p| p.get_mut(i / 64)) {
                    *w |= 1 << (i % 64);
                }
            } else if bits != NULL_BITS {
                return Err(PartError::NullBits);
            }
            let v = f64::from_bits(bits);
            if v.is_finite() {
                finite = Some(finite.map_or((v, v), |(lo, hi)| (lo.min(v), hi.max(v))));
            }
            values.push(v);
        }
        let offsets = (0..=rows as u32).map(|s| s * d.len).collect::<Vec<u32>>();
        if offsets.last().copied() != Some(total) {
            return Err(ipc_err(IpcError::Layout("fsl child")));
        }
        self.next = id.checked_add(1);
        Ok(Chunk {
            id: ChunkId(id),
            time: TimeAxis::Grid {
                start_ms: d.start_ms,
                step_ms: d.step_ms,
                len: d.len,
            },
            series,
            offsets,
            values,
            present,
            finite,
        })
    }
}

/// One series' rows in a labels batch: (series id, key hash, labels, had a null row).
type Group = (u32, u64, Vec<(String, String)>, bool);

/// A labels batch → `(series id, SeriesMeta)` rows, with the §4.1 shape rules: rows of a
/// series contiguous and in one batch, one key hash, no half-null label, a null row alone,
/// names strictly increasing by bytes.
fn labels_batch(l: &Labels, f: &Frame) -> Result<Vec<(u32, SeriesMeta)>, PartError> {
    let msg = one_message(f)?;
    let cols = ipc::columns(&l.schema, &msg).map_err(ipc_err)?;
    let rows = cols.first().map_or(0, |c| c.len);
    let mut out: Vec<(u32, SeriesMeta)> = Vec::new();
    let mut here = BTreeSet::new();
    let mut cur: Option<Group> = None;
    let finish = |cur: Option<Group>, out: &mut Vec<(u32, SeriesMeta)>| {
        if let Some((sid, key_hash, labels, _)) = cur {
            out.push((
                sid,
                SeriesMeta {
                    key_hash,
                    labels: Arc::from(labels),
                },
            ));
        }
    };
    for r in 0..rows {
        let sid = u32_cell(cols.first(), r)?;
        let key = u64_cell(cols.get(1), r)?;
        let k = opt_str(cols.get(2), r)?;
        let v = opt_str(cols.get(3), r)?;
        if cur.as_ref().is_none_or(|c| c.0 != sid) {
            finish(cur.take(), &mut out);
            if l.series.contains_key(&sid) {
                return Err(PartError::DuplicateSeries(sid));
            }
            if !here.insert(sid) {
                return Err(PartError::Shape("non-contiguous rows"));
            }
            cur = Some((sid, key, Vec::new(), false));
        }
        let Some((_, ck, labels, null_row)) = cur.as_mut() else {
            continue;
        };
        if *ck != key {
            return Err(PartError::Shape("mixed key hashes"));
        }
        match (k, v) {
            (None, None) => {
                if *null_row || !labels.is_empty() {
                    return Err(PartError::Shape("null row with other rows"));
                }
                *null_row = true;
            }
            (Some(k), Some(v)) => {
                if *null_row {
                    return Err(PartError::Shape("null row with other rows"));
                }
                if labels
                    .last()
                    .is_some_and(|(prev, _)| prev.as_bytes() >= k.as_bytes())
                {
                    return Err(PartError::Shape("label order"));
                }
                labels.push((k.to_owned(), v.to_owned()));
            }
            _ => return Err(PartError::Shape("half-null label")),
        }
    }
    finish(cur, &mut out);
    Ok(out)
}
