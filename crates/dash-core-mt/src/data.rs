//! The data worker's export (mt only). Stub.

#[cfg(target_feature = "atomics")]
use wasm_bindgen::prelude::*;

#[cfg(target_feature = "atomics")]
#[wasm_bindgen]
pub fn data_start(_index: u32, _query: String) {}
