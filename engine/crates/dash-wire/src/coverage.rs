//! `coverage/1` and `error/1` rows (T04 §5.3, plan #68 B1 §3.3) and the completeness rule
//! (T04-012 subset, VIZ-027).
#![deny(clippy::indexing_slicing)]

use crate::decode::PartError;
use crate::ipc::{Col, IpcError};

/// The coverage phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Planned = 0,
    Partial = 1,
    Final = 2,
}

/// One `coverage/1` row; nullable columns are `Option`, lists `Vec<String>`.
#[derive(Clone, Debug, PartialEq)]
pub struct Coverage {
    pub phase: Phase,
    /// 0 raw-exact, 1 rollup, 2 sampled, 3 estimated, 4 unknown.
    pub exactness: u8,
    pub rollup_level_s: Option<u32>,
    pub sampled_ratio: Option<f64>,
    pub truncated: bool,
    pub truncation_reason: Option<String>,
    pub dropped_count: Option<u64>,
    pub series_returned: u32,
    pub rows_read: Option<u64>,
    pub bytes_read: Option<u64>,
    pub shards_failed: Option<u16>,
    pub shards_skipped: Option<u16>,
    /// ms since the epoch.
    pub retention_floor: Option<i64>,
    pub excluded_dims: Vec<String>,
    pub warnings: Vec<String>,
    pub infos: Vec<String>,
    pub upstream_query_ids: Vec<String>,
    /// 0 hit, 1 miss, 2 bypass, 3 other.
    pub read_cache: Option<u8>,
    pub read_cache_through: Option<i64>,
    pub data_end: Option<i64>,
    pub upstream_ms: u32,
    pub convert_ms: u32,
}

/// One `error/1` row.
#[derive(Clone, Debug, PartialEq)]
pub struct ErrorRow {
    /// 0 bad_query … 8 internal (B1 §3.1).
    pub code: u8,
    pub http_status: u16,
    pub message: String,
    pub position: Option<u32>,
    pub retry_after_ms: Option<u32>,
    pub suggestion: Option<String>,
}

impl Coverage {
    /// B1 §3.3: final, nothing truncated, dropped, failed, skipped, excluded or sampled, and no
    /// retention floor after the requested start.
    pub fn complete(&self, requested_start_ms: i64) -> bool {
        self.phase == Phase::Final
            && !self.truncated
            && self.warnings.is_empty()
            && self.excluded_dims.is_empty()
            && self.shards_failed.is_none_or(|n| n == 0)
            && self.shards_skipped.is_none_or(|n| n == 0)
            && self.dropped_count.is_none_or(|n| n == 0)
            && self.sampled_ratio.is_none_or(|r| r == 1.0)
            && self.retention_floor.is_none_or(|f| f <= requested_start_ms)
    }

    /// A retention floor after the requested start (`limited by retention`, VIZ-027).
    pub fn retention_limited(&self, requested_start_ms: i64) -> bool {
        self.retention_floor.is_some_and(|f| f > requested_start_ms)
    }

    /// Complete and raw-exact (exactness 0).
    pub fn exact(&self, requested_start_ms: i64) -> bool {
        self.complete(requested_start_ms) && self.exactness == 0
    }
}

/// A cell of a validated one-row column.
fn cell<const N: usize>(c: Option<&Col>) -> Result<Option<[u8; N]>, PartError> {
    let c = c.ok_or(PartError::Ipc(IpcError::Messages))?;
    if !c.valid(0) {
        return Ok(None);
    }
    c.fixed::<N>(0)
        .map(Some)
        .ok_or(PartError::Ipc(IpcError::Layout("column")))
}

fn required<const N: usize>(c: Option<&Col>) -> Result<[u8; N], PartError> {
    cell::<N>(c)?.ok_or(PartError::Ipc(IpcError::Layout("nulls")))
}

fn text(c: Option<&Col>) -> Result<Option<String>, PartError> {
    let c = c.ok_or(PartError::Ipc(IpcError::Messages))?;
    if !c.valid(0) {
        return Ok(None);
    }
    c.str_at(0)
        .map(|s| Some(s.to_owned()))
        .ok_or(PartError::Ipc(IpcError::Layout("column")))
}

fn list(c: Option<&Col>) -> Result<Vec<String>, PartError> {
    c.and_then(|c| c.list_at(0))
        .ok_or(PartError::Ipc(IpcError::Layout("column")))
}

