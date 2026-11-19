//! Golden-image harness. Design: T05 §4.2. #24 adds the headless lavapipe device ([`headless`],
//! T05-004) and the line-chart renders, masks and decimation reference ([`line`]) of
//! `golden:decimation-ref`.

pub mod headless;
pub mod line;

pub use headless::{GoldenError, Headless};
pub use line::{LineData, Render, View, assert_zero_diff, frame, records, render, render_mask};
