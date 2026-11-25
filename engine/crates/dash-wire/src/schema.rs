//! The v1 schemas the engine reads (plan #68 B2 §3.4 "Schema matching", B1 §3.1): exact
//! columns, exact metadata keys, the grid metadata checks and the closed value sets.
#![deny(clippy::indexing_slicing)]

use std::collections::BTreeSet;

use std::sync::{Arc, OnceLock};

use crate::decode::{GridInfo, MAX_GRID_LEN, PartError};
use crate::ipc::{FieldDesc, IpcError, RawSchema, SchemaDesc, Ty};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Labels,
    Grid,
    Coverage,
    Error,
}

/// A column type as B1 §3.1 names it.
#[derive(Clone, Copy, Debug)]
enum T {
    U8,
    U16,
    U32,
    U64,
    F64,
    Bool,
    Utf8,
    TsMs,
    /// `list<utf8>` (non-null items).
    ListUtf8,
    /// `fixed_size_list<float64?>[dash.grid.len]`.
    FslF64,
}

type Cols = &'static [(&'static str, T, bool)];

const LABELS_COLS: Cols = &[
    ("series_id", T::U32, false),
    ("key_hash", T::U64, false),
    ("label_key", T::Utf8, true),
    ("label_value", T::Utf8, true),
];
const GRID_COLS: Cols = &[("series_id", T::U32, false), ("values", T::FslF64, false)];
const COVERAGE_COLS: Cols = &[
    ("phase", T::U8, false),
    ("exactness", T::U8, false),
    ("rollup_level_s", T::U32, true),
    ("sampled_ratio", T::F64, true),
    ("truncated", T::Bool, false),
    ("truncation_reason", T::Utf8, true),
    ("dropped_count", T::U64, true),
    ("series_returned", T::U32, false),
    ("rows_read", T::U64, true),
    ("bytes_read", T::U64, true),
    ("shards_failed", T::U16, true),
    ("shards_skipped", T::U16, true),
    ("retention_floor", T::TsMs, true),
    ("excluded_dims", T::ListUtf8, false),
    ("warnings", T::ListUtf8, false),
    ("infos", T::ListUtf8, false),
    ("upstream_query_ids", T::ListUtf8, false),
    ("read_cache", T::U8, true),
    ("read_cache_through", T::TsMs, true),
    ("data_end", T::TsMs, true),
    ("upstream_ms", T::U32, false),
    ("convert_ms", T::U32, false),
];
const ERROR_COLS: Cols = &[
    ("code", T::U8, false),
    ("http_status", T::U16, false),
    ("message", T::Utf8, false),
    ("position", T::U32, true),
    ("retry_after_ms", T::U32, true),
    ("suggestion", T::Utf8, true),
];

const COMMON_KEYS: &[&str] = &["dash.schema", "dash.time_unit"];
const GRID_KEYS: &[&str] = &[
    "dash.schema",
    "dash.time_unit",
    "dash.grid.start_ms",
    "dash.grid.requested_start_ms",
    "dash.grid.step_ms",
    "dash.grid.len",
    "dash.labels_part",
    "dash.result",
    "dash.source",
];
const GRID_OPTIONAL: &[&str] = &["dash.unit", "dash.planned"];
const RESULTS: &[&str] = &[
    "metric",
    "log_volume",
    "log_rate",
    "trace_metric",
    "profile_series",
    "virtual",
];
const SOURCES: &[&str] = &["pulsusdb", "postgres"];

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Labels => "labels",
            Kind::Grid => "metric_matrix.grid",
            Kind::Coverage => "coverage",
            Kind::Error => "error",
        }
    }
    fn cols(self) -> Cols {
        match self {
            Kind::Labels => LABELS_COLS,
            Kind::Grid => GRID_COLS,
            Kind::Coverage => COVERAGE_COLS,
            Kind::Error => ERROR_COLS,
        }
    }
    fn required(self) -> &'static [&'static str] {
        match self {
            Kind::Grid => GRID_KEYS,
            _ => COMMON_KEYS,
        }
    }
    fn optional(self) -> &'static [&'static str] {
        match self {
            Kind::Grid => GRID_OPTIONAL,
            _ => &[],
        }
    }
}

fn ty_matches(t: T, ty: &Ty) -> bool {
    match (t, ty) {
        (T::U8, Ty::U8)
        | (T::U16, Ty::U16)
        | (T::U32, Ty::U32)
        | (T::U64, Ty::U64)
        | (T::F64, Ty::F64)
        | (T::Bool, Ty::Bool)
        | (T::Utf8, Ty::Utf8)
        | (T::TsMs, Ty::TsMs) => true,
        (T::ListUtf8, Ty::List(c)) => c.ty == Ty::Utf8 && !c.nullable,
        (T::FslF64, Ty::Fsl(_, c)) => c.ty == Ty::F64 && c.nullable,
        _ => false,
    }
}

