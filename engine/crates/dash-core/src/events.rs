//! The JSON events the render worker posts to the main thread (plan #68 C1 §3.4).

use dash_marks::DrawnEvent;

/// Why a frame falls back to Canvas 2D.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailReason {
    Surface,
    Readback,
}

/// `{"t":"a11y","id":…,"ev":<summary>}`.
pub fn a11y(id: u32, summary_json: &str) -> String {
    let _ = (id, summary_json);
    String::new()
}

/// `{"t":"drawn","id":…,"ev":{…},"startMs":…,"endMs":…,"series":…}`.
pub fn drawn(id: u32, ev: &DrawnEvent, start_ms: f64, end_ms: f64, series: u32) -> String {
    let _ = (id, ev, start_ms, end_ms, series);
    String::new()
}

/// `{"t":"failed","id":…,"reason":"surface"|"readback"}`.
pub fn failed(id: u32, reason: FailReason) -> String {
    let _ = (id, reason);
    String::new()
}
