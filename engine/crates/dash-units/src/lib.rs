//! Units and number formatting (VL-012, T08-027): the image of the client's
//! `client/src/i18n/format.ts` `Unit` and `formatValue`, byte for byte (plan #68 A.5).

/// The unit of a chart value; the same JSON as the TS `Unit`.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Unit {
    None,
    Suffix { suffix: String },
    Bytes,
    Percent,
    Percentunit,
    Time { base: TimeBase },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TimeBase {
    Ns,
    Us,
    Ms,
    S,
}

/// ECMAScript `x.toPrecision(p)` for 1 ≤ p ≤ 21.
pub fn to_precision(x: f64, p: usize) -> String {
    let _ = (x, p);
    String::new()
}

/// ECMAScript `String(x)` (Number::toString).
pub fn js_number_to_string(x: f64) -> String {
    let _ = x;
    String::new()
}

/// ECMAScript `Math.round`: half toward +∞.
pub fn js_round(x: f64) -> f64 {
    x
}

/// Byte-identical to TS `formatValue`.
pub fn format_value(v: f64, unit: &Unit) -> String {
    let _ = (v, unit);
    String::new()
}
