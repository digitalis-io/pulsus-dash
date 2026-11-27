//! The engine in the browser (plan #68 C1 §3.3, §3.4, §4): the render worker's frame table
//! ([`frames`]) and its events ([`events`]), both target-independent, and on wasm32 the
//! wasm-bindgen exports, the GPU surfaces, the frame loop and the rayon pool (`web`).

#[cfg(feature = "mt")]
pub mod decode;
pub mod error;
pub mod events;
pub mod frames;
pub mod input;
pub mod recovery;

#[cfg(target_arch = "wasm32")]
mod web;

pub use error::CoreError;
