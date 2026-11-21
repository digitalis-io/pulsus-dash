//! golden:extreme-range (plan #68 §5, T02-014): line-1 scaled to [−MAX, MAX] and [MAX/2, MAX] draws
//! finite geometry, equal on both tiers, covering every finite sample's pixel.
mod common;

use std::sync::Arc;

use common::*;
use dash_golden::{BLACK, PAGE_CSS, RefFrame, WHITE, page_viewport, reference_mask, render_list};
use dash_gpu::Tier;
use dash_marks::MarkItem;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scene::{Range64, Theme, build};
use dash_wire::Chunk;
use pulsus_synth::{GALLERY_WINDOW, GalleryLine};

fn scaled(c: &Chunk, f: impl Fn(usize, f64) -> f64) -> Chunk {
    let (lo, hi) = c.finite.unwrap_or((0.0, 1.0));
    let values: Vec<f64> = c.values.iter().enumerate().map(|(k, v)| f(k, (v - lo) / (hi - lo))).collect();
    let finite = values.iter().filter(|v| v.is_finite()).fold(None, |acc: Option<(f64, f64)>, v| {
        Some(acc.map_or((*v, *v), |(a, b)| (a.min(*v), b.max(*v))))
    });
    Chunk { values, finite, ..c.clone() }
}

#[test]
fn extreme_ranges_render() {
    let base = page_viewport(GalleryLine::Line1, Theme::Dark, PAGE_CSS, 1.0, None);
    let Some(chunk) = base.data.clone() else { panic!("no data") };
    let cases = [
        ("[-MAX, MAX]", scaled(&chunk, |k, q| if k % 2 == 0 { q * f64::MAX } else { -q * f64::MAX })),
        ("[MAX/2, MAX]", scaled(&chunk, |_, q| f64::MAX / 2.0 + q * (f64::MAX / 2.0))),
    ];
    let (t1, t2) = (ctx(Tier::T1), ctx(Tier::T2));
    for (name, data) in cases {
        let mut v = base.clone();
        v.data = Some(Arc::new(data.clone()));
        let (mut list, summary) = build(&v);
        let Some(summary) = summary else { panic!("{name}: no summary") };
        let Some(ax) = summary.value_axis else { panic!("{name}: no axis") };
        list.items.retain(|i| matches!(i, MarkItem::Line { .. }));
        assert_eq!(list.items.len(), 1, "{name}: no line item");
        list.palette = [WHITE; 9];
        list.clear = BLACK;
        let a = render_list(&t1, &mut Renderer::new(&t1, wgpu::TextureFormat::Rgba8Unorm, RendererOptions::default()), &list);
        let b = render_list(&t2, &mut Renderer::new(&t2, wgpu::TextureFormat::Rgba8Unorm, RendererOptions::default()), &list);
        assert!(a == b, "{name}: tiers differ");
        let p = summary.plot;
        let frame = RefFrame {
            plot: [p.x, p.y, p.width, p.height],
            window: GALLERY_WINDOW,
            axis: Range64 { lo: ax.min, hi: ax.max },
            dpr: 1.0,
            width_css: 1.5,
            size: (a.w, a.h),
        };
        let masks = reference_mask(&data, &frame);
        assert!(!masks.a.is_empty(), "{name}: no sample pixel");
        let missing: Vec<_> = masks.a.iter().filter(|(x, y)| !a.covered(*x, *y)).take(5).collect();
        assert!(missing.is_empty(), "{name}: uncovered sample pixels {missing:?}");
    }
}