pub(crate) fn schema_err(s: impl Into<String>) -> PartError {
    PartError::Schema(s.into())
}

/// The most input bytes a diagnostic quotes, and the most bytes of its escaped quote.
const SNIPPET_INPUT: usize = 64;
const SNIPPET_ESCAPED: usize = 128;

/// A bounded quote of untrusted input for a diagnostic (B3 review r1): at most 64 bytes of `s`,
/// cut at a UTF-8 boundary, Debug-escaped, the escaped text capped at 128 bytes, `…` when cut.
/// A diagnostic is then at most a fixed text plus 134 bytes, whatever the input.
pub(crate) fn snippet(s: &str) -> String {
    let mut k = s.len().min(SNIPPET_INPUT);
    while !s.is_char_boundary(k) {
        k -= 1;
    }
    let mut out = String::with_capacity(SNIPPET_ESCAPED + 6);
    out.push('"');
    let mut cut = k < s.len();
    for c in s.get(..k).unwrap_or_default().escape_debug() {
        if out.len() + c.len_utf8() > SNIPPET_ESCAPED {
            cut = true;
            break;
        }
        out.push(c);
    }
    if cut {
        out.push('…');
    }
    out.push('"');
    out
}

/// Checks `s` is exactly B1 §3.1's `expect` schema: id and major (T04-002), the exact key set,
/// `dash.time_unit`, and the exact columns. In META/ERROR payloads (`in_stream`) another valid
/// schema id is a closed-set violation (`Value("dash.schema")`).
pub(crate) fn check_schema(s: &SchemaDesc, expect: Kind, in_stream: bool) -> Result<(), PartError> {
    let id = s
        .meta("dash.schema")
        .ok_or_else(|| schema_err("dash.schema missing"))?;
    let (name, major) = id
        .rsplit_once('/')
        .ok_or_else(|| schema_err(format!("schema id {}", snippet(id))))?;
    let kind = [Kind::Labels, Kind::Grid, Kind::Coverage, Kind::Error]
        .into_iter()
        .find(|k| k.name() == name)
        .ok_or_else(|| schema_err(format!("unknown schema {}", snippet(name))))?;
    if major != "1" {
        return Err(schema_err(format!("{name} major {}", snippet(major))));
    }
    if kind != expect {
        return Err(if in_stream {
            PartError::Value("dash.schema")
        } else {
            schema_err(format!("expected {}/1, got {}", expect.name(), snippet(id)))
        });
    }
    let mut seen = BTreeSet::new();
    for (k, _) in &s.metadata {
        if !seen.insert(k.as_str()) {
            return Err(schema_err(format!("duplicate key {}", snippet(k))));
        }
        if !kind.required().contains(&k.as_str()) && !kind.optional().contains(&k.as_str()) {
            return Err(schema_err(format!("unknown key {}", snippet(k))));
        }
    }
    if let Some(k) = kind.required().iter().find(|k| !seen.contains(**k)) {
        return Err(schema_err(format!("missing key {k}")));
    }
    if s.meta("dash.time_unit") != Some("ms") {
        return Err(PartError::Value("dash.time_unit"));
    }
    let cols = kind.cols();
    if s.fields.len() > cols.len() {
        return Err(PartError::Ipc(IpcError::Unsupported("column")));
    }
    if s.fields.len() < cols.len() {
        return Err(schema_err("missing column"));
    }
    for (f, (name, t, nullable)) in s.fields.iter().zip(cols) {
        if f.name != *name || f.nullable != *nullable || !ty_matches(*t, &f.ty) {
            return Err(schema_err(format!("column {name}")));
        }
    }
    Ok(())
}

fn ty_of(t: T) -> Ty {
    let item = |ty, nullable| {
        Box::new(FieldDesc {
            name: "item".to_owned(),
            nullable,
            ty,
        })
    };
    match t {
        T::U8 => Ty::U8,
        T::U16 => Ty::U16,
        T::U32 => Ty::U32,
        T::U64 => Ty::U64,
        T::F64 => Ty::F64,
        T::Bool => Ty::Bool,
        T::Utf8 => Ty::Utf8,
        T::TsMs => Ty::TsMs,
        T::ListUtf8 => Ty::List(item(Ty::Utf8, false)),
        T::FslF64 => Ty::Fsl(1, item(Ty::F64, true)),
    }
}

fn build(kind: Kind) -> SchemaDesc {
    SchemaDesc {
        fields: kind
            .cols()
            .iter()
            .map(|(name, t, nullable)| FieldDesc {
                name: (*name).to_owned(),
                nullable: *nullable,
                ty: ty_of(*t),
            })
            .collect(),
        metadata: vec![
            (
                "dash.schema".to_owned(),
                Arc::from(format!("{}/1", kind.name())),
            ),
            ("dash.time_unit".to_owned(), Arc::from("ms")),
        ],
    }
}

