//! Mark descriptions (feature-free; `dash-scene` depends only on these) and, under feature `gpu`,
//! the M1 line pipeline with GPU decimation (plan #68 §3.10).

pub mod desc;
#[cfg(feature = "gpu")]
pub mod line;

pub use desc::{DrawList, DrawnEvent, MarkItem, OverlayShape};
