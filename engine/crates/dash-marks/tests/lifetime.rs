//! unit:buffer-lifetime (plan #68 A.15.1, T02-014, T04 §5.7, PRF-023 engine share): column ranges
//! follow the window and width; encoded values follow the encoding only; one resident encoding
//! per chunk; staging ≤ 16 MiB; a dropped chunk leaves no buffer.
mod common;

use std::sync::Arc;

use common::*;
use dash_gpu::Tier;
use dash_marks::MarkItem;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scales::column_ranges;
use dash_scene::{
    Band, Camera, LineSpec, PlotCamera, Range64, Size64, Theme, Viewport, VisSpec, YRange, build,
};
use dash_units::Unit;
use pulsus_synth::reference::{WINDOW, f2};

fn line_of(v: &Viewport) -> Option<(u32, (f64, f64), dash_scales::encode::Encoding)> {
    build(v).0.items.into_iter().find_map(|i| match i {
        MarkItem::Line {
            n,
            window,
            encoding,
            ..
        } => Some((n, window, encoding)),
        _ => None,
    })
}

#[test]
fn ranges_and_values_have_their_own_lifetimes() {
    let fx = ok(f2(100, 10_000), "F2");
    for tier in [Tier::T1, Tier::T2] {
        let ctx = ctx(tier);
        let chunk = Arc::new(fx.chunk.clone());
        let spec = VisSpec::Line(LineSpec::new(Unit::None));
        let mut v = Viewport {
            id: 0,
            frame_id: None,
            css: Size64 {
                w: 1000.0,
                h: 400.0,
            },
            dpr: 1.0,
            theme: Theme::Dark,
            camera: Camera::Plot2D(PlotCamera::idle(Range64::from(WINDOW), &spec)),
            spec,
            data: Some(chunk.clone()),
            band: Band::Measure,
        };
        let mut r = Renderer::new(
            &ctx,
            wgpu::TextureFormat::Rgba8Unorm,
            RendererOptions::default(),
        );
        let _ = render(&ctx, &mut r, &build(&v).0);
        let c0 = r.debug_counters();
        assert_eq!((c0.ranges_builds, c0.value_encodes), (1, 1), "{tier:?}");
        assert_eq!(r.debug_resident().len(), 1, "{tier:?}");
        let mut peak = 1;
        let step = (WINDOW.1 - WINDOW.0) / 1000.0;
        let Camera::Plot2D(cam) = v.camera;
        let panned = PlotCamera {
            x: Range64 {
                lo: cam.x.lo + step,
                hi: cam.x.hi + step,
            },
            ..cam
        };
        let zoomed = PlotCamera {
            x: Range64 {
                lo: panned.x.lo,
                hi: panned.x.lo + (panned.x.hi - panned.x.lo) / 2.0,
            },
            ..panned
        };
        let mut prev = r.debug_counters();
        for (what, change) in [("pan", 0), ("zoom", 1), ("resize", 2)] {
            match change {
                0 => v.camera = Camera::Plot2D(panned),
                1 => v.camera = Camera::Plot2D(zoomed),
                _ => v.css = Size64 { w: 800.0, h: 400.0 },
            }
            let _ = render(&ctx, &mut r, &build(&v).0);
            let c = r.debug_counters();
            assert_eq!(
                c.ranges_builds,
                prev.ranges_builds + 1,
                "{tier:?} {what}: ranges_builds"
            );
            assert_eq!(
                c.value_encodes, prev.value_encodes,
                "{tier:?} {what}: value_encodes"
            );
            let Some((n, window, _)) = line_of(&v) else {
                panic!("{tier:?} {what}: no line")
            };
            let fresh = column_ranges(&chunk, 0..100, window.0, window.1, n);
            assert_eq!(r.debug_ranges(&ctx), Some(fresh), "{tier:?} {what}: ranges");
            peak = peak.max(r.debug_resident().len());
            prev = c;
        }
        // A manual range far narrower than the data selects the axis encoding (A.3.1).
        let Camera::Plot2D(cam) = v.camera;
        v.camera = Camera::Plot2D(PlotCamera {
            y: YRange::Manual(Range64 {
                lo: 10.0,
                hi: 10.000_001,
            }),
            ..cam
        });
        let Some((_, _, enc)) = line_of(&v) else {
            panic!("no line")
        };
        let _ = render(&ctx, &mut r, &build(&v).0);
        let c = r.debug_counters();
        assert_eq!(
            c.value_encodes,
            prev.value_encodes + 1,
            "{tier:?}: axis change encodes once"
        );
        let resident = r.debug_resident();
        assert_eq!(resident.len(), 1, "{tier:?}: {resident:?}");
        assert_eq!(resident[0].1, enc, "{tier:?}");
        peak = peak.max(resident.len());
        assert_eq!(peak, 1, "{tier:?}");
        // T1 encodes through the 16 MiB slab (L2); on T2 the CPU slab is the input (no staging).
        match tier {
            Tier::T1 => assert!(
                c.staging_bytes_max > 0 && c.staging_bytes_max <= 16 << 20,
                "{c:?}"
            ),
            Tier::T2 => assert_eq!(c.staging_bytes_max, 0, "{c:?}"),
        }
        v.data = None;
        drop(chunk);
        let _ = render(&ctx, &mut r, &build(&v).0);
        assert!(
            r.debug_resident().is_empty(),
            "{tier:?}: buffers outlive the chunk"
        );
    }
}
