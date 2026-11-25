//! The shared wire limits (plan #68 B3 §3.1, T04-010; `wire/schemas/limits.json`). Stub.

pub const MAX_CHUNK: usize = 128 << 20;
pub const SOURCE_BUFFER: usize = 1 << 20;
pub const OPEN_PARTS: usize = 0;
pub const DISTINCT_PARTS: usize = 0;
pub const ROWS_PER_BATCH_LABELS: usize = 0;
pub const ROWS_PER_BATCH_GRID: usize = 0;
pub const SERIES_PER_PART: usize = 0;
pub const LABEL_ROWS_PER_PART: usize = 0;
pub const LABEL_BYTES_PER_PART: usize = 0;
pub const META_LIST_ELEMENTS: usize = 0;
pub const META_STRING_BYTES: usize = 0;
pub const REASON_BYTES: usize = 0;
pub const BODY_BUDGET: u64 = 0;
pub const VALUE_BUDGET: u64 = 0;
pub const PART_RESERVE: u64 = 0;
pub const STREAM_RESERVE: u64 = 0;

/// The accounting costs (stub).
pub mod cost {
    pub const PART: u64 = 0;
    pub const SCHEMA: u64 = 0;
    pub const SERIES: u64 = 0;
    pub const LABEL: u64 = 0;
    pub const BATCH: u64 = 0;
    pub const BATCH_SERIES: u64 = 0;
    pub const COVERAGE: u64 = 0;
    pub const LIST_ELEMENT: u64 = 0;
    pub const ERROR: u64 = 0;
    pub const VALUE: u64 = 0;
    pub const VALIDITY_WORD: u64 = 0;
}

/// The limits a `BodyDecoder` enforces.
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
