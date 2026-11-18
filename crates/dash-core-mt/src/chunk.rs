//! The published instance chunk (T03-007): written once by its producer, then immutable; the
//! render worker pins it per frame. Stub.

use std::sync::Arc;

use arc_swap::ArcSwapOption;
use dash_scene::spike::InstanceColumns;

/// One published, immutable chunk of instances.
#[derive(Debug)]
pub struct InstanceChunk {
    pub generation: u32,
    pub producer: &'static str,
    pub cols: InstanceColumns,
}

/// The chunk table of the spike: one slot.
pub static INSTANCES: ArcSwapOption<InstanceChunk> = ArcSwapOption::const_empty();

/// Publishes `c`, replacing the previous chunk (freed when its last pin drops).
pub fn publish(_c: InstanceChunk) {}

/// Pins the current chunk (refcount increment), if any.
pub fn pin() -> Option<Arc<InstanceChunk>> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use dash_scene::spike::instances;

    #[test]
    fn chunk_pin_survives_republish() {
        publish(InstanceChunk {
            generation: 1,
            producer: "test",
            cols: instances(1),
        });
        let old = pin().expect("published");
        publish(InstanceChunk {
            generation: 2,
            producer: "test",
            cols: instances(2),
        });
        assert_eq!(old.generation, 1);
        assert_eq!(old.cols.xy.len(), 10_000);
        assert_eq!(Arc::strong_count(&old), 1);
        assert_eq!(pin().expect("republished").generation, 2);
    }
}
