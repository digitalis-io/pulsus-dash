//! The shared wire limits (plan #68 B3 §3.1, §3.3; T04-010): the values of
//! `wire/schemas/limits.json` (`unit:limits-json` pins them), the accounting the Go writer uses
//! too, and the limit set a `BodyDecoder` enforces. Every limit is checked from validated counts
//! before the allocation it bounds; a writer-valid body never reaches one.
#![deny(clippy::indexing_slicing)]

/// The largest chunk `FrameSplitter::push` accepts, by backing allocation (2 × `MAX_PAYLOAD`).
pub const MAX_CHUNK: usize = 128 << 20;
/// Part D's BYOB read buffer (one per response).
pub const SOURCE_BUFFER: usize = 1 << 20;
/// Parts open at once (part 0 exempt).
pub const OPEN_PARTS: usize = 64;
/// Distinct part ids per body (part 0 exempt).
pub const DISTINCT_PARTS: usize = 1024;
/// Rows of one labels batch.
pub const ROWS_PER_BATCH_LABELS: usize = 1 << 20;
/// Rows (series) of one grid batch.
pub const ROWS_PER_BATCH_GRID: usize = 1 << 16;
/// Series of one data part.
pub const SERIES_PER_PART: usize = 1 << 20;
/// Rows of one labels part.
pub const LABEL_ROWS_PER_PART: usize = 1 << 22;
/// Label key and value bytes of one labels part.
pub const LABEL_BYTES_PER_PART: usize = 16 << 20;
/// List elements of one coverage row (all lists).
pub const META_LIST_ELEMENTS: usize = 4096;
/// String bytes of one coverage or error row.
pub const META_STRING_BYTES: usize = 1 << 20;
/// The writer's cap on `truncation_reason` (the reader checks only `META_STRING_BYTES`).
pub const REASON_BYTES: usize = 64;
/// The body budget: bytes the decoder creates for one body (§3.1 accounting).
pub const BODY_BUDGET: u64 = 64 << 20;
/// The value budget: the chunks' values and validity words.
pub const VALUE_BUDGET: u64 = 1 << 30;
/// The writer's reserve per open data part: the worst-case `Fail` (coverage + error).
pub const PART_RESERVE: u64 = cost::COVERAGE
    + META_STRING_BYTES as u64
    + cost::LIST_ELEMENT * META_LIST_ELEMENTS as u64
    + cost::ERROR
    + META_STRING_BYTES as u64;
/// The writer's reserve for the stream-level ERROR.
pub const STREAM_RESERVE: u64 = cost::ERROR + META_STRING_BYTES as u64;

/// The accounting costs (`limits.json` `cost`), identical in the Go writer.
pub mod cost {
    /// Per part.
    pub const PART: u64 = 256;
    /// Per accepted schema, plus field names and metadata keys and values.
    pub const SCHEMA: u64 = 256;
    /// Per series label set.
    pub const SERIES: u64 = 64;
    /// Per label of a set, plus its key and value.
    pub const LABEL: u64 = 48;
    /// Per data batch.
    pub const BATCH: u64 = 64;
    /// Per series of a data batch.
    pub const BATCH_SERIES: u64 = 32;
    /// Per coverage row, plus its strings and 16 per list element.
    pub const COVERAGE: u64 = 256;
    /// Per coverage list element.
    pub const LIST_ELEMENT: u64 = 16;
    /// Per error row, plus its strings.
    pub const ERROR: u64 = 256;
    /// Value budget: per value.
    pub const VALUE: u64 = 8;
    /// Value budget: per 64 values (validity words).
    pub const VALIDITY_WORD: u64 = 8;
}

/// The limits a `BodyDecoder` enforces (`Default` = `limits.json`; tests use
/// `limits-test.json`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub open_parts: usize,
    pub distinct_parts: usize,
    pub rows_per_batch_labels: usize,
    pub rows_per_batch_grid: usize,
    pub series_per_part: usize,
    pub label_rows_per_part: usize,
    pub label_bytes_per_part: usize,
    pub meta_list_elements: usize,
    pub meta_string_bytes: usize,
    pub body_budget: u64,
    pub value_budget: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            open_parts: OPEN_PARTS,
            distinct_parts: DISTINCT_PARTS,
            rows_per_batch_labels: ROWS_PER_BATCH_LABELS,
            rows_per_batch_grid: ROWS_PER_BATCH_GRID,
            series_per_part: SERIES_PER_PART,
            label_rows_per_part: LABEL_ROWS_PER_PART,
            label_bytes_per_part: LABEL_BYTES_PER_PART,
            meta_list_elements: META_LIST_ELEMENTS,
            meta_string_bytes: META_STRING_BYTES,
            body_budget: BODY_BUDGET,
            value_budget: VALUE_BUDGET,
        }
    }
}

