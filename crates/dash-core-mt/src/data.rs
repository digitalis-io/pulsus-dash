//! The data worker (mt only): data-0 publishes the scene's data into the shared tables, where
//! the render worker pins it (T03-007, T01-004): the spike's instances, or with `?scene=line`
//! the line layer (#24 plan §4.1).

#[cfg(target_feature = "atomics")]
use wasm_bindgen::prelude::*;

/// Publishes the scene's data from data worker `index` (0 = the coordinator, "data-0").
#[cfg(target_feature = "atomics")]
#[wasm_bindgen]
pub fn data_start(index: u32, query: String) {
    let producer = if index == 0 { "data-0" } else { "data" };
    match crate::flags::parse_scene(&query) {
        crate::flags::SceneKind::Line(p) => {
            if index == 0 {
                let held = p.series.min(crate::line_table::MAX_SERIES as u32);
                // An error is kept in the table (`load_failed`) and shown on the page.
                let _ = crate::line_load::run(
                    &crate::line_table::TABLE,
                    p,
                    held,
                    producer,
                    crate::render::line_fault(&query),
                );
            }
        }
        crate::flags::SceneKind::Rect => crate::chunk::publish(crate::chunk::InstanceChunk {
            generation: 1,
            producer,
            cols: dash_scene::spike::instances(crate::render::SPIKE_SEED),
        }),
    }
}
