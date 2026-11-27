//! The DSF decode service of the MT engine (plan #68 D2 §3.2, §4.3; T03 §6; ADR-0034).
//!
//! The render worker owns the service, the chunk table and the id allocator; it never decodes.
//! `push` copies each fetch read into 64-aligned slabs (`slabs_from`) and sends them, in order, to
//! the request's queue; `pump` starts at most one pool task per request, which drains the queue in
//! order through the request's `FrameSplitter` and `BodyDecoder` and records the consumed bytes as
//! a credit. At END the task joins the grid part's batch chunks into one chunk (`join_grid`), drops
//! the batches and builds the full-grid series arrays; `take_done`, at tick start, puts the chunk
//! in the table and hands the results to the worker to post.
//!
//! No lock (T03-008): a request's decoder state (`Work`) is owned by exactly one side at a time.
//! `pump` moves it into the pool task, which drains the queue and sends it back with its results;
//! render and the tasks talk only through channels and one atomic abort flag.
//!
//! | Memory | Bound |
//! |---|---|
//! | in flight | per decode, the B3 limits the decoder enforces (`limits.json`), × `MAX_IN_FLIGHT` |
//! | completed | the table's chunks held by no frame, `ChunkTable::CAP_UNHELD_BYTES`, LRU |

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Weak};

use dash_wire::{
    BodyDecoder, Chunk, ChunkBuilder, ChunkId, Coverage, DsfError, ErrorRow, Event, FrameSplitter,
    GridInfo, JoinError, MAX_CHUNK, PartError, SeriesMeta, SharedBytes, Verdict, join_grid,
    slabs_from,
};
use serde_json::{Map, Value, json};

/// Why a decode failed (`decode-failed{kind}`): `error` an `error/1` row; `limit` a B3 limit
/// (retried once as JSON); `invalid` a malformed or invalid body (T04-010, not retried); `ids` no
/// chunk id left; `busy` too many decodes in flight.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Error,
    Limit,
    Invalid,
    Ids,
    Busy,
}

impl Failure {
    pub fn as_str(self) -> &'static str {
        match self {
            Failure::Error => "error",
            Failure::Limit => "limit",
            Failure::Invalid => "invalid",
            Failure::Ids => "ids",
            Failure::Busy => "busy",
        }
    }

    /// The failure of a part or stream error.
    pub fn of(reason: &PartError) -> Self {
        match reason {
            PartError::Limit(_)
            | PartError::Stream(DsfError::Limit(_) | DsfError::PayloadTooLarge(_)) => {
                Failure::Limit
            }
            PartError::Chunk(_) => Failure::Ids,
            _ => Failure::Invalid,
        }
    }
}

/// A decoded range: the chunk's table id and epoch, the head (`decoded.head`), the grid's
/// timestamps and each series over the full grid (absent points NaN).
#[derive(Clone, Debug, PartialEq)]
pub struct Decoded {
    pub req: u32,
    pub chunk: u32,
    pub epoch: u32,
    pub head: Value,
    pub ts: Vec<f64>,
    pub vs: Vec<Vec<f64>>,
}

/// A failed decode; for `error`, the row, the coverage so far and `dash.planned`.
#[derive(Clone, Debug, PartialEq)]
pub struct Failed {
    pub req: u32,
    pub kind: Failure,
    pub row: Option<Value>,
    pub coverage: Option<Value>,
    pub planned: Option<String>,
    pub message: String,
}

/// One result for the render worker to post.
#[derive(Clone, Debug, PartialEq)]
pub enum Done {
    /// Bytes of `req` the pool has consumed since the last credit.
    Credit {
        req: u32,
        bytes: u64,
    },
    Decoded(Decoded),
    Failed(Failed),
}

/// How a pool task is started (`rayon::spawn` by default).
pub type Spawner = Box<dyn Fn(Box<dyn FnOnce() + Send + 'static>)>;

/// A test hook run at the start of every pool task.
type Hook = Arc<dyn Fn() + Send + Sync>;

/// A test's view of whether a request's decoder state still exists.
#[derive(Debug)]
pub struct WorkHandle(Weak<()>);

impl WorkHandle {
    pub fn alive(&self) -> bool {
        self.0.strong_count() > 0
    }
}

// ---------------------------------------------------------------------------------------------
// JSON forms of the rows (the `decoded` head and `decode-failed`)

fn strs<'a>(it: impl Iterator<Item = &'a str>) -> Value {
    Value::Array(it.map(|s| Value::String(s.to_owned())).collect())
}

