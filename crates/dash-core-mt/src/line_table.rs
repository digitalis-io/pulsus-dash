//! The line chunk table (T03-007; plan #24 §3.7): data-0 publishes one immutable chunk per series,
//! in id order; the render worker pins them without locks.

use std::sync::Arc;
use std::sync::atomic::Ordering::{Acquire, Release};
use std::sync::atomic::{AtomicBool, AtomicU32};

use arc_swap::ArcSwapOption;
use dash_scales::lod::Prepared;
use dash_wire::{GridMeta, GridSeries};

/// Series slots of the table.
pub const MAX_SERIES: usize = 1024;

/// The layer being loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayerMeta {
    pub grid: GridMeta,
    pub requested: u32,
    pub held: u32,
    pub producer: &'static str,
}

/// One published series.
#[derive(Clone, Debug, PartialEq)]
pub struct LineChunk {
    pub id: u32,
    pub series: GridSeries,
    pub prepared: Prepared,
}

/// Why a chunk was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishError {
    OutOfOrder { expected: u32, got: u32 },
}

/// The table: a layer, `MAX_SERIES` chunk slots and the published count.
#[derive(Debug)]
pub struct LineTable {
    layer: ArcSwapOption<LayerMeta>,
    chunks: [ArcSwapOption<LineChunk>; MAX_SERIES],
    published: AtomicU32,
    load_failed: AtomicBool,
}

/// The runtime's table.
pub static TABLE: LineTable = LineTable::new();

impl Default for LineTable {
    fn default() -> Self {
        Self::new()
    }
}

impl LineTable {
    pub const fn new() -> Self {
        LineTable {
            layer: ArcSwapOption::const_empty(),
            chunks: [const { ArcSwapOption::const_empty() }; MAX_SERIES],
            published: AtomicU32::new(0),
            load_failed: AtomicBool::new(false),
        }
    }

    /// Publishes the layer (before its first chunk).
    pub fn publish_layer(&self, m: LayerMeta) {
        self.layer.store(Some(Arc::new(m)));
    }

    pub fn layer(&self) -> Option<Arc<LayerMeta>> {
        self.layer.load_full()
    }

    /// Publishes the next chunk: stores it, then `published += 1` (Release). Single producer;
    /// a chunk out of id order (or beyond the table) is refused and nothing changes.
    pub fn publish_chunk(&self, c: LineChunk) -> Result<(), PublishError> {
        let expected = self.published.load(Acquire);
        let Some(slot) = self.chunks.get(c.id as usize).filter(|_| c.id == expected) else {
            return Err(PublishError::OutOfOrder {
                expected,
                got: c.id,
            });
        };
        slot.store(Some(Arc::new(c)));
        self.published.store(expected + 1, Release);
        Ok(())
    }

    /// Chunks published so far (Acquire: every chunk below it is visible).
    pub fn published(&self) -> u32 {
        self.published.load(Acquire)
    }

    /// Pins chunk `i` (refcount increment) if it is published. Never waits (T03-008).
    pub fn pin(&self, i: u32) -> Option<Arc<LineChunk>> {
        if i >= self.published() {
            return None;
        }
        self.chunks.get(i as usize)?.load_full()
    }

    pub fn set_load_failed(&self) {
        self.load_failed.store(true, Release);
    }

    pub fn load_failed(&self) -> bool {
        self.load_failed.load(Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dash_wire::GridMeta;

    fn meta() -> LayerMeta {
        LayerMeta {
            grid: GridMeta {
                start_ms: 0,
                step_ms: 10,
                len: 4,
                result: "metric".into(),
                source: "synth".into(),
                unit: String::new(),
            },
            requested: 6,
            held: 6,
            producer: "test",
        }
    }

    fn chunk(id: u32) -> LineChunk {
        LineChunk {
            id,
            series: GridSeries {
                series_id: id,
                values: vec![1.0, 2.0, 3.0, 4.0].into(),
                validity: None,
            },
            prepared: Prepared {
                v_ref: 2.5,
                min: 1.0,
                max: 4.0,
            },
        }
    }

    #[test]
    fn line_table_in_order() {
        let t = LineTable::new();
        assert!(t.layer().is_none());
        assert!(t.pin(0).is_none());
        t.publish_layer(meta());
        assert_eq!(t.layer().unwrap().producer, "test");
        for id in 0..3 {
            t.publish_chunk(chunk(id)).unwrap();
        }
        assert_eq!(t.published(), 3);
        assert_eq!(t.pin(1).unwrap().id, 1);
        assert!(t.pin(3).is_none());
        assert_eq!(
            t.publish_chunk(chunk(5)),
            Err(PublishError::OutOfOrder {
                expected: 3,
                got: 5
            })
        );
        assert_eq!(t.published(), 3);
        assert!(!t.load_failed());
        t.set_load_failed();
        assert!(t.load_failed());
    }
}
