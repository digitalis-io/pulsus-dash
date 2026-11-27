//! route_parity (plan #68 Part D1 §3.5, §5): the PromQL range route's DSF bodies, written by the
//! BFF's real handler into `wire/fixtures/route/`, decoded with `dash-wire`, carry what the JSON
//! bodies of the same requests carry, field by field; a mid-stream failure's `error/1` row and the
//! JSON envelope of the same error before the header follow the same mapping (§3.4). The fixtures
//! were written with the clock fixed at 2026-11-19T13:00Z.
mod common;
mod support;

use std::collections::BTreeMap;
use std::path::PathBuf;

use dash_wire::{Coverage, ErrorRow, Event, Phase, Verdict};
use serde_json::Value;

/// `Deps.Now` of the fixtures (ms).
const NOW_MS: i64 = 1_795_093_200_000;

/// The cases with a complete JSON body.
const PAIRS: [&str; 7] = [
    "two-series",
    "gaps",
    "empty",
    "types-warning",
    "read-cache",
    "future-sample",
    "many",
];

/// The failure classes: `mid-failure-<class>.dsf` and `err-<class>.json`.
const CLASSES: [&str; 6] = [
    "query-invalid",
    "too-broad",
    "rate-limited",
    "timeout",
    "unavailable",
    "internal",
];

/// The PromQL types warning (`promplan.WarnTypesUnavailable`).
const TYPES_WARNING: &str = "pulsus-dash: metric types unavailable, so only names ending in _total are rated (metric_types_unavailable)";

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../wire/fixtures/route")
}

