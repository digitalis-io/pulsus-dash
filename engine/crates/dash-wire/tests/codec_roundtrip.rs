//! unit:codec-roundtrip, Rust side (plan #68 B2 §5; T04-001, T04-002, T04-005, T04-012): each
//! committed B1 fixture, in one `SharedBytes`, decodes to its `.expect.json`, plus the spot
//! checks. The planned coverage row (phase 0) is validated by the decoder but not emitted
//! (§4.1: `new | META planned → data-planned`, no event), so it is compared only by phase.
mod common;
mod support;

use std::collections::BTreeMap;
use std::sync::Arc;

use common::{FIXTURES, expect, fixture};
use dash_wire::{Coverage, ErrorRow, Event, FrameHeader, Phase, TimeAxis, Verdict};
use serde_json::{Value, json};

fn opt<T: Into<Value>>(v: Option<T>) -> Value {
    v.map_or(Value::Null, Into::into)
}

fn coverage_json(c: &Coverage) -> Value {
    json!({
        "phase": c.phase as u8,
        "exactness": c.exactness,
        "rollup_level_s": opt(c.rollup_level_s),
        "sampled_ratio": opt(c.sampled_ratio),
        "truncated": c.truncated,
        "truncation_reason": opt(c.truncation_reason.clone()),
        "dropped_count": opt(c.dropped_count),
        "series_returned": c.series_returned,
        "rows_read": opt(c.rows_read),
        "bytes_read": opt(c.bytes_read),
        "shards_failed": opt(c.shards_failed),
        "shards_skipped": opt(c.shards_skipped),
        "retention_floor": opt(c.retention_floor),
        "excluded_dims": c.excluded_dims,
        "warnings": c.warnings,
        "infos": c.infos,
        "upstream_query_ids": c.upstream_query_ids,
        "read_cache": opt(c.read_cache),
        "read_cache_through": opt(c.read_cache_through),
        "data_end": opt(c.data_end),
        "upstream_ms": c.upstream_ms,
        "convert_ms": c.convert_ms,
    })
}

fn error_json(e: &ErrorRow) -> Value {
    json!({
        "code": e.code,
        "http_status": e.http_status,
        "message": e.message,
        "position": opt(e.position),
        "retry_after_ms": opt(e.retry_after_ms),
        "suggestion": opt(e.suggestion.clone()),
    })
}

/// The labels part of each data part, from the frame order B1 §3.4 writes (`SCHEMA(L)`,
/// `META(D, planned)`, `SCHEMA(D)`): the SCHEMA frame just before the planned META.
fn labels_parts(body: &[u8]) -> BTreeMap<u32, u32> {
    let frames = common::parse(body);
    let mut out = BTreeMap::new();
    for w in frames.windows(2) {
        if w[0].kind == common::SCHEMA && w[1].kind == common::META {
            out.entry(w[1].part).or_insert(w[0].part);
        }
    }
    out
}

/// The events as an `.expect.json` document.
fn project(body: &[u8], ev: &[Event]) -> Value {
    let links = labels_parts(body);
    let mut parts: Vec<(u32, Value)> = Vec::new();
    let mut errors = Vec::new();
    let mut series: BTreeMap<u32, Vec<Value>> = BTreeMap::new();
    let mut covs: BTreeMap<u32, Vec<Value>> = BTreeMap::new();
    let mut errs: BTreeMap<u32, Value> = BTreeMap::new();
    for e in ev {
        match e {
            Event::Grid { part, rank, info } => parts.push((
                *part,
                json!({
                    "labels_part": links.get(part).copied(),
                    "data_part": part,
                    "rank": rank,
                    "grid": {
                        "start_ms": info.start_ms,
                        "requested_start_ms": info.requested_start_ms,
                        "step_ms": info.step_ms,
                        "len": info.len,
                    },
                    "result": info.result,
                    "source": info.source,
                    "unit": opt(info.unit.clone()),
                    "planned": opt(info.planned.clone()),
                }),
            )),
            Event::Chunk { part, chunk, .. } => {
                let list = series.entry(*part).or_default();
                for (s, meta) in chunk.series.iter().enumerate() {
                    let id = list.len();
                    let vals = chunk.series_values(s);
                    let base = chunk.offsets[s] as usize;
                    let bits: Vec<Value> = vals
                        .iter()
                        .enumerate()
                        .map(|(k, v)| {
                            let i = base + k;
                            let on = chunk
                                .present
                                .as_ref()
                                .is_none_or(|w| w[i / 64] >> (i % 64) & 1 == 1);
                            if on {
                                json!(format!("{:016x}", v.to_bits()))
                            } else {
                                Value::Null
                            }
                        })
                        .collect();
                    let labels: Vec<Value> =
                        meta.labels.iter().map(|(k, v)| json!([k, v])).collect();
                    list.push(json!({
                        "id": id,
                        "key": format!("{:016x}", meta.key_hash),
                        "labels": labels,
                        "bits": bits,
                    }));
                }
            }
            Event::Coverage { part, coverage } => {
                covs.entry(*part).or_default().push(coverage_json(coverage));
            }
            Event::Upstream { part, error } => {
                errs.insert(*part, error_json(error));
            }
            _ => {}
        }
    }
    let data: Vec<u32> = parts.iter().map(|(p, _)| *p).collect();
    for (p, e) in &errs {
        if !data.contains(p) {
            errors.push(json!({"part": p, "error": e}));
        }
    }
    let parts: Vec<Value> = parts
        .into_iter()
        .map(|(p, mut v)| {
            v["series"] = Value::Array(series.remove(&p).unwrap_or_default());
            v["coverage"] = Value::Array(covs.remove(&p).unwrap_or_default());
            v["error"] = errs.get(&p).cloned().unwrap_or(Value::Null);
            v
        })
        .collect();
    json!({"parts": parts, "errors": errors})
}

