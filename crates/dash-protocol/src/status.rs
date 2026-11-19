//! Runtime status codes (T03 §9.3): the value of `<html data-dash-status>` and of the control
//! block's `STATUS` word.

/// The runtime status the page shows (T03-025).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum RuntimeStatus {
    Booting = 0,
    TierT1 = 1,
    TierT2 = 2,
    Static = 3,
    Failed = 4,
    Stale = 5,
}

/// `render_start` result meaning "the canvas is committed to a failed WebGPU context; restart the
/// render worker on a fresh canvas with T2". Never written to the page.
pub const RETRY_T2: u32 = 0x100;

impl RuntimeStatus {
    pub const ALL: [RuntimeStatus; 6] = [
        RuntimeStatus::Booting,
        RuntimeStatus::TierT1,
        RuntimeStatus::TierT2,
        RuntimeStatus::Static,
        RuntimeStatus::Failed,
        RuntimeStatus::Stale,
    ];

    /// The status with code `v`, if any (`RETRY_T2` is not a status).
    pub fn from_u32(v: u32) -> Option<Self> {
        Self::ALL.into_iter().find(|s| *s as u32 == v)
    }

    /// The `STATUS_<name>` suffix in `layout.gen.js`.
    pub fn js_name(self) -> &'static str {
        match self {
            RuntimeStatus::Booting => "BOOTING",
            RuntimeStatus::TierT1 => "TIER_T1",
            RuntimeStatus::TierT2 => "TIER_T2",
            RuntimeStatus::Static => "STATIC",
            RuntimeStatus::Failed => "FAILED",
            RuntimeStatus::Stale => "STALE",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_codes_roundtrip() {
        let codes: Vec<u32> = RuntimeStatus::ALL.iter().map(|s| *s as u32).collect();
        assert_eq!(codes, vec![0, 1, 2, 3, 4, 5]);
        for s in RuntimeStatus::ALL {
            assert_eq!(RuntimeStatus::from_u32(s as u32), Some(s), "{s:?}");
        }
        assert_eq!(RuntimeStatus::from_u32(6), None);
        assert_eq!(RuntimeStatus::from_u32(RETRY_T2), None);
        let names: Vec<&str> = RuntimeStatus::ALL.iter().map(|s| s.js_name()).collect();
        assert_eq!(
            names,
            ["BOOTING", "TIER_T1", "TIER_T2", "STATIC", "FAILED", "STALE"]
        );
    }
}