fn read(name: &str) -> Vec<u8> {
    let p = dir().join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

fn json(name: &str) -> Value {
    serde_json::from_slice(&read(name)).unwrap_or_else(|e| panic!("parse {name}: {e}"))
}

/// One decoded series: key (16 hex digits), labels, values and validity.
#[derive(Debug)]
struct Series {
    key: String,
    labels: Vec<(String, String)>,
    values: Vec<f64>,
    valid: Vec<bool>,
}

/// The data part of a body, as `dash-wire` decodes it.
#[derive(Debug, Default)]
struct Decoded {
    planned: Option<String>,
    start_ms: i64,
    requested_start_ms: i64,
    step_ms: i64,
    len: u32,
    series: Vec<Series>,
    coverage: Vec<Coverage>,
    error: Option<ErrorRow>,
    stream_errors: Vec<ErrorRow>,
    ended: bool,
    verdict: Option<Verdict>,
}

fn decode(name: &str) -> Decoded {
    let body = read(name);
    let ev = support::run(&body, 1);
    let mut d = Decoded::default();
    let mut data = None;
    for e in &ev {
        match e {
            Event::Grid { part, info, .. } => {
                data = Some(*part);
                d.planned = info.planned.as_deref().map(str::to_owned);
                d.start_ms = info.start_ms;
                d.requested_start_ms = info.requested_start_ms;
                d.step_ms = info.step_ms;
                d.len = info.len;
            }
            Event::Chunk { chunk, .. } => {
                for (s, meta) in chunk.series.iter().enumerate() {
                    let base = chunk.offsets[s] as usize;
                    let values = chunk.series_values(s).to_vec();
                    let valid = (0..values.len())
                        .map(|k| {
                            let i = base + k;
                            chunk
                                .present
                                .as_ref()
                                .is_none_or(|w| w[i / 64] >> (i % 64) & 1 == 1)
                        })
                        .collect();
                    d.series.push(Series {
                        key: format!("{:016x}", meta.key_hash),
                        labels: meta.labels.to_vec(),
                        values,
                        valid,
                    });
                }
            }
            Event::Coverage { coverage, .. } => d.coverage.push(coverage.clone()),
            Event::Upstream { part, error } => {
                if Some(*part) == data {
                    d.error = Some(error.clone());
                } else {
                    d.stream_errors.push(error.clone());
                }
            }
            Event::Failed { part, reason } => panic!("{name}: part {part} failed: {reason}"),
            Event::End => d.ended = true,
            Event::Verdict(v) => d.verdict = Some(v.clone()),
            _ => {}
        }
    }
    d
}

/// The planned member's bytes of a JSON range body: the first member, up to `,"start":`.
fn planned_bytes(body: &[u8]) -> String {
    let text = std::str::from_utf8(body).unwrap_or_else(|e| panic!("UTF-8 body: {e}"));
    let rest = text
        .strip_prefix(r#"{"planned":"#)
        .unwrap_or_else(|| panic!("planned first"));
    let end = rest
        .find(r#","start":"#)
        .unwrap_or_else(|| panic!("start after planned"));
    rest[..end].to_owned()
}

/// A JSON frame value: `None` absent, else the value.
fn value_of(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(match s.as_str() {
            "NaN" => f64::NAN,
            "+Inf" => f64::INFINITY,
            "-Inf" => f64::NEG_INFINITY,
            other => panic!("value string {other:?}"),
        }),
        Value::Number(n) => Some(n.as_f64().unwrap_or_else(|| panic!("f64"))),
        other => panic!("value {other:?}"),
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap_or_else(|| panic!("list"))
        .iter()
        .map(|s| s.as_str().unwrap_or_else(|| panic!("string")).to_owned())
        .collect()
}

fn final_coverage<'a>(name: &str, d: &'a Decoded) -> &'a Coverage {
    d.coverage
        .last()
        .unwrap_or_else(|| panic!("{name}: no coverage"))
}

/// §3.5 field by field for one case with a JSON pair.
fn check_pair(name: &str) {
    let raw = read(&format!("{name}.json"));
    let j: Value = serde_json::from_slice(&raw).unwrap_or_else(|e| panic!("JSON body: {e}"));
    let d = decode(&format!("{name}.dsf"));
    assert!(d.ended, "{name}: no END");
    assert_eq!(d.verdict, Some(Verdict::Complete), "{name}");
    assert!(d.error.is_none() && d.stream_errors.is_empty(), "{name}");

    assert_eq!(
        d.planned.as_deref(),
        Some(planned_bytes(&raw).as_str()),
        "{name}: planned"
    );
    let (start, end, step) = (
        j["start"].as_i64().unwrap_or_else(|| panic!("missing")),
        j["end"].as_i64().unwrap_or_else(|| panic!("missing")),
        j["step"].as_i64().unwrap_or_else(|| panic!("missing")),
    );
    assert_eq!(d.start_ms, start, "{name}: start");
    assert_eq!(d.step_ms, step, "{name}: step");
    assert_eq!(start + (i64::from(d.len) - 1) * step, end, "{name}: end");
    assert!(d.requested_start_ms >= start && d.requested_start_ms < start + step);

    let frames = j["frames"].as_array().unwrap_or_else(|| panic!("frames"));
    assert_eq!(frames.len(), d.series.len(), "{name}: series count");
    for (i, (f, s)) in frames.iter().zip(&d.series).enumerate() {
        assert_eq!(f["key"].as_str(), Some(s.key.as_str()), "{name} #{i}: key");
        let labels: BTreeMap<String, String> = f["labels"]
            .as_object()
            .unwrap_or_else(|| panic!("labels"))
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    v.as_str().unwrap_or_else(|| panic!("missing")).to_owned(),
                )
            })
            .collect();
        let got: BTreeMap<String, String> = s.labels.iter().cloned().collect();
        assert_eq!(labels, got, "{name} #{i}: labels");
        let ts = f["timestamps"]
            .as_array()
            .unwrap_or_else(|| panic!("timestamps"));
        let vs = f["values"].as_array().unwrap_or_else(|| panic!("values"));
        assert_eq!(ts.len(), s.values.len(), "{name} #{i}: points");
        for (k, (t, v)) in ts.iter().zip(vs).enumerate() {
            assert_eq!(t.as_i64(), Some(start + k as i64 * step), "{name} #{i}.{k}");
            match value_of(v) {
                None => assert!(!s.valid[k], "{name} #{i}.{k}: absent ↔ null"),
                Some(x) => {
                    assert!(s.valid[k], "{name} #{i}.{k}: present ↔ valid");
                    let y = s.values[k];
                    assert!(
                        x.to_bits() == y.to_bits() || (x.is_nan() && y.is_nan()),
                        "{name} #{i}.{k}: {x} vs {y}"
                    );
                }
            }
        }
    }

    let c = &j["completeness"];
    let cov = final_coverage(name, &d);
    assert_eq!(cov.phase, Phase::Final, "{name}");
    assert_eq!(
        cov.series_returned as usize,
        d.series.len(),
        "{name}: series_returned"
    );
    assert_eq!(
        Some(cov.truncated),
        c["truncated"].as_bool(),
        "{name}: truncated"
    );
    assert_eq!(
        cov.warnings.iter().collect::<Vec<_>>(),
        strs(&c["warnings"]),
        "{name}: warnings"
    );
    assert_eq!(
        cov.infos.iter().collect::<Vec<_>>(),
        strs(&c["infos"]),
        "{name}: infos"
    );
    assert_eq!(
        cov.upstream_query_ids.iter().next(),
        c["query_id"].as_str(),
        "{name}: query id"
    );
    let cache = c["read_cache"].as_str().map(|s| match s {
        "hit" => 0u8,
        "miss" => 1,
        "bypass" => 2,
        "other" => 3,
        x => panic!("read_cache {x}"),
    });
    assert_eq!(cov.read_cache, cache, "{name}: read_cache");
    assert_eq!(
        cov.read_cache_through,
        c["read_cache_through_ms"].as_i64(),
        "{name}: read_cache_through"
    );
    // D2 derives the age from data_end: receipt time − data_end, at least 0.
    assert_eq!(
        cov.data_end.map(|e| (NOW_MS - e).max(0)),
        c["data_age_ms"].as_i64(),
        "{name}: data_age_ms"
    );
}