/// The expectation without the planned coverage rows (each must be phase 0).
fn expected(name: &str) -> Value {
    let mut want = expect(name);
    if let Some(parts) = want["parts"].as_array_mut() {
        for p in parts {
            if let Some(c) = p["coverage"].as_array_mut() {
                assert_eq!(c.first().map(|r| r["phase"].clone()), Some(json!(0)));
                c.remove(0);
            }
        }
    }
    want
}

fn decode(name: &str) -> (Vec<u8>, Vec<Event>) {
    let body = fixture(name);
    let ev = support::run(&body, 100);
    (body, ev)
}

#[test]
fn every_fixture_decodes_to_its_expectation() {
    for name in FIXTURES {
        let (body, ev) = decode(name);
        assert!(
            !ev.iter().any(|e| matches!(e, Event::Failed { .. })),
            "{name}: {ev:?}"
        );
        assert_eq!(project(&body, &ev), expected(name), "{name}");
        assert!(ev.contains(&Event::End), "{name}");
        assert_eq!(
            ev.last(),
            Some(&Event::Verdict(Verdict::Complete)),
            "{name}"
        );
        for e in &ev {
            if let Event::Chunk { chunk, .. } = e {
                assert_eq!(chunk.offsets.len(), chunk.series.len() + 1, "{name}");
                assert_eq!(
                    Some(chunk.values.len()),
                    chunk.offsets.last().map(|o| *o as usize),
                    "{name}: values cut to the child length"
                );
            }
        }
    }
}

#[test]
fn counter_spot_checks() {
    let (_, ev) = decode("promql-range-counter");
    let chunks: Vec<_> = ev
        .iter()
        .filter_map(|e| match e {
            Event::Chunk { chunk, .. } => Some(chunk),
            _ => None,
        })
        .collect();
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].id.0, 100, "first ChunkId");
    assert_eq!(chunks[1].id.0, 101);
    let bits: Vec<u64> = chunks[0].values.iter().map(|v| v.to_bits()).collect();
    assert!(bits.contains(&0x8000_0000_0000_0000), "-0");
    assert!(bits.contains(&0x0000_0000_0000_0001), "5e-324");
    // Absent slots: present bit 0 and the canonical NaN bits.
    let present = chunks[0].present.as_deref().unwrap_or(&[]);
    assert_eq!(present.len(), chunks[0].values.len().div_ceil(64));
    let absent: Vec<usize> = (0..chunks[0].values.len())
        .filter(|i| present[i / 64] >> (i % 64) & 1 == 0)
        .collect();
    assert!(!absent.is_empty());
    for i in absent {
        assert_eq!(chunks[0].values[i].to_bits(), 0x7FF8_0000_0000_0000);
    }
    let grid = ev.iter().find_map(|e| match e {
        Event::Grid { info, .. } => Some(info.clone()),
        _ => None,
    });
    let Some(grid) = grid else {
        panic!("no Grid event")
    };
    assert_eq!(grid.requested_start_ms, 1_767_225_600_000);
    assert_eq!(grid.start_ms, 1_767_225_600_000);
    let total_series: usize = chunks.iter().map(|c| c.series.len()).sum();
    assert_eq!(total_series, 2);
    for c in &chunks {
        assert_eq!(
            c.time,
            TimeAxis::Grid {
                start_ms: grid.start_ms,
                step_ms: grid.step_ms,
                len: grid.len
            }
        );
        let expect_offsets: Vec<u32> = (0..=c.series.len() as u32).map(|s| s * grid.len).collect();
        assert_eq!(c.offsets, expect_offsets);
    }
    // The final coverage: complete, not exact (exactness 4).
    let cov = ev.iter().rev().find_map(|e| match e {
        Event::Coverage { coverage, .. } => Some(coverage.clone()),
        _ => None,
    });
    let Some(cov) = cov else {
        panic!("no coverage")
    };
    assert!(cov.complete(grid.requested_start_ms));
    assert!(!cov.exact(grid.requested_start_ms));
}

