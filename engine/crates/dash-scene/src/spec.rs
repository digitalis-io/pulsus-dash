//! Visualisation specs (the TS `VisSpec` subset the engine draws now).

use dash_axes::VisKind;
use dash_scales::Range64;
use dash_units::Unit;

/// ADR-0020's `valueRange`.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ValueRange {
    pub min: f64,
    pub max: f64,
}

impl ValueRange {
    /// Some(self) when both ends are finite and min < max.
    pub fn validated(self) -> Option<Range64> {
        (self.min.is_finite() && self.max.is_finite() && self.min < self.max).then_some(Range64 {
            lo: self.min,
            hi: self.max,
        })
    }
}

fn max_series_default() -> u32 {
    500
}

/// A threshold's state (ADR-0022): its line's colour (T02-004).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThresholdState {
    Watch,
    Degraded,
    Failing,
}

/// One threshold line of a spec (TS `ThresholdLine`); its `label` is drawn with the engine's text
/// mark (#69) and ignored until then.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
pub struct ThresholdLine {
    /// None: JSON `null`, which is what `JSON.stringify` writes for NaN and ±∞ (not drawn).
    pub value: Option<f64>,
    pub state: ThresholdState,
}

/// The most threshold lines a frame draws, in spec order (TS `MAX_THRESHOLDS`, ADR-0022).
pub const MAX_THRESHOLDS: usize = 8;

/// The spec's threshold lines, the first [`MAX_THRESHOLDS`] kept (TS `thresholdsOf`).
fn first_eight<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<ThresholdLine>, D::Error> {
    let mut lines = <Vec<ThresholdLine> as serde::Deserialize>::deserialize(d)?;
    lines.truncate(MAX_THRESHOLDS);
    Ok(lines)
}

/// A line spec, parsed from the TS JSON.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineSpec {
    pub unit: Unit,
    #[serde(default)]
    pub value_range: Option<ValueRange>,
    /// The first [`MAX_THRESHOLDS`] lines, in spec order (TS `thresholdsOf`).
    #[serde(default, deserialize_with = "first_eight")]
    pub thresholds: Vec<ThresholdLine>,
    /// The gradient area under 1–4 series (ADR-0036); absent = false (no area).
    #[serde(default)]
    pub area: bool,
    /// 500 while the interim cap holds (ADR-0014 §4).
    #[serde(skip, default = "max_series_default")]
    pub max_series: u32,
}

impl LineSpec {
    pub fn new(unit: Unit) -> Self {
        Self {
            unit,
            value_range: None,
            thresholds: Vec::new(),
            area: false,
            max_series: max_series_default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum VisSpec {
    Line(LineSpec),
    Unsupported(VisKind),
}

/// A spec the engine cannot read (plan #68 C1 §3.4).
#[derive(Debug, PartialEq, thiserror::Error)]
#[error("spec: {0}")]
pub struct SpecError(pub String);

impl VisSpec {
    /// The TS `VisSpec` JSON: `line` → [`LineSpec`] (unknown fields ignored), `bars`, `heatmap`
    /// and `stat` → `Unsupported`, anything else → [`SpecError`].
    pub fn from_json(json: &str) -> Result<Self, SpecError> {
        #[derive(serde::Deserialize)]
        struct Kind {
            kind: String,
        }
        let err = |e: serde_json::Error| SpecError(e.to_string());
        let Kind { kind } = serde_json::from_str(json).map_err(err)?;
        match kind.as_str() {
            "line" => serde_json::from_str::<LineSpec>(json)
                .map(VisSpec::Line)
                .map_err(err),
            "bars" => Ok(VisSpec::Unsupported(VisKind::Bars)),
            "heatmap" => Ok(VisSpec::Unsupported(VisKind::Heatmap)),
            "stat" => Ok(VisSpec::Unsupported(VisKind::Stat)),
            other => Err(SpecError(format!("unknown kind {other:?}"))),
        }
    }
}