#[test]
fn route_bodies_carry_what_the_json_bodies_carry() {
    for name in PAIRS {
        check_pair(name);
    }
}

#[test]
fn route_edge_cases_are_present() {
    // future-sample: the newest sample is after now, so the age is 0; empty: no data_end, no age.
    let future = json("future-sample.json");
    assert_eq!(future["completeness"]["data_age_ms"].as_i64(), Some(0));
    let d = decode("future-sample.dsf");
    assert!(
        final_coverage("future-sample", &d)
            .data_end
            .unwrap_or_else(|| panic!("missing"))
            > NOW_MS
    );
    let empty = json("empty.json");
    assert!(empty["completeness"].get("data_age_ms").is_none());
    assert_eq!(final_coverage("empty", &decode("empty.dsf")).data_end, None);
    // types-warning: both bodies carry the warning first.
    let tw = json("types-warning.json");
    assert_eq!(
        tw["completeness"]["warnings"][0].as_str(),
        Some(TYPES_WARNING)
    );
    let d = decode("types-warning.dsf");
    assert_eq!(
        final_coverage("types-warning", &d).warnings.iter().next(),
        Some(TYPES_WARNING)
    );
}

/// The error/1 code of an envelope (§3.4): by code, and for `unavailable` by its hint reason.
fn wire_code(code: &str, reason: Option<&str>) -> u8 {
    match (code, reason) {
        ("invalid" | "virtual_unsupported", _) => 0,
        ("too_broad", _) => 1,
        ("scope_denied", _) => 3,
        ("unavailable", Some("upstream_timeout")) => 5,
        ("unavailable", _) => 4,
        ("budget_exhausted", _) => 7,
        ("internal", _) => 8,
        other => panic!("envelope code {other:?}"),
    }
}

#[test]
fn mid_stream_errors_follow_the_envelope_mapping() {
    for class in CLASSES {
        let env = json(&format!("err-{class}.json"));
        let e = &env["body"]["error"];
        let d = decode(&format!("mid-failure-{class}.dsf"));
        assert!(d.ended, "{class}: no END");
        let row = d
            .error
            .clone()
            .unwrap_or_else(|| panic!("{class}: no error row"));
        let hint = &e["hint"];
        assert_eq!(
            row.code,
            wire_code(
                e["code"].as_str().unwrap_or_else(|| panic!("missing")),
                hint["reason"].as_str()
            ),
            "{class}: code"
        );
        assert_eq!(
            i64::from(row.http_status),
            env["status"].as_i64().unwrap_or_else(|| panic!("missing")),
            "{class}: status"
        );
        assert_eq!(
            &*row.message,
            e["message"].as_str().unwrap_or_else(|| panic!("missing")),
            "{class}: message"
        );
        assert_eq!(
            row.position.map(i64::from),
            hint["position"]["offset"].as_i64(),
            "{class}: position"
        );
        let retry = env["retry_after"]
            .as_str()
            .map(|s| s.parse::<i64>().unwrap_or_else(|e| panic!("{e}")) * 1000);
        assert_eq!(row.retry_after_ms.map(i64::from), retry, "{class}: retry");
        assert_eq!(
            row.suggestion.as_deref() == Some("narrow"),
            hint["action"].as_str() == Some("narrow"),
            "{class}: suggestion"
        );
        let cov = final_coverage(class, &d);
        assert_eq!(cov.phase, Phase::Partial, "{class}");
        assert_eq!(cov.series_returned as usize, d.series.len(), "{class}");
        assert_eq!(d.series.len(), 1, "{class}: the series before the failure");
    }
}

#[test]
fn refused_and_limited_bodies_decode_through_end() {
    let refused = decode("refused-open-parts.dsf");
    assert!(refused.ended && refused.series.is_empty());
    assert_eq!(
        refused
            .stream_errors
            .iter()
            .map(|e| e.code)
            .collect::<Vec<_>>(),
        [8]
    );
    let limited = decode("limits-many.dsf");
    assert!(limited.ended);
    let cov = final_coverage("limits-many", &limited);
    assert!(cov.truncated);
    assert_eq!(cov.truncation_reason.as_deref(), Some("wire_limit"));
    assert_eq!(cov.series_returned as usize, limited.series.len());
    assert!(!limited.series.is_empty() && limited.series.len() < 600);
}