#[test]
fn batches_spot_checks() {
    let (_, ev) = decode("grid-batches");
    let grid = ev.iter().find_map(|e| match e {
        Event::Grid { info, rank, .. } => Some((info.clone(), *rank)),
        _ => None,
    });
    let Some((grid, rank)) = grid else {
        panic!("no Grid")
    };
    assert_eq!((grid.start_ms, grid.requested_start_ms), (60_000, 67_500));
    assert_eq!(rank, 1);
    let sizes: Vec<usize> = ev
        .iter()
        .filter_map(|e| match e {
            Event::Chunk {
                chunk, flags, rank, ..
            } => {
                assert!(flags & FrameHeader::VOLATILE != 0);
                assert_eq!(*rank, 1);
                Some(chunk.series.len())
            }
            _ => None,
        })
        .collect();
    assert_eq!(sizes, [1, 64, 5]);
    let first = ev.iter().find_map(|e| match e {
        Event::Chunk { chunk, .. } => Some(chunk.clone()),
        _ => None,
    });
    let Some(first) = first else {
        panic!("no chunk")
    };
    assert!(first.series[0].labels.is_empty(), "series 0 has no labels");
    let cov = ev.iter().rev().find_map(|e| match e {
        Event::Coverage { coverage, .. } => Some(coverage.clone()),
        _ => None,
    });
    let Some(cov) = cov else {
        panic!("no coverage")
    };
    assert_eq!(cov.truncation_reason.as_deref(), Some("limit"));
    assert!(!cov.complete(grid.requested_start_ms));
}

#[test]
fn error_spot_checks() {
    let (_, ev) = decode("grid-error");
    let shape: Vec<String> = ev
        .iter()
        .map(|e| match e {
            Event::Grid { part, .. } => format!("Grid({part})"),
            Event::Chunk { part, chunk, .. } => format!("Chunk({part}, {})", chunk.series.len()),
            Event::PartEnd { part } => format!("PartEnd({part})"),
            Event::Coverage { part, coverage } => format!("Coverage({part}, {:?})", coverage.phase),
            Event::Upstream { part, .. } => format!("Upstream({part})"),
            Event::End => "End".into(),
            other => format!("{other:?}"),
        })
        .collect();
    assert_eq!(
        shape,
        [
            "Grid(4)",
            "Chunk(4, 1)",
            "PartEnd(3)",
            "Coverage(4, Partial)",
            "Upstream(4)",
            "PartEnd(4)",
            "Upstream(5)",
            "PartEnd(5)",
            "End",
            "Verdict(Complete)",
        ]
    );
    let ups: Vec<ErrorRow> = ev
        .iter()
        .filter_map(|e| match e {
            Event::Upstream { error, .. } => Some(error.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        ups,
        [
            ErrorRow {
                code: 1,
                http_status: 422,
                message: "too broad".into(),
                position: None,
                retry_after_ms: None,
                suggestion: Some("add a label matcher".into()),
            },
            ErrorRow {
                code: 0,
                http_status: 400,
                message: "parse error".into(),
                position: Some(7),
                retry_after_ms: None,
                suggestion: None,
            },
        ]
    );
    let cov = ev.iter().find_map(|e| match e {
        Event::Coverage { coverage, .. } => Some(coverage.clone()),
        _ => None,
    });
    let Some(cov) = cov else {
        panic!("no coverage")
    };
    assert!(!cov.complete(1_767_225_600_000));
}

#[test]
fn empty_spot_checks() {
    let (_, ev) = decode("grid-empty");
    let kinds: Vec<&str> = ev
        .iter()
        .map(|e| match e {
            Event::Grid { .. } => "Grid",
            Event::Coverage { coverage, .. } if coverage.phase == Phase::Final => "Coverage(final)",
            Event::PartEnd { .. } => "PartEnd",
            Event::End => "End",
            Event::Verdict(_) => "Verdict",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "Grid",
            "PartEnd",
            "Coverage(final)",
            "PartEnd",
            "End",
            "Verdict"
        ]
    );
}

#[test]
fn labels_are_shared_not_copied() {
    // A second data part (9) linked to the counter's labels part 1: both parts' chunks hold
    // Arc clones of the same labels (§3.1: no label string copied after its labels batch).
    let body = fixture("promql-range-counter");
    let mut frames = common::parse(&body);
    let copies: Vec<common::F> = frames
        .iter()
        .filter(|f| f.part == 2)
        .cloned()
        .map(|mut f| {
            f.part = 9;
            f
        })
        .collect();
    let end = frames.len() - 1;
    frames.splice(end..end, copies);
    let ev = support::run(&common::encode(&frames), 100);
    assert!(
        !ev.iter().any(|e| matches!(e, Event::Failed { .. })),
        "{ev:?}"
    );
    let first_of = |part: u32| {
        ev.iter().find_map(|e| match e {
            Event::Chunk { part: p, chunk, .. } if *p == part => chunk.series.first(),
            _ => None,
        })
    };
    let (Some(a), Some(b)) = (first_of(2), first_of(9)) else {
        panic!("no chunks: {ev:?}")
    };
    assert!(Arc::ptr_eq(&a.labels, &b.labels));
    // The decoder released its table at End: only the two chunks hold the labels.
    assert_eq!(Arc::strong_count(&a.labels), 2);
}
