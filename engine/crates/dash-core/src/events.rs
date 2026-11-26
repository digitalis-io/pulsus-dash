//! The JSON events the render worker posts to the main thread (plan #68 C1 §3.4): `a11y` (the TS
//! `FrameSummary`), `drawn` (ADR-0019, with the times and series count of the `chart-draw`
//! measure) and `failed` (the frame falls back to Canvas 2D). `engine_tick` joins them into one
//! JSON array per frame.

use dash_marks::DrawnEvent;
use serde_json::json;

/// Why a frame falls back to Canvas 2D.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailReason {
    /// Its surface could not be configured or presented.
    Surface,
    /// Its status read-back failed three times in a row.
    Readback,
    /// A device restore landed on another tier than its canvas was set up for.
    Tier,
}

impl FailReason {
    pub fn as_str(self) -> &'static str {
        match self {
            FailReason::Surface => "surface",
            FailReason::Readback => "readback",
            FailReason::Tier => "tier",
        }
    }
}

/// `{"t":"a11y","id":…,"ev":<summary>}`; `summary_json` is one JSON object.
pub fn a11y(id: u32, summary_json: &str) -> String {
    format!(r#"{{"t":"a11y","id":{id},"ev":{summary_json}}}"#)
}

/// `{"t":"drawn","id":…,"ev":{"cssWidth","cssHeight","dpr"},"startMs":…,"endMs":…,"series":…}`;
/// the times are on the main thread's time origin.
pub fn drawn(id: u32, ev: &DrawnEvent, start_ms: f64, end_ms: f64, series: u32) -> String {
    json!({
        "t": "drawn",
        "id": id,
        "ev": ev,
        "startMs": start_ms,
        "endMs": end_ms,
        "series": series,
    })
    .to_string()
}

/// `{"t":"tier","tier":"t1"|"t2"}`: the engine's tier after a device restore changed it.
pub fn tier(t: dash_gpu::Tier) -> String {
    let name = match t {
        dash_gpu::Tier::T1 => "t1",
        dash_gpu::Tier::T2 => "t2",
    };
    json!({"t": "tier", "tier": name}).to_string()
}

/// `{"t":"failed","id":…,"reason":"surface"|"readback"|"tier"}`.
pub fn failed(id: u32, reason: FailReason) -> String {
    json!({"t": "failed", "id": id, "reason": reason.as_str()}).to_string()
}

/// `{"t":"fatal","reason":…}`: the engine cannot go on (a second device loss within 60 s); the
/// main thread treats it as a second trap (plan #68 C1 §4.3).
pub fn fatal(reason: &str) -> String {
    json!({"t": "fatal", "reason": reason}).to_string()
}

/// The events of one tick as a JSON array, or "" when there are none.
pub fn batch(events: &[String]) -> String {
    if events.is_empty() {
        return String::new();
    }
    let mut s = String::from("[");
    s.push_str(&events.join(","));
    s.push(']');
    s
}
