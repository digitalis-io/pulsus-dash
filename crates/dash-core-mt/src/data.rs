//! The data worker (mt only): data-0 publishes the spike scene's instances into the shared chunk
//! table, where the render worker pins them (T03-007, T01-004).

#[cfg(target_feature = "atomics")]
use wasm_bindgen::prelude::*;

/// Publishes `instances(7)` from data worker `index` (0 = the coordinator, "data-0").
#[cfg(target_feature = "atomics")]
#[wasm_bindgen]
pub fn data_start(index: u32, _query: String) {
    let producer = if index == 0 { "data-0" } else { "data" };
    crate::chunk::publish(crate::chunk::InstanceChunk {
        generation: 1,
        producer,
        cols: dash_scene::spike::instances(crate::render::SPIKE_SEED),
    });
}
