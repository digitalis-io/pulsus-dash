//! Query flags of the runtime page (T03 §10): `?mode=` and, in probe builds only, `?fault=`.

use dash_gpu::{Fault, ForcedMode};

/// The value of `key` in a `location.search` string (`?a=1&b=2`), if present.
fn param<'a>(q: &'a str, key: &str) -> Option<&'a str> {
    q.trim_start_matches('?')
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .find(|(k, _)| *k == key)
        .map(|(_, v)| v)
}

/// `mode=t2|static`, else `None` (`mode=st` is decided by `boot.js`, before the core loads).
pub fn parse_query(q: &str) -> ForcedMode {
    match param(q, "mode") {
        Some("t2") => ForcedMode::T2,
        Some("static") => ForcedMode::Static,
        _ => ForcedMode::None,
    }
}

/// `fault=webgpu-device|webgpu-surface`, else `None`. Release builds never call this.
pub fn parse_fault(q: &str) -> Option<Fault> {
    match param(q, "fault") {
        Some("webgpu-device") => Some(Fault::WebGpuBeforeSurface),
        Some("webgpu-surface") => Some(Fault::WebGpuAfterSurface),
        _ => None,
    }
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
