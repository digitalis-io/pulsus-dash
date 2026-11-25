//! `coverage/1` and `error/1` rows (T04 §5.3, plan #68 B1 §3.3) and the completeness rule
//! (T04-012 subset, VIZ-027).

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
    pub fn complete(&self, _requested_start_ms: i64) -> bool {
        false
    }

    /// A retention floor after the requested start (`limited by retention`, VIZ-027).
    pub fn retention_limited(&self, _requested_start_ms: i64) -> bool {
        false
    }

    /// Complete and raw-exact (exactness 0).
    pub fn exact(&self, _requested_start_ms: i64) -> bool {
        false
    }
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