/// A `coverage/1` row as the worker posts it.
pub fn coverage_json(c: &Coverage) -> Value {
    json!({
        "truncated": c.truncated,
        "truncation_reason": c.truncation_reason.as_deref(),
        "warnings": strs(c.warnings.iter()),
        "infos": strs(c.infos.iter()),
        "upstream_query_ids": strs(c.upstream_query_ids.iter()),
        "read_cache": c.read_cache,
        "read_cache_through": c.read_cache_through,
        "data_end": c.data_end,
    })
}

/// An `error/1` row as the worker posts it.
pub fn row_json(r: &ErrorRow) -> Value {
    json!({
        "code": r.code,
        "http_status": r.http_status,
        "message": &*r.message,
        "position": r.position,
        "retry_after_ms": r.retry_after_ms,
        "suggestion": r.suggestion.as_deref(),
    })
}

fn series_json(m: &SeriesMeta) -> Value {
    let mut labels = Map::new();
    for (k, v) in m.labels.iter() {
        labels.insert(k.clone(), Value::String(v.clone()));
    }
    json!({"key": format!("{:016x}", m.key_hash), "labels": Value::Object(labels)})
}

// ---------------------------------------------------------------------------------------------
// The chunk table

#[derive(Debug)]
struct Entry {
    chunk: Arc<Chunk>,
    bytes: usize,
    last_used: u64,
}

/// The bytes a chunk holds: values, validity words, offsets and series metas.
fn chunk_bytes(c: &Chunk) -> usize {
    c.values.len() * 8
        + c.present.as_ref().map_or(0, |p| p.len() * 8)
        + c.offsets.len() * 4
        + c.series.len() * std::mem::size_of::<SeriesMeta>()
}

/// The worker's decoded chunks by `u32` id (plan #68 D2 §3.2, §4.2): ids from 1, increasing,
/// never reused within the worker's life; `u32::MAX` is never handed out. A chunk is held while a
/// frame keeps its `Arc`; the chunks held by no frame are capped at `CAP_UNHELD_BYTES`, evicted
/// least recently used first. Every reference carries the worker's boot epoch: another epoch's
/// `get` misses and its `release` is ignored.
#[derive(Debug)]
pub struct ChunkTable {
    epoch: u32,
    next: u32,
    clock: u64,
    cap: usize,
    entries: BTreeMap<u32, Entry>,
}

impl ChunkTable {
    pub const CAP_UNHELD_BYTES: usize = 256 << 20;

    pub fn new(epoch: u32) -> Self {
        Self::with_cap(epoch, Self::CAP_UNHELD_BYTES)
    }

    /// A table with another cap on its unheld bytes (tests).
    pub fn with_cap(epoch: u32, cap: usize) -> Self {
        Self {
            epoch,
            next: 1,
            clock: 0,
            cap,
            entries: BTreeMap::new(),
        }
    }