fn one_row(cols: &[Col]) -> Result<(), PartError> {
    match cols.first() {
        Some(c) if c.len == 1 => Ok(()),
        _ => Err(PartError::Shape("rows")),
    }
}

/// `(string bytes, list elements)` of a validated one-row `coverage/1` batch (B3 §3.3): the
/// truncation reason and the four lists, counted from their offsets before anything is copied.
pub(crate) fn coverage_counts(cols: &[Col]) -> Result<(usize, usize), PartError> {
    let bad = || PartError::Ipc(IpcError::Layout("column"));
    let reason = cols.get(5).ok_or_else(bad)?;
    let mut strings = if reason.valid(0) {
        reason.str_len(0).ok_or_else(bad)?
    } else {
        0
    };
    let mut elements = 0usize;
    for i in 13..17 {
        let (e, b) = cols.get(i).and_then(|c| c.list_extent(0)).ok_or_else(bad)?;
        elements += e;
        strings += b;
    }
    Ok((strings, elements))
}

/// The string bytes (message and suggestion) of a validated one-row `error/1` batch.
pub(crate) fn error_counts(cols: &[Col]) -> Result<usize, PartError> {
    let bad = || PartError::Ipc(IpcError::Layout("column"));
    let mut n = 0;
    for i in [2, 5] {
        let c = cols.get(i).ok_or_else(bad)?;
        if c.valid(0) {
            n += c.str_len(0).ok_or_else(bad)?;
        }
    }
    Ok(n)
}

/// The `coverage/1` row of a validated batch, with the closed value sets checked.
pub(crate) fn coverage_row(cols: &[Col]) -> Result<Coverage, PartError> {
    one_row(cols)?;
    let mut c = cols.iter();
    let phase = match u8::from_le_bytes(required::<1>(c.next())?) {
        0 => Phase::Planned,
        1 => Phase::Partial,
        2 => Phase::Final,
        _ => return Err(PartError::Value("phase")),
    };
    let exactness = u8::from_le_bytes(required::<1>(c.next())?);
    if exactness > 4 {
        return Err(PartError::Value("exactness"));
    }
    let rollup_level_s = cell::<4>(c.next())?.map(u32::from_le_bytes);
    let sampled_ratio = cell::<8>(c.next())?.map(f64::from_le_bytes);
    let truncated = c
        .next()
        .and_then(|t| t.bool_at(0))
        .ok_or(PartError::Ipc(IpcError::Layout("column")))?;
    let truncation_reason = text(c.next())?;
    let dropped_count = cell::<8>(c.next())?.map(u64::from_le_bytes);
    let series_returned = u32::from_le_bytes(required::<4>(c.next())?);
    let rows_read = cell::<8>(c.next())?.map(u64::from_le_bytes);
    let bytes_read = cell::<8>(c.next())?.map(u64::from_le_bytes);
    let shards_failed = cell::<2>(c.next())?.map(u16::from_le_bytes);
    let shards_skipped = cell::<2>(c.next())?.map(u16::from_le_bytes);
    let retention_floor = cell::<8>(c.next())?.map(i64::from_le_bytes);
    let excluded_dims = list(c.next())?;
    let warnings = list(c.next())?;
    let infos = list(c.next())?;
    let upstream_query_ids = list(c.next())?;
    let read_cache = cell::<1>(c.next())?.map(u8::from_le_bytes);
    if read_cache.is_some_and(|r| r > 3) {
        return Err(PartError::Value("read_cache"));
    }
    let read_cache_through = cell::<8>(c.next())?.map(i64::from_le_bytes);
    let data_end = cell::<8>(c.next())?.map(i64::from_le_bytes);
    let upstream_ms = u32::from_le_bytes(required::<4>(c.next())?);
    let convert_ms = u32::from_le_bytes(required::<4>(c.next())?);
    Ok(Coverage {
        phase,
        exactness,
        rollup_level_s,
        sampled_ratio,
        truncated,
        truncation_reason,
        dropped_count,
        series_returned,
        rows_read,
        bytes_read,
        shards_failed,
        shards_skipped,
        retention_floor,
        excluded_dims,
        warnings,
        infos,
        upstream_query_ids,
        read_cache,
        read_cache_through,
        data_end,
        upstream_ms,
        convert_ms,
    })
}

