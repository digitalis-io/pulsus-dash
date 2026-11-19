//! Query flags of the runtime page (T03 §10): `?mode=`, `?scene=line` with `?series=` and
//! `?points=` (#24), and, in probe builds only, `?fault=`.

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

/// The line scene's dataset size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineParams {
    pub series: u32,
    pub points: u32,
}

/// `bench:frame-line-1e8`: 1 000 series × 100 000 points.
pub const LINE_DEFAULT: LineParams = LineParams {
    series: 1_000,
    points: 100_000,
};

/// The scene of the page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SceneKind {
    /// The #23 rect spike (default).
    Rect,
    Line(LineParams),
}

/// `scene=line` → [`SceneKind::Line`]; out-of-range or unparsable sizes → [`LINE_DEFAULT`].
pub fn parse_scene(_q: &str) -> SceneKind {
    SceneKind::Rect
}

/// Line-scene test faults (probe builds only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineFault {
    /// `fault=line-layers-1`: the render uses `max_layers = 1`.
    Layers1,
    /// `fault=line-wire`: data-0 truncates the second batch message.
    Wire,
}

pub fn parse_line_fault(_q: &str) -> Option<LineFault> {
    None
}

/// The points one ST worker holds (T03 §9.2).
pub const ST_POINT_CEILING: u64 = 10_000_000;

/// Series held: `min(series, ceiling / points)` in ST, else `series`.
pub fn effective_series(p: LineParams, _st: bool) -> u32 {
    p.series
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_parse_scene() {
        assert_eq!(parse_scene(""), SceneKind::Rect);
        assert_eq!(parse_scene("?mode=t2"), SceneKind::Rect);
        assert_eq!(parse_scene("?scene=line"), SceneKind::Line(LINE_DEFAULT));
        assert_eq!(
            parse_scene("?scene=line&series=50&points=20000"),
            SceneKind::Line(LineParams {
                series: 50,
                points: 20_000
            })
        );
        assert_eq!(
            parse_scene("?scene=line&series=7"),
            SceneKind::Line(LineParams {
                series: 7,
                points: 100_000
            })
        );
        for bad in [
            "?scene=line&series=0",
            "?scene=line&series=abc",
            "?scene=line&series=1024&points=1000000",
            "?scene=line&points=1",
            "?scene=line&series=1025&points=2",
        ] {
            assert_eq!(parse_scene(bad), SceneKind::Line(LINE_DEFAULT), "{bad}");
        }
        assert_eq!(
            parse_scene("?scene=line&series=1024&points=97656"),
            SceneKind::Line(LineParams {
                series: 1_024,
                points: 97_656
            })
        );
        assert_eq!(
            parse_line_fault("?scene=line&fault=line-layers-1"),
            Some(LineFault::Layers1)
        );
        assert_eq!(parse_line_fault("?fault=line-wire"), Some(LineFault::Wire));
        assert_eq!(parse_line_fault("?fault=webgpu-device"), None);
        let big = LineParams {
            series: 200,
            points: 100_000,
        };
        assert_eq!(effective_series(big, true), 100);
        assert_eq!(effective_series(big, false), 200);
        let small = LineParams {
            series: 50,
            points: 20_000,
        };
        assert_eq!(effective_series(small, true), 50);
    }

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
