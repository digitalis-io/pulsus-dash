//! The render worker's exports (T03 §4.5 frame loop). Stub.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub async fn render_start(
    _canvas: web_sys::OffscreenCanvas,
    _caps: u32,
    _main_time_origin: f64,
    _query: String,
) -> u32 {
    4
}

#[wasm_bindgen]
pub fn render_frame(_t_ms: f64) -> bool {
    false
}

#[wasm_bindgen]
pub fn render_status() -> u32 {
    4
}

#[wasm_bindgen]
pub fn render_input(_bytes: &[u8], _dropped: u32) {}

#[wasm_bindgen]
pub fn control_block() -> u32 {
    0
}

#[wasm_bindgen]
pub fn layout_version() -> u32 {
    0
}