/// The `error/1` row of a validated batch, with the code set checked.
pub(crate) fn error_row(cols: &[Col]) -> Result<ErrorRow, PartError> {
    one_row(cols)?;
    let mut c = cols.iter();
    let code = u8::from_le_bytes(required::<1>(c.next())?);
    if code > 8 {
        return Err(PartError::Value("code"));
    }
    let http_status = u16::from_le_bytes(required::<2>(c.next())?);
    let message = text(c.next())?.ok_or(PartError::Ipc(IpcError::Layout("nulls")))?;
    let position = cell::<4>(c.next())?.map(u32::from_le_bytes);
    let retry_after_ms = cell::<4>(c.next())?.map(u32::from_le_bytes);
    let suggestion = text(c.next())?;
    Ok(ErrorRow {
        code,
        http_status,
        message,
        position,
        retry_after_ms,
        suggestion,
    })
}

#[cfg(test)]
mod tests {
    //! unit:coverage-complete, Rust side (plan #68 B2 §5; T04-012, VIZ-027, T22-006).
    use super::*;

    fn clean(exactness: u8) -> Coverage {
        Coverage {
            phase: Phase::Final,
            exactness,
            rollup_level_s: None,
            sampled_ratio: None,
            truncated: false,
            truncation_reason: None,
            dropped_count: None,
            series_returned: 3,
            rows_read: None,
            bytes_read: None,
            shards_failed: None,
            shards_skipped: None,
            retention_floor: None,
            excluded_dims: Vec::new(),
            warnings: Vec::new(),
            infos: Vec::new(),
            upstream_query_ids: Vec::new(),
            read_cache: None,
            read_cache_through: None,
            data_end: None,
            upstream_ms: 0,
            convert_ms: 0,
        }
    }

    type Edit = fn(&mut Coverage);

    #[test]
    fn completeness_retention_and_exactness() {
        const REQ: i64 = 1_000_000;
        // (name, edit, complete, retention_limited)
        let cases: [(&str, Edit, bool, bool); 10] = [
            ("complete", |_| {}, true, false),
            ("truncated", |c| c.truncated = true, false, false),
            ("warning", |c| c.warnings = vec!["w".into()], false, false),
            ("partial", |c| c.phase = Phase::Partial, false, false),
            (
                "excluded_dims",
                |c| c.excluded_dims = vec!["pod".into()],
                false,
                false,
            ),
            (
                "shards_failed 1",
                |c| c.shards_failed = Some(1),
                false,
                false,
            ),
            (
                "sampled_ratio 0.5",
                |c| c.sampled_ratio = Some(0.5),
                false,
                false,
            ),
            (
                "floor after",
                |c| c.retention_floor = Some(1_000_001),
                false,
                true,
            ),
            (
                "floor at",
                |c| c.retention_floor = Some(1_000_000),
                true,
                false,
            ),
            (
                "floor before",
                |c| c.retention_floor = Some(999_999),
                true,
                false,
            ),
        ];
        for exactness in [0u8, 4] {
            for (name, edit, complete, limited) in cases {
                let mut c = clean(exactness);
                edit(&mut c);
                assert_eq!(c.complete(REQ), complete, "{name} at exactness {exactness}");
                assert_eq!(c.retention_limited(REQ), limited, "{name}");
                assert_eq!(
                    c.exact(REQ),
                    complete && exactness == 0,
                    "{name} at exactness {exactness}"
                );
            }
        }
        // Zero counters and a full sample are still complete.
        let mut c = clean(0);
        c.shards_failed = Some(0);
        c.shards_skipped = Some(0);
        c.dropped_count = Some(0);
        c.sampled_ratio = Some(1.0);
        assert!(c.complete(REQ));
        c.dropped_count = Some(2);
        assert!(!c.complete(REQ));
        let mut c = clean(0);
        c.shards_skipped = Some(1);
        assert!(!c.complete(REQ));
    }

    #[test]
    fn retention_uses_the_requested_start_not_the_grid_start() {
        // Requested 10 500 on a grid starting at 10 000 (step 1 000).
        let mut c = clean(4);
        c.retention_floor = Some(10_250);
        assert!(c.complete(10_500) && !c.retention_limited(10_500));
        c.retention_floor = Some(10_750);
        assert!(!c.complete(10_500) && c.retention_limited(10_500));
    }
}