    /// The next id handed out (tests: the limit).
    #[doc(hidden)]
    pub fn set_next(&mut self, next: u32) {
        self.next = next.max(1);
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// A new entry; `None` when the ids are used up (then the decode fails with `ids`). Unheld
    /// chunks beyond the cap are evicted, oldest use first.
    pub fn insert(&mut self, c: Arc<Chunk>) -> Option<u32> {
        if self.next == u32::MAX {
            return None;
        }
        let id = self.next;
        self.next += 1;
        let last_used = self.tick();
        let bytes = chunk_bytes(&c);
        self.entries.insert(
            id,
            Entry {
                chunk: c,
                bytes,
                last_used,
            },
        );
        self.enforce_cap();
        Some(id)
    }

    /// The chunk of `id` for a frame (`frame_set_chunk_ref`); a miss for another epoch.
    pub fn get(&mut self, epoch: u32, id: u32) -> Option<Arc<Chunk>> {
        if epoch != self.epoch {
            return None;
        }
        let t = self.tick();
        let e = self.entries.get_mut(&id)?;
        e.last_used = t;
        Some(Arc::clone(&e.chunk))
    }

    /// The registered array was collected: the entry goes (a frame's `Arc` keeps drawing).
    pub fn release(&mut self, epoch: u32, id: u32) {
        if epoch == self.epoch {
            self.entries.remove(&id);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The bytes of every entry.
    pub fn bytes(&self) -> usize {
        self.entries.values().map(|e| e.bytes).sum()
    }

    /// The bytes of the entries no frame holds.
    pub fn unheld_bytes(&self) -> usize {
        self.entries
            .values()
            .filter(|e| Arc::strong_count(&e.chunk) == 1)
            .map(|e| e.bytes)
            .sum()
    }

    /// Evicts unheld chunks, least recently used first, until their bytes are within the cap. Run
    /// on every insert, and whenever a frame drops or replaces a chunk (`web`: after each change of
    /// a frame's data) and at each tick (`DecodeService::take_done`): a chunk becomes unheld when
    /// the last frame holding it lets it go, not only when another arrives.
    pub fn enforce_cap(&mut self) {
        let mut unheld: Vec<(u64, u32, usize)> = self
            .entries
            .iter()
            .filter(|(_, e)| Arc::strong_count(&e.chunk) == 1)
            .map(|(id, e)| (e.last_used, *id, e.bytes))
            .collect();
        let mut total: usize = unheld.iter().map(|u| u.2).sum();
        if total <= self.cap {
            return;
        }
        unheld.sort_unstable();
        for (_, id, bytes) in unheld {
            if total <= self.cap {
                break;
            }
            self.entries.remove(&id);
            total -= bytes;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// One request's decode (pool side)

/// What render sends a request's task, in order.
#[derive(Debug)]
enum Msg {
    Slab(SharedBytes),
    End,
}

/// A request's result before it reaches the table.
#[derive(Debug)]
enum Outcome {
    Decoded {
        chunk: Chunk,
        head: Value,
        ts: Vec<f64>,
        vs: Vec<Vec<f64>>,
    },
    Failed(Failed),
}

/// What a task sends render: credits, the result, then the state back.
#[derive(Debug)]
enum Out {
    Credit { req: u32, bytes: u64 },
    Outcome { req: u32, outcome: Box<Outcome> },
    Home { req: u32, work: Box<Work> },
}

/// A request's decoder state, owned by render or by its one running pool task.
#[derive(Debug)]
struct Work {
    req: u32,
    rx: Receiver<Msg>,
    /// Messages taken off the queue.
    consumed: u64,
    /// Lives as long as the state (`WorkHandle`); only dropped with it.
    #[allow(dead_code)]
    token: Arc<()>,
    splitter: FrameSplitter,
    decoder: BodyDecoder,
    /// The joined chunk's id (the decoder's batch ids follow it).
    join_id: ChunkId,
    grid: Option<(u32, GridInfo)>,
    batches: Vec<Chunk>,
    coverage: Option<Coverage>,
    /// A result was sent: the rest of the body is only credited.
    settled: bool,
}

impl Work {
    fn fail(&mut self, req: u32, kind: Failure, message: String) -> Option<Outcome> {
        self.settled = true;
        self.batches = Vec::new();
        Some(Outcome::Failed(Failed {
            req,
            kind,
            row: None,
            coverage: None,
            planned: None,
            message,
        }))
    }

    /// The events of one decoder call; a result once one is known.
    fn events(&mut self, req: u32, ev: Vec<Event>) -> Option<Outcome> {
        for e in ev {
            if self.settled {
                return None;
            }
            match e {
                Event::Grid { part, info, .. } => {
                    if self.grid.is_some() {
                        return self.fail(req, Failure::Invalid, "more than one grid part".into());
                    }
                    self.grid = Some((part, info));
                }
                Event::Chunk { part, chunk, .. } => {
                    if self.grid.as_ref().map(|g| g.0) != Some(part) {
                        return self.fail(req, Failure::Invalid, "a chunk outside the grid".into());
                    }
                    self.batches.push(chunk);
                }
                Event::Coverage { part, coverage } => {
                    if self.grid.as_ref().map(|g| g.0) == Some(part) {
                        self.coverage = Some(coverage);
                    }
                }
                Event::Upstream { error, .. } => {
                    self.settled = true;
                    self.batches = Vec::new();
                    return Some(Outcome::Failed(Failed {
                        req,
                        kind: Failure::Error,
                        row: Some(row_json(&error)),
                        coverage: self.coverage.as_ref().map(coverage_json),
                        planned: self
                            .grid
                            .as_ref()
                            .and_then(|g| g.1.planned.as_deref())
                            .map(str::to_owned),
                        message: error.message.to_string(),
                    }));
                }
                Event::Failed { reason, .. } => {
                    return self.fail(req, Failure::of(&reason), reason.to_string());
                }
                Event::Truncated => {
                    return self.fail(req, Failure::Invalid, "the body ended without END".into());
                }
                Event::Verdict(Verdict::Incomplete(why)) => {
                    return self.fail(req, Failure::Invalid, why.into());
                }
                Event::PartEnd { .. } | Event::End | Event::Verdict(Verdict::Complete) => {}
            }
        }
        None
    }

    /// One slab through the splitter and the decoder.
    fn feed(&mut self, req: u32, slab: SharedBytes) -> Option<Outcome> {
        if self.settled {
            return None;
        }
        if let Err(e) = self.splitter.push(slab) {
            return self.stream_failed(req, e);
        }
        loop {
            match self.splitter.next() {
                Ok(Some(f)) => {
                    let ev = self.decoder.frame(f);
                    if let Some(o) = self.events(req, ev) {
                        return Some(o);
                    }
                }
                Ok(None) => return None,
                Err(e) => return self.stream_failed(req, e),
            }
        }
    }

    /// The byte stream cannot be read further: the open parts fail, and so does the request (with
    /// no part open yet, the stream error itself decides: a header over `max_payload` is a limit).
    fn stream_failed(&mut self, req: u32, e: DsfError) -> Option<Outcome> {
        let ev = self.decoder.fail_stream(e.clone());
        if let Some(o) = self.events(req, ev) {
            return Some(o);
        }
        let reason = PartError::Stream(e);
        self.fail(req, Failure::of(&reason), reason.to_string())
    }

    /// End of the body: the decoder's last events, then the join and the result.
    fn end(&mut self, req: u32) -> Option<Outcome> {
        if self.settled {
            return None;
        }
        if let Err(e) = self.splitter.finish() {
            return self.stream_failed(req, e);
        }
        let ev = self.decoder.finish();
        if let Some(o) = self.events(req, ev) {
            return Some(o);
        }
        if self.settled {
            return None;
        }
        let Some((_, info)) = self.grid.take() else {
            return self.fail(req, Failure::Invalid, "no grid part".into());
        };
        let batches = std::mem::take(&mut self.batches);
        let chunk = if batches.is_empty() {
            ChunkBuilder::grid(self.join_id, info.start_ms, info.step_ms, info.len).finish()
        } else {
            match join_grid(batches, self.join_id) {
                Ok(c) => c,
                Err(JoinError::Size) => {
                    return self.fail(req, Failure::Limit, "joined size".into());
                }
                Err(e) => return self.fail(req, Failure::Invalid, e.to_string()),
            }
        };
        self.settled = true;
        let len = info.len as usize;
        let ts: Vec<f64> = (0..len)
            .map(|k| (info.start_ms + info.step_ms * k as i64) as f64)
            .collect();
        let vs: Vec<Vec<f64>> = (0..chunk.series.len())
            .map(|s| {
                let base = s * len;
                (0..len)
                    .map(|k| {
                        let i = base + k;
                        let on = chunk
                            .present
                            .as_ref()
                            .is_none_or(|w| w.get(i / 64).is_some_and(|w| w >> (i % 64) & 1 == 1));
                        match chunk.values.get(i) {
                            Some(v) if on => *v,
                            _ => f64::NAN,
                        }
                    })
                    .collect()
            })
            .collect();
        let head = json!({
            "startMs": info.start_ms,
            "endMs": info.start_ms + (len as i64 - 1) * info.step_ms,
            "stepMs": info.step_ms,
            "planned": info.planned.as_deref(),
            "coverage": self.coverage.as_ref().map(coverage_json),
            "series": chunk.series.iter().map(series_json).collect::<Vec<_>>(),
        });
        Some(Outcome::Decoded {
            chunk,
            head,
            ts,
            vs,
        })
    }
}

/// A request's pool task: drains its queue in order, then sends its state back to render (an
/// aborted request's state is dropped here instead).
fn run(mut work: Box<Work>, aborted: Arc<AtomicBool>, out: Sender<Out>, hook: Option<Hook>) {
    if let Some(h) = hook {
        h();
    }
    let req = work.req;
    loop {
        if aborted.load(Ordering::Acquire) {
            // Abort: the queue, the decoder and every batch go with the request.
            return;
        }
        let Ok(msg) = work.rx.try_recv() else {
            break;
        };
        work.consumed += 1;
        let outcome = match msg {
            Msg::Slab(slab) => {
                let bytes = slab.len() as u64;
                let o = work.feed(req, slab);
                let _ = out.send(Out::Credit { req, bytes });
                o
            }
            Msg::End => work.end(req),
        };
        if let Some(outcome) = outcome {
            let _ = out.send(Out::Outcome {
                req,
                outcome: Box::new(outcome),
            });
        }
    }
    let _ = out.send(Out::Home { req, work });
}

// ---------------------------------------------------------------------------------------------
// The service (render side)

/// A request as render tracks it.
#[derive(Debug)]
struct Req {
    tx: Sender<Msg>,
    /// The decoder state while no task runs (`None`: a pool task has it).
    work: Option<Box<Work>>,
    token: Weak<()>,
    aborted: Arc<AtomicBool>,
    /// Messages sent.
    sent: u64,
    /// The body offset of the next byte (each slab keeps its offset mod 64).
    offset: u64,
}

/// The decode service (plan #68 D2 §3.2): per request a slab queue, its decoder (owned by render
/// or by its one running pool task) and an abort flag; at most `MAX_IN_FLIGHT` requests.
pub struct DecodeService {
    reqs: BTreeMap<u32, Req>,
    table: ChunkTable,
    spawner: Spawner,
    hook: Option<Hook>,
    tx: Sender<Out>,
    rx: Receiver<Out>,
    /// Results render made itself (`busy`, `ids` at begin).
    local: Vec<Done>,
    /// The next block of stream chunk ids: 2³² per request.
    next_block: u64,
}

impl std::fmt::Debug for DecodeService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DecodeService")
            .field("reqs", &self.reqs.len())
            .field("table", &self.table)
            .finish_non_exhaustive()
    }
}

/// The stream id space holds 2³¹ blocks of 2³² ids.
const BLOCKS: u64 = 1 << 31;

impl DecodeService {
    /// Main pauses reading at or above this many posted, unconsumed bytes; not a cap.
    pub const PAUSE_THRESHOLD_BYTES: usize = 8 << 20;
    /// DSF decodes per worker; one more answers `busy`.
    pub const MAX_IN_FLIGHT: usize = 2;

    /// A service of the worker of boot epoch `epoch`, its tasks on the rayon pool.
    pub fn new(epoch: u32) -> Self {
        Self::with_spawner(epoch, Box::new(rayon::spawn))
    }

    pub fn with_spawner(epoch: u32, spawner: Spawner) -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            reqs: BTreeMap::new(),
            table: ChunkTable::new(epoch),
            spawner,
            hook: None,
            tx,
            rx,
            local: Vec::new(),
            next_block: 0,
        }
    }

    /// A hook every pool task runs first (tests: which thread decodes).
    #[doc(hidden)]
    pub fn set_task_hook(&mut self, hook: Arc<dyn Fn() + Send + Sync>) {
        self.hook = Some(hook);
    }

    /// Whether `req`'s decoder state still exists (tests: an abort frees it).
    #[doc(hidden)]
    pub fn work_handle(&self, req: u32) -> Option<WorkHandle> {
        self.reqs.get(&req).map(|r| WorkHandle(r.token.clone()))
    }

    pub fn table(&self) -> &ChunkTable {
        &self.table
    }

    pub fn table_mut(&mut self) -> &mut ChunkTable {
        &mut self.table
    }

    fn refuse(&mut self, req: u32, kind: Failure, message: &str) {
        self.local.push(Done::Failed(Failed {
            req,
            kind,
            row: None,
            coverage: None,
            planned: None,
            message: message.to_owned(),
        }));
    }

    /// A new decode: `busy` beyond `MAX_IN_FLIGHT`, `ids` when the stream ids are used up. A
    /// request id already in flight is ignored.
    pub fn begin(&mut self, req: u32) {
        if self.reqs.contains_key(&req) {
            return;
        }
        if self.reqs.len() >= Self::MAX_IN_FLIGHT {
            self.refuse(req, Failure::Busy, "too many decodes in flight");
            return;
        }
        if self.next_block >= BLOCKS {
            self.refuse(req, Failure::Ids, "no stream chunk id left");
            return;
        }
        let base = self.next_block << 32;
        self.next_block += 1;
        let (tx, rx) = mpsc::channel();
        let token = Arc::new(());
        let weak = Arc::downgrade(&token);
        let work = Work {
            req,
            rx,
            consumed: 0,
            token,
            splitter: FrameSplitter::new(),
            decoder: BodyDecoder::new(base + 1),
            join_id: ChunkId(base),
            grid: None,
            batches: Vec::new(),
            coverage: None,
            settled: false,
        };
        self.reqs.insert(
            req,
            Req {
                tx,
                work: Some(Box::new(work)),
                token: weak,
                aborted: Arc::new(AtomicBool::new(false)),
                sent: 0,
                offset: 0,
            },
        );
    }

    /// One read of `req`'s body, of any size: copied into slabs (the browser's copy) and queued.
    pub fn push(&mut self, req: u32, bytes: &[u8]) {
        let Some(r) = self.reqs.get_mut(&req) else {
            return;
        };
        for slab in slabs_from(bytes, r.offset, MAX_CHUNK) {
            if r.tx.send(Msg::Slab(slab)).is_ok() {
                r.sent += 1;
            }
        }
        r.offset += bytes.len() as u64;
    }

    /// The end of `req`'s body.
    pub fn end(&mut self, req: u32) {
        if let Some(r) = self.reqs.get_mut(&req)
            && r.tx.send(Msg::End).is_ok()
        {
            r.sent += 1;
        }
    }

    /// The fetch was aborted: the queue, the decoder and every batch chunk of `req` are dropped
    /// (by its running task, else here), and it has no result.
    pub fn abort(&mut self, req: u32) {
        if let Some(r) = self.reqs.remove(&req) {
            r.aborted.store(true, Ordering::Release);
        }
    }

    /// Starts a pool task for each request with queued messages and none running.
    pub fn pump(&mut self) {
        for r in self.reqs.values_mut() {
            let pending = r.work.as_ref().is_some_and(|w| w.consumed < r.sent);
            if !pending {
                continue;
            }
            let Some(work) = r.work.take() else {
                continue;
            };
            let aborted = Arc::clone(&r.aborted);
            let out = self.tx.clone();
            let hook = self.hook.clone();
            (self.spawner)(Box::new(move || run(work, aborted, out, hook)));
        }
    }

    /// The results since the last call, credits merged per request: a decoded chunk goes into the
    /// table here (`ids` when the table has no id left). Also starts the tasks `pump` would.
    pub fn take_done(&mut self) -> Vec<Done> {
        self.pump();
        self.table.enforce_cap();
        let mut out = std::mem::take(&mut self.local);
        let mut credits: BTreeMap<u32, u64> = BTreeMap::new();
        while let Ok(o) = self.rx.try_recv() {
            match o {
                Out::Credit { req, bytes } => {
                    if self.reqs.contains_key(&req) {
                        *credits.entry(req).or_default() += bytes;
                    }
                }
                Out::Home { req, work } => {
                    // A finished or aborted request's state is dropped here.
                    if let Some(r) = self.reqs.get_mut(&req) {
                        r.work = Some(work);
                    }
                }
                Out::Outcome { req, outcome } => {
                    if self.reqs.remove(&req).is_none() {
                        continue;
                    }
                    out.push(match *outcome {
                        Outcome::Failed(f) => Done::Failed(f),
                        Outcome::Decoded {
                            chunk,
                            head,
                            ts,
                            vs,
                        } => match self.table.insert(Arc::new(chunk)) {
                            Some(id) => Done::Decoded(Decoded {
                                req,
                                chunk: id,
                                epoch: self.table.epoch(),
                                head,
                                ts,
                                vs,
                            }),
                            None => Done::Failed(Failed {
                                req,
                                kind: Failure::Ids,
                                row: None,
                                coverage: None,
                                planned: None,
                                message: "no chunk id left".into(),
                            }),
                        },
                    });
                }
            }
        }
        let mut credited: Vec<Done> = credits
            .into_iter()
            .map(|(req, bytes)| Done::Credit { req, bytes })
            .collect();
        credited.append(&mut out);
        credited
    }

    /// Requests begun and not yet ended (the probe's `chunks().inflight`).
    pub fn in_flight(&self) -> usize {
        self.reqs.len()
    }

    /// Decodes in flight: `engine_wants_frame` stays true.
    pub fn busy(&self) -> bool {
        !self.reqs.is_empty() || !self.local.is_empty()
    }
}
