//! Mark descriptions (feature-free; `dash-scene` depends only on these) and, under feature `gpu`,
//! the M1 line pipeline with GPU decimation (plan #68 §3.10) and the overlay pipeline (plan #68
//! C2b).

pub mod desc;
#[cfg(feature = "gpu")]
pub mod line;
#[cfg(feature = "gpu")]
mod overlay;

pub use desc::{DrawList, DrawnEvent, Emphasis, MarkItem, OverlayShape};
