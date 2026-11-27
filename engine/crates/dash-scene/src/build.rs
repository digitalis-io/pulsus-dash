//! `build`: one viewport to its draw list and `a11y` summary (plan #68 §3.8, §4.1). A pure
//! function of the viewport: the caller sets the camera and the band (D-GESTURE). [`build_frame`]
//! also returns the stage (plan #68 C2a2) and what picking reads (plan #68 C2b): the chunk, the
//! series shown, the view and the value axis of the list. Plan #68 C2c1: thresholds widen the auto
//! domain, events reserve the label band, and both are drawn as a layer `Overlay` item. Plan #68
//! C2c2: the selection tags the Line item with its emphasis and puts its band first in that item.

use dash_axes::{PlotRect, VisKind, event_band, value_axis};
use dash_marks::desc::{Area, DrawList, MarkItem};
use dash_scales::Range64;
use dash_scales::encode::{axis_map, choose_encoding, is_far};
use dash_tokens::{ColourRole, colour, series_palette};
use dash_wire::Chunk;

use crate::camera::{Camera, YRange, js_round};
use crate::layer::{event_shapes, threshold_shapes, with_thresholds};
use crate::selection::{emphasis, matched, selection_band};
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

/// The most series a line area is drawn under (ADR-0036).
const MAX_AREA_SERIES: usize = 4;

/// ADR-0036: the area of a Line item: asked for by the spec, 1–4 series shown, no selection at
/// all (keys or an interval, matched or not) and 2D (no lanes); `opacity.chart-area` ÷ shown, so
/// the stacked tint stays within it.
fn area_of(
    spec: &crate::spec::LineSpec,
    shown: usize,
    selection: &crate::selection::SelectionIn,
    lanes: &Option<Vec<u16>>,
) -> Option<Area> {
    let selected =
        !selection.keys.is_empty() || selection.from_ms.is_some() || selection.to_ms.is_some();
    (spec.area && (1..=MAX_AREA_SERIES).contains(&shown) && !selected && lanes.is_none()).then(
        || Area {
            alpha_top: dash_tokens::opacity::CHART_AREA / shown as f32,
        },
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
    /// Samples of series 0 when a series is shown, else 0: the keyboard crosshair's range.
    pub pick_count: u32,
}

/// One build of a viewport (plan #68 C2b §3.2): the draw list, summary, stage and what picking
/// reads; `pick` is Some exactly when `stage` is.
#[derive(Clone, Debug)]
pub struct Built {
    pub list: DrawList,
    pub summary: Option<FrameSummary>,
    pub stage: Option<StageInfo>,
    pub pick: Option<std::sync::Arc<crate::hover::PickSnap>>,
}

/// The draw list of `v` and its summary. No data, no window, an unsupported kind or an empty plot
/// → the clear only and no summary (as the interim renderer draws no layer).
pub fn build(v: &Viewport) -> (DrawList, Option<FrameSummary>) {
    let b = build_frame(v);
    (b.list, b.summary)
}

/// [`build`] with the stage of the list (its plot, value domain, band (`band_w`: the held band, or
/// the measured one) and pick count) and its pick snapshot; both None exactly when there is no
/// summary (no data, no window, an unsupported kind or an empty plot).
pub fn build_frame(v: &Viewport) -> Built {
    let mut palette = [colour(v.theme, ColourRole::ChartGrid); 10];
    palette[..8].copy_from_slice(&series_palette(v.theme));
    palette[9] = colour(v.theme, ColourRole::ChartAxis);
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
    let none = |list| Built {
        list,
        summary: None,
        stage: None,
        pick: None,
    };
    let (VisSpec::Line(spec), Some(chunk)) = (&v.spec, &v.data) else {
        return none(list);
    };
    let window = cam.x;
    if !(window.lo.is_finite() && window.hi.is_finite() && window.hi > window.lo) {
        return none(list);
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
    // The auto domain includes every finite threshold (TS `lineModel`); the summary's min and max
    // stay the data's. The event label band is reserved once the frame holds an event (ADR-0023).
    let (lo, hi) = with_thresholds(min, max, &spec.thresholds);
    let axis = value_axis(
        VisKind::Line,
        v.css.w,
        v.css.h,
        lo,
        hi,
        manual,
        &spec.unit,
        v.band,
        event_band(VisKind::Line, v.events.len()),
    );
    let plot = axis.plot;
    if !(plot.width > 0.0 && plot.height > 0.0) {
        return none(list);
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
        baseline: (js_round(plot.y + plot.height) - 1.0) as f32,
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
        let lanes = None;
        let area = area_of(spec, shown, &v.selection, &lanes);
        list.items.push(MarkItem::Line {
            chunk: chunk.clone(),
            series: 0..shown as u32,
            window: (window.lo, window.hi),
            n: plot.width.floor().max(0.0) as u32,
            plot: rect(&plot),
            encoding: enc,
            axis: (m.ku as f32, m.ou as f32),
            colour_slots,
            lanes,
            emphasis: matched(chunk, shown, &v.selection).map(|m| emphasis(m, v.theme)),
            width_css: dash_tokens::size::CHART_LINE,
            far: is_far(&enc, chunk.finite),
            area,
        });
    }
    // The layer marks (plan #68 C2c1 §4.2, C2c2 §4.2): the selection band, thresholds, then events
    // (Canvas 2D's order), over the series and under the hover overlay; inside the plot by
    // construction.
    let mut shapes: Vec<_> = selection_band(&plot, window, &v.selection, v.dpr, v.theme)
        .into_iter()
        .collect();
    shapes.extend(threshold_shapes(&axis, &spec.thresholds, v.theme));
    shapes.extend(event_shapes(&plot, window, &v.events, axis.manual, v.theme));
    if !shapes.is_empty() {
        list.items.push(MarkItem::Overlay { shapes });
    }
    if axis.manual {
        list.clip = Some(rect(&plot));
    }
    let pick_count = if shown > 0 {
        chunk.offsets[1] - chunk.offsets[0]
    } else {
        0
    };
    let stage = StageInfo {
        plot,
        domain: Some(axis.domain),
        band_w: axis.band_w,
        pick_count,
    };
    let pick = crate::hover::PickSnap {
        chunk: chunk.clone(),
        shown: shown as u32,
        view: window,
        axis,
    };
    Built {
        list,
        summary: Some(summary),
        stage: Some(stage),
        pick: Some(std::sync::Arc::new(pick)),
    }
}