/// A data batch of `series` rows (body budget).
pub(crate) fn batch_cost(series: usize) -> u64 {
    cost::BATCH + cost::BATCH_SERIES * series as u64
}

/// The values and validity words of a data batch of `values` values (value budget).
pub(crate) fn value_cost(values: usize) -> u64 {
    cost::VALUE * values as u64 + cost::VALIDITY_WORD * values.div_ceil(64) as u64
}

/// A coverage row of `strings` bytes and `elements` list elements.
pub(crate) fn coverage_cost(strings: usize, elements: usize) -> u64 {
    cost::COVERAGE + strings as u64 + cost::LIST_ELEMENT * elements as u64
}

/// An error row of `strings` bytes.
pub(crate) fn error_cost(strings: usize) -> u64 {
    cost::ERROR + strings as u64
}

#[cfg(test)]
mod tests {
    //! unit:limits-json, Rust side (plan #68 B3 §3.1): every limit, cost and reserve and
    //! `MAX_GRID_LEN` equal `wire/schemas/limits.json`.
    use crate::decode::MAX_GRID_LEN;
    use crate::dsf::MAX_PAYLOAD;
    use crate::limits::{self, Limits, cost};

    fn json() -> serde_json::Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../wire/schemas/limits.json"
        );
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    #[test]
    fn limits_match_json() {
        let v = json();
        let n = |k: &str| {
            v.get(k)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_else(|| panic!("limits.json: {k}"))
        };
        let c = |k: &str| {
            v.get("cost")
                .and_then(|c| c.get(k))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_else(|| panic!("limits.json: cost.{k}"))
        };
        let pairs: [(&str, u64); 18] = [
            ("max_payload", u64::from(MAX_PAYLOAD)),
            ("max_chunk", limits::MAX_CHUNK as u64),
            ("source_buffer", limits::SOURCE_BUFFER as u64),
            ("max_grid_len", u64::from(MAX_GRID_LEN)),
            ("open_parts", limits::OPEN_PARTS as u64),
            ("distinct_parts", limits::DISTINCT_PARTS as u64),
            (
                "rows_per_batch_labels",
                limits::ROWS_PER_BATCH_LABELS as u64,
            ),
            ("rows_per_batch_grid", limits::ROWS_PER_BATCH_GRID as u64),
            ("series_per_part", limits::SERIES_PER_PART as u64),
            ("label_rows_per_part", limits::LABEL_ROWS_PER_PART as u64),
            ("label_bytes_per_part", limits::LABEL_BYTES_PER_PART as u64),
            ("meta_list_elements", limits::META_LIST_ELEMENTS as u64),
            ("meta_string_bytes", limits::META_STRING_BYTES as u64),
            ("reason_bytes", limits::REASON_BYTES as u64),
            ("body_budget", limits::BODY_BUDGET),
            ("value_budget", limits::VALUE_BUDGET),
            ("part_reserve", limits::PART_RESERVE),
            ("stream_reserve", limits::STREAM_RESERVE),
        ];
        for (k, ours) in pairs {
            assert_eq!(n(k), ours, "{k}");
        }
        let costs: [(&str, u64); 11] = [
            ("part", cost::PART),
            ("schema", cost::SCHEMA),
            ("series", cost::SERIES),
            ("label", cost::LABEL),
            ("batch", cost::BATCH),
            ("batch_series", cost::BATCH_SERIES),
            ("coverage", cost::COVERAGE),
            ("list_element", cost::LIST_ELEMENT),
            ("error", cost::ERROR),
            ("value", cost::VALUE),
            ("validity_word", cost::VALIDITY_WORD),
        ];
        for (k, ours) in costs {
            assert_eq!(c(k), ours, "cost.{k}");
        }
        assert_eq!(
            v.get("cost")
                .and_then(serde_json::Value::as_object)
                .map(|o| o.len()),
            Some(costs.len())
        );
        let d = Limits::default();
        assert_eq!(d.open_parts, limits::OPEN_PARTS);
        assert_eq!(d.body_budget, limits::BODY_BUDGET);
        assert_eq!(d.value_budget, limits::VALUE_BUDGET);
        // max_chunk = 2 × max_payload; the source buffer fits a chunk.
        assert_eq!(limits::MAX_CHUNK, 2 * MAX_PAYLOAD as usize);
        const { assert!(limits::SOURCE_BUFFER <= limits::MAX_CHUNK) };
    }
}
