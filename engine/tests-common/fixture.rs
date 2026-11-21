//! Shared by the parity tests: loads `engine/fixtures/<name>.json` (written by
//! `client/scripts/engine-fixtures.ts`). Non-finite numbers are the strings "NaN", "Infinity" and
//! "-Infinity". A missing fixture loads as an empty list, so a test asserts it is non-empty.
#![allow(dead_code)]

use serde_json::Value;

pub fn path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(name)
}

pub fn load(name: &str) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path(name)) else {
        return Vec::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(rows)) => rows,
        _ => Vec::new(),
    }
}

/// A fixture number: a JSON number or one of the non-finite strings.
pub fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) if s == "Infinity" => f64::INFINITY,
        Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        _ => f64::NAN,
    }
}

pub fn nums(v: &Value) -> Vec<f64> {
    v.as_array()
        .map(|a| a.iter().map(num).collect())
        .unwrap_or_default()
}

/// Bit equality with NaN == NaN.
pub fn same(a: f64, b: f64) -> bool {
    a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
}
