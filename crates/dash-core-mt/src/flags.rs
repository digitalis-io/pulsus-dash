//! Query flags of the runtime page (T03 §10): `?mode=` and, in probe builds, `?fault=`. Stub.

use dash_gpu::{Fault, ForcedMode};

/// `mode=t2|static`, else `None` (`st` is decided by boot.js, not here).
pub fn parse_query(_q: &str) -> ForcedMode {
    ForcedMode::None
}

/// `fault=webgpu-device|webgpu-surface`, else `None`.
pub fn parse_fault(_q: &str) -> Option<Fault> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_parse_query_and_fault() {
        assert_eq!(parse_query("?mode=t2"), ForcedMode::T2);
        assert_eq!(parse_query("?mode=static"), ForcedMode::Static);
        assert_eq!(parse_query("?a=1&mode=t2"), ForcedMode::T2);
        assert_eq!(parse_query("?mode=st"), ForcedMode::None);
        assert_eq!(parse_query(""), ForcedMode::None);
        assert_eq!(
            parse_fault("?fault=webgpu-device"),
            Some(Fault::WebGpuBeforeSurface)
        );
        assert_eq!(
            parse_fault("?fault=webgpu-surface"),
            Some(Fault::WebGpuAfterSurface)
        );
        assert_eq!(parse_fault("?fault=x"), None);
    }
}
