//! The DSF decode service of the MT engine (plan #68 D2 §3.2; T03 §6; ADR-0034).
#![allow(clippy::missing_const_for_fn, unused_variables, dead_code)]

use std::sync::{Arc, Weak};

use dash_wire::Chunk;
use serde_json::Value;

/// Why a decode failed (`decode-failed{kind}`).
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
}

/// A decoded range.
#[derive(Clone, Debug, PartialEq)]
pub struct Decoded {
    pub req: u32,
    pub chunk: u32,
    pub epoch: u32,
    pub head: Value,
    pub ts: Vec<f64>,
    pub vs: Vec<Vec<f64>>,
}

/// A failed decode.
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
    Credit { req: u32, bytes: u64 },
    Decoded(Decoded),
    Failed(Failed),
}

/// How a pool task is started.
pub type Spawner = Box<dyn Fn(Box<dyn FnOnce() + Send + 'static>)>;

/// A test's view of whether a request's state is still alive.
#[derive(Debug)]
pub struct WorkHandle(Weak<()>);

impl WorkHandle {
    pub fn alive(&self) -> bool {
        self.0.strong_count() > 0
    }
}

/// The per-worker chunk table.
#[derive(Debug)]
pub struct ChunkTable {
    epoch: u32,
}

impl ChunkTable {
    pub const CAP_UNHELD_BYTES: usize = 256 << 20;

    pub fn new(epoch: u32) -> Self {
        Self { epoch }
    }
    pub fn with_cap(epoch: u32, cap: usize) -> Self {
        Self { epoch }
    }
    #[doc(hidden)]
    pub fn set_next(&mut self, next: u32) {}
    pub fn epoch(&self) -> u32 {
        self.epoch
    }
    pub fn insert(&mut self, c: Arc<Chunk>) -> Option<u32> {
        None
    }
    pub fn get(&mut self, epoch: u32, id: u32) -> Option<Arc<Chunk>> {
        None
    }
    pub fn release(&mut self, epoch: u32, id: u32) {}
    pub fn len(&self) -> usize {
        0
    }
    pub fn is_empty(&self) -> bool {
        true
    }
    pub fn bytes(&self) -> usize {
        0
    }
    pub fn unheld_bytes(&self) -> usize {
        0
    }
}

/// The decode service.
pub struct DecodeService {
    table: ChunkTable,
}

impl std::fmt::Debug for DecodeService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DecodeService").finish_non_exhaustive()
    }
}

impl DecodeService {
    pub const PAUSE_THRESHOLD_BYTES: usize = 8 << 20;
    pub const MAX_IN_FLIGHT: usize = 2;

    pub fn new(epoch: u32) -> Self {
        Self {
            table: ChunkTable::new(epoch),
        }
    }
    pub fn with_spawner(epoch: u32, spawner: Spawner) -> Self {
        Self::new(epoch)
    }
    #[doc(hidden)]
    pub fn set_task_hook(&mut self, hook: Arc<dyn Fn() + Send + Sync>) {}
    #[doc(hidden)]
    pub fn work_handle(&self, req: u32) -> Option<WorkHandle> {
        None
    }
    pub fn table(&self) -> &ChunkTable {
        &self.table
    }
    pub fn table_mut(&mut self) -> &mut ChunkTable {
        &mut self.table
    }
    pub fn begin(&mut self, req: u32) {}
    pub fn push(&mut self, req: u32, bytes: &[u8]) {}
    pub fn end(&mut self, req: u32) {}
    pub fn abort(&mut self, req: u32) {}
    pub fn pump(&mut self) {}
    pub fn take_done(&mut self) -> Vec<Done> {
        Vec::new()
    }
    pub fn busy(&self) -> bool {
        false
    }
}
