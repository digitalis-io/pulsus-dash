//! Minimal axes (plan #24 §3.4): segments in device px, y up from the canvas bottom.

pub use dash_scales::Plot;

/// Vertical then horizontal gridlines, the two axis lines, then 4 CSS px ticks.
pub fn segments(
    _x_dom: (f64, f64),
    _y_dom: (f64, f64),
    _time_x: bool,
    _plot: &Plot,
    _dpr: f32,
) -> Vec<[f32; 4]> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_axes_segments() {
        let plot = Plot {
            x0: 48.0,
            y0: 24.0,
            w: 800,
            h: 400,
        };
        let s = segments((0.0, 3.6e6), (0.0, 100.0), true, &plot, 1.0);
        assert_eq!(s.len(), 7 + 6 + 2 + 13);
        let vertical = &s[..7];
        assert_eq!(vertical[0], [48.0, 24.0, 48.0, 424.0]);
        assert!(vertical.iter().all(|g| g[0] == g[2]));
        let horizontal = &s[7..13];
        assert!(
            horizontal
                .iter()
                .all(|g| g[1] == g[3] && g[0] == 48.0 && g[2] == 848.0)
        );
        assert_eq!(horizontal[5][1], 424.0);
        assert_eq!(s[13], [48.0, 24.0, 848.0, 24.0]);
        assert_eq!(s[14], [48.0, 24.0, 48.0, 424.0]);
        let ticks = &s[15..];
        assert_eq!(ticks[0], [48.0, 24.0, 48.0, 20.0]);
        assert_eq!(ticks[7], [48.0, 24.0, 44.0, 24.0]);
        for g in &s {
            assert!(g.iter().all(|v| (0.0..=856.0).contains(v)), "{g:?}");
        }
    }
}
