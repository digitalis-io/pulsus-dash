//! Mark pipelines. Design: T02. #23 adds the minimal M3 rect pipeline ([`rect`]); #24 adds the
//! M1 line mark with GPU decimation ([`line`]) and capsule segments for the minimal axes
//! ([`segment`]).

pub mod line;
pub mod rect;
pub mod segment;
