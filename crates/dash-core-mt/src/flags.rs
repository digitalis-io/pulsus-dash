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

/// Most series of the line scene (the chunk table's slots).
pub const MAX_LINE_SERIES: u32 = 1_024;
/// Most points per series (pyramid levels ≤ 4).
pub const MAX_LINE_POINTS: u32 = 1_000_000;
/// Most points of the layer (T04 §5.7 budget).
pub const MAX_LINE_TOTAL: u64 = 100_000_000;

/// `scene=line` → [`SceneKind::Line`] with `series ∈ [1, 1024]`, `points ∈ [2, 10⁶]` and
/// `series·points ≤ 10⁸` (an absent size takes its default); any size out of range or
/// unparsable → [`LINE_DEFAULT`]. Anything else → [`SceneKind::Rect`].
pub fn parse_scene(q: &str) -> SceneKind {
    if param(q, "scene") != Some("line") {
        return SceneKind::Rect;
    }
    let size = |key, default: u32, max: u32, min: u32| match param(q, key) {
        None => Some(default),
        Some(v) => v.parse::<u32>().ok().filter(|v| (min..=max).contains(v)),
    };
    let p = match (
        size("series", LINE_DEFAULT.series, MAX_LINE_SERIES, 1),
        size("points", LINE_DEFAULT.points, MAX_LINE_POINTS, 2),
    ) {
        (Some(series), Some(points)) if u64::from(series) * u64::from(points) <= MAX_LINE_TOTAL => {
            LineParams { series, points }
        }
        _ => LINE_DEFAULT,
    };
    SceneKind::Line(p)
}

/// Line-scene test faults (probe builds only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineFault {
    /// `fault=line-layers-1`: the render uses `max_layers = 1`.
    Layers1,
    /// `fault=line-wire`: data-0 truncates the second batch message.
    Wire,
}

/// `fault=line-layers-1|line-wire`, else `None`. Release builds never call this.
pub fn parse_line_fault(q: &str) -> Option<LineFault> {
    match param(q, "fault") {
        Some("line-layers-1") => Some(LineFault::Layers1),
        Some("line-wire") => Some(LineFault::Wire),
        _ => None,
    }
}

/// The points one ST worker holds (T03 §9.2).
pub const ST_POINT_CEILING: u64 = 10_000_000;

/// Series held: `min(series, ceiling / points)` in ST, else `series`.
pub fn effective_series(p: LineParams, st: bool) -> u32 {
    if st {
        let fit = ST_POINT_CEILING / u64::from(p.points.max(1));
        p.series.min(u32::try_from(fit).unwrap_or(u32::MAX))
    } else {
        p.series
    }
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