/// The canonical `labels/1`, `coverage/1` or `error/1` schema, built once: the one a META
/// (`coverage/1`) or ERROR (`error/1`) stream may carry, and the columns a labels part reads
/// its batches with once its own schema was accepted (so a labels part keeps no schema copy).
pub(crate) fn canonical(kind: Kind) -> &'static SchemaDesc {
    static LABELS: OnceLock<SchemaDesc> = OnceLock::new();
    static COVERAGE: OnceLock<SchemaDesc> = OnceLock::new();
    static ERROR: OnceLock<SchemaDesc> = OnceLock::new();
    match kind {
        Kind::Labels | Kind::Grid => LABELS.get_or_init(|| build(Kind::Labels)),
        Kind::Error => ERROR.get_or_init(|| build(Kind::Error)),
        Kind::Coverage => COVERAGE.get_or_init(|| build(Kind::Coverage)),
    }
}

/// The schema of a META or ERROR stream, checked from the borrowed message without copying it
/// (B3: a stream schema is not kept, so nothing of it is copied): it must be exactly `kind`'s
/// v1 schema. Another valid v1 schema id is a closed-set violation (`Value("dash.schema")`).
pub(crate) fn check_stream_schema(
    raw: &RawSchema<'_>,
    kind: Kind,
) -> Result<&'static SchemaDesc, PartError> {
    let expect = canonical(kind);
    if raw.is(expect) {
        return Ok(expect);
    }
    let known = [Kind::Labels, Kind::Grid, Kind::Coverage, Kind::Error]
        .into_iter()
        .any(|k| {
            k != kind && raw.meta(b"dash.schema") == Some(format!("{}/1", k.name()).as_bytes())
        });
    Err(if known {
        PartError::Value("dash.schema")
    } else {
        schema_err(format!("not the {}/1 schema", kind.name()))
    })
}

/// The grid of a checked `metric_matrix.grid/1` schema, and its labels part.
pub(crate) fn grid_info(s: &SchemaDesc) -> Result<(GridInfo, u32), PartError> {
    fn num<N: std::str::FromStr>(s: &SchemaDesc, k: &'static str) -> Result<N, PartError> {
        s.meta(k)
            .and_then(|v| v.parse::<N>().ok())
            .ok_or_else(|| schema_err(k))
    }
    let start_ms: i64 = num(s, "dash.grid.start_ms")?;
    let requested_start_ms: i64 = num(s, "dash.grid.requested_start_ms")?;
    let step_ms: i64 = num(s, "dash.grid.step_ms")?;
    let len: u32 = num(s, "dash.grid.len")?;
    let labels_part: u32 = num(s, "dash.labels_part")?;
    if step_ms <= 0 {
        return Err(schema_err("dash.grid.step_ms"));
    }
    if len == 0 || len > MAX_GRID_LEN {
        return Err(schema_err("dash.grid.len"));
    }
    // B1's ordered unsigned difference; start_ms + step_ms is never computed.
    if requested_start_ms < start_ms
        || (requested_start_ms as u64).wrapping_sub(start_ms as u64) >= step_ms as u64
    {
        return Err(schema_err("dash.grid.requested_start_ms"));
    }
    if step_ms
        .checked_mul(i64::from(len - 1))
        .and_then(|d| start_ms.checked_add(d))
        .is_none()
    {
        return Err(schema_err("grid end"));
    }
    match s.fields.get(1).map(|f| &f.ty) {
        Some(Ty::Fsl(size, _)) if i64::from(*size) == i64::from(len) => {}
        _ => return Err(PartError::Shape("list size")),
    }
    let result = s.meta("dash.result").unwrap_or_default();
    if !RESULTS.contains(&result) {
        return Err(PartError::Value("dash.result"));
    }
    let source = s.meta("dash.source").unwrap_or_default();
    if !SOURCES.contains(&source) {
        return Err(PartError::Value("dash.source"));
    }
    Ok((
        GridInfo {
            start_ms,
            requested_start_ms,
            step_ms,
            len,
            result: result.to_owned(),
            source: source.to_owned(),
            unit: s.meta_shared("dash.unit"),
            planned: s.meta_shared("dash.planned"),
        },
        labels_part,
    ))
}

#[cfg(test)]
mod tests {
    use super::snippet;

    #[test]
    fn snippets_are_bounded_and_valid() {
        assert_eq!(snippet("labels"), "\"labels\"");
        for s in [
            "a".repeat(1 << 20),
            "\u{1}".repeat(1 << 16),
            "é".repeat(1 << 16),
            "\"\\\n".repeat(1000),
        ] {
            let q = snippet(&s);
            assert!(q.len() <= 128 + 3 + 2, "{} bytes", q.len());
            assert!(q.ends_with("…\""), "{q}");
        }
        // 63 ASCII bytes then "é": cut before the é, never inside it.
        let s = format!("{}é", "a".repeat(63));
        assert_eq!(snippet(&s), format!("\"{}…\"", "a".repeat(63)));
    }
}
