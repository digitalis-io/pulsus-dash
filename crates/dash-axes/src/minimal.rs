//! Minimal axes (plan #24 §3.4): gridlines, axis lines and ticks as segments in device px, y up
//! from the canvas bottom. Labels wait for M8 text.

use dash_scales::ticks::{linear_ticks, time_ticks};

pub use dash_scales::Plot;

/// Tick length in CSS px.
const TICK_CSS: f32 = 4.0;

/// Vertical then horizontal gridlines, the two axis lines (x then y), then 4 CSS px ticks (x then
/// y). X ticks target `max(2, plot.w/dpr/100)`, y ticks `max(2, plot.h/dpr/50)`.
pub fn segments(
    x_dom: (f64, f64),
    y_dom: (f64, f64),
    time_x: bool,
    plot: &Plot,
    dpr: f32,
) -> Vec<[f32; 4]> {
    let (w, h) = (plot.w as f32, plot.h as f32);
    let (x0, y0) = (plot.x0, plot.y0);
    let x_target = ((w / dpr / 100.0) as u32).max(2);
    let y_target = ((h / dpr / 50.0) as u32).max(2);
    let xt = if time_x {
        time_ticks(x_dom.0, x_dom.1, x_target)
    } else {
        linear_ticks(x_dom.0, x_dom.1, x_target)
    };
    let yt = linear_ticks(y_dom.0, y_dom.1, y_target);
    let at = |v: f64, dom: (f64, f64), len: f32| ((v - dom.0) / (dom.1 - dom.0)) as f32 * len;
    let xs: Vec<f32> = xt.iter().map(|t| x0 + at(*t, x_dom, w)).collect();
    let ys: Vec<f32> = yt.iter().map(|v| y0 + at(*v, y_dom, h)).collect();
    let tick = TICK_CSS * dpr;
    let mut out = Vec::with_capacity(2 * (xs.len() + ys.len()) + 2);
    out.extend(xs.iter().map(|x| [*x, y0, *x, y0 + h]));
    out.extend(ys.iter().map(|y| [x0, *y, x0 + w, *y]));
    out.push([x0, y0, x0 + w, y0]);
    out.push([x0, y0, x0, y0 + h]);
    out.extend(xs.iter().map(|x| [*x, y0, *x, y0 - tick]));
    out.extend(ys.iter().map(|y| [x0, *y, x0 - tick, *y]));
    out
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
