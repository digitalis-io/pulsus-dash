//! `build`: one viewport to its draw list and `a11y` summary (plan #68 §3.8, §4.1). A pure
//! function of the viewport: the caller sets the camera and the band (D-GESTURE).

use dash_axes::{PlotRect, VisKind, value_axis};
use dash_marks::desc::{DrawList, MarkItem};
use dash_scales::Range64;
use dash_scales::encode::{axis_map, choose_encoding, is_far};
use dash_tokens::{ColourRole, colour, series_palette};
use dash_wire::Chunk;

use crate::camera::{Camera, YRange, js_round};
use crate::spec::VisSpec;
use crate::summary::{FrameSummary, ValueAxisSummary};
use crate::{Size64, Viewport};

/// The most lanes an instance can carry (16 bits).
const MAX_LANES: u32 = 65_535;

/// TS `lineStats`: min and max over every finite shown value; last = the highest last finite value.
fn line_stats(chunk: &Chunk, shown: usize) -> (Option<f64>, Option<f64>, Option<f64>) {
    let (mut min, mut max, mut last) = (f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for s in 0..shown {
        let mut last_of = f64::NAN;
        for v in chunk.series_values(s).iter().filter(|v| v.is_finite()) {
            min = min.min(*v);
            max = max.max(*v);
            last_of = *v;
        }
        if last_of.is_finite() && last_of > last {
            last = last_of;
        }
    }
    if min == f64::INFINITY {
        return (None, None, None);
    }
    (
        Some(min),
        Some(max),
        (last != f64::NEG_INFINITY).then_some(last),
    )
}

fn rect(p: &PlotRect) -> [f32; 4] {
    [p.x as f32, p.y as f32, p.width as f32, p.height as f32]
}

/// What the main thread's camera controller reads of a presentation (plan #68 C2a2 §3.3): its
/// plot, its value domain (None: no value axis) and the value-label band width it used, CSS px.
#[derive(Clone, Debug, PartialEq)]
pub struct StageInfo {
    pub plot: PlotRect,
    pub domain: Option<Range64>,
    pub band_w: f64,
}

/// The draw list of `v` and its summary. No data, no window, an unsupported kind or an empty plot
/// → the clear only and no summary (as the interim renderer draws no layer).
pub fn build(v: &Viewport) -> (DrawList, Option<FrameSummary>) {
    let (list, summary, _) = build_stage(v);
    (list, summary)
}

/// [`build`] with the stage of the list: its plot, value domain and band (`band_w`: the held band,
/// or the measured one); None exactly when there is no summary (no data, no window, an
/// unsupported kind or an empty plot).
pub fn build_stage(v: &Viewport) -> (DrawList, Option<FrameSummary>, Option<StageInfo>) {
    let mut palette = [colour(v.theme, ColourRole::Hairline); 9];
    palette[..8].copy_from_slice(&series_palette(v.theme));
    let Camera::Plot2D(cam) = v.camera;
    let view_proj = v.camera.view_proj(Size64 {
        w: v.css.w,
        h: v.css.h,
    });
    let mut list = DrawList {
        clear: colour(v.theme, ColourRole::Surface1),
        css: (v.css.w, v.css.h),
        dpr: v.dpr,
        view_proj: view_proj.to_cols_array_2d().map(|c| c.map(|x| x as f32)),
        palette,
        clip: None,
        items: Vec::new(),
    };
    let (VisSpec::Line(spec), Some(chunk)) = (&v.spec, &v.data) else {
        return (list, None, None);
    };
    let window = cam.x;
    if !(window.lo.is_finite() && window.hi.is_finite() && window.hi > window.lo) {
        return (list, None, None);
    }
    let shown = chunk
        .series
        .len()
        .min(spec.max_series.min(MAX_LANES) as usize);
    let (min, max, last) = line_stats(chunk, shown);
    let manual = match cam.y {
        YRange::Manual(r) => Some(r),
        YRange::Auto => None,
    };
    let axis = value_axis(
        VisKind::Line,
        v.css.w,
        v.css.h,
        min.unwrap_or(0.0),
        max.unwrap_or(0.0),
        manual,
        &spec.unit,
        v.band,
    );
    let plot = axis.plot;
    if !(plot.width > 0.0 && plot.height > 0.0) {
        return (list, None, None);
    }
    let summary = FrameSummary {
        kind: VisKind::Line,
        series_total: chunk.series.len() as u32,
        series_shown: shown as u32,
        from_ms: window.lo,
        to_ms: window.hi,
        min,
        max,
        last,
        plot,
        value_axis: Some(ValueAxisSummary {
            min: axis.domain.lo,
            max: axis.domain.hi,
            manual: axis.manual,
        }),
    };
    let lines = axis
        .labels
        .iter()
        .map(|l| js_round(l.y_css) as f32)
        .collect();
    list.items.push(MarkItem::Guides {
        lines,
        plot: rect(&plot),
    });
    let dpr = f64::from(v.dpr);
    if let Some(enc) = choose_encoding(
        chunk.finite.map(Range64::from),
        axis.domain,
        plot.height * dpr,
    ) {
        let m = axis_map(&enc, axis.domain, plot.height);
        let colour_slots = chunk.series[..shown]
            .iter()
            .map(|s| dash_colour::series_colour_index(s.key_hash, &s.labels))
            .collect();
        list.items.push(MarkItem::Line {
            chunk: chunk.clone(),
            series: 0..shown as u32,
            window: (window.lo, window.hi),
            n: plot.width.floor().max(0.0) as u32,
            plot: rect(&plot),
            encoding: enc,
            axis: (m.ku as f32, m.ou as f32),
            colour_slots,
            lanes: None,
            width_css: dash_tokens::size::CHART_LINE,
            far: is_far(&enc, chunk.finite),
        });
    }
    if axis.manual {
        list.clip = Some(rect(&plot));
    }
    let stage = StageInfo {
        plot,
        domain: Some(axis.domain),
        band_w: axis.band_w,
    };
    (list, Some(summary), Some(stage))
}
