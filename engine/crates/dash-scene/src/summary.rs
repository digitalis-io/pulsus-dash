//! The `a11y` frame summary and ADR-0020's commit event, field for field with the TS types.

use dash_axes::{PlotRect, VisKind};

use crate::spec::ValueRange;

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeWindow {
    pub from_ms: f64,
    pub to_ms: f64,
}

/// A new manual value range, or `"auto"` (ADR-0020's `value`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ValueCommit {
    Range(ValueRange),
    Auto,
}

impl serde::Serialize for ValueCommit {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            ValueCommit::Range(r) => serde::Serialize::serialize(r, s),
            ValueCommit::Auto => s.serialize_str("auto"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Gesture {
    Wheel,
    Pan,
    Axis,
    Fit,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct CommitEvent {
    pub window: Option<TimeWindow>,
    pub value: Option<ValueCommit>,
    pub gesture: Gesture,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValueAxisSummary {
    pub min: f64,
    pub max: f64,
    pub manual: bool,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameSummary {
    pub kind: VisKind,
    pub series_total: u32,
    pub series_shown: u32,
    pub from_ms: f64,
    pub to_ms: f64,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub last: Option<f64>,
    pub plot: PlotRect,
    /// The drawn domain; None for heatmap and stat.
    pub value_axis: Option<ValueAxisSummary>,
}
