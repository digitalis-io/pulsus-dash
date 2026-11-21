//! unit:scene-model, subset (plan #68 §5, T02-020, D-CAM).
mod common;

use common::*;
use dash_scene::{Band, Camera, LineSpec, PlotCamera, Range64, Scene, Size64, YRange};
use dash_units::Unit;
use glam::DVec4;

#[test]
fn plot2d_maps_css_to_clip() {
    let cam = Camera::Plot2D(PlotCamera {
        x: Range64 { lo: 0.0, hi: 1.0 },
        y: YRange::Auto,
    });
    let m = cam.view_proj(Size64 {
        w: 1118.0,
        h: 240.0,
    });
    for z in [0.0, 3.0, 65535.0] {
        let a = m * DVec4::new(0.0, 0.0, z, 1.0);
        let b = m * DVec4::new(1118.0, 240.0, z, 1.0);
        assert_eq!((a.x / a.w, a.y / a.w), (-1.0, 1.0), "z {z}");
        assert_eq!((b.x / b.w, b.y / b.w), (1.0, -1.0), "z {z}");
        assert_eq!(a.z, 0.0);
    }
    moves_between_scenes();
}

/// The scene model keeps a viewport whole when it moves between scenes (T02-020).
fn moves_between_scenes() {
    let window = Range64 {
        lo: T0,
        hi: T0 + 1000.0,
    };
    let v = viewport(
        chunk_of(&[1.0, 2.0]),
        LineSpec::new(Unit::Bytes),
        window,
        Band::Measure,
    );
    let mut a = Scene { viewports: vec![v] };
    let mut b = Scene::default();
    let moved = a.viewports.remove(0);
    let (spec, camera, data) = (moved.spec.clone(), moved.camera, moved.data.clone());
    b.viewports.push(moved);
    let kept = &b.viewports[0];
    assert_eq!(kept.spec, spec);
    assert_eq!(kept.camera, camera);
    assert!(
        kept.data
            .as_ref()
            .zip(data.as_ref())
            .is_some_and(|(x, y)| std::sync::Arc::ptr_eq(x, y))
    );
    assert!(a.viewports.is_empty());
}
