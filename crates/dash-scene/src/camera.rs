//! The 2D camera controller (T02-021, T02-022; plan #24 §4.5): wheel zoom anchored at the
//! pointer, drag pan, flick inertia. Device px, plot-relative, y up.

use dash_protocol::input::{InputRecord, RecordHeader};
use dash_scales::Plot;

/// Release speed above which a drag becomes a flick (CSS px/ms).
pub const FLICK_MIN_PX_PER_MS: f64 = 0.3;
/// Critically damped inertia rate (1/ms).
pub const OMEGA_PER_MS: f64 = 0.0194;
/// Inertia ends when `(1 + ωτ)e^(−ωτ)` falls below this.
pub const SETTLE_FRACTION: f64 = 0.02;
/// Pointer samples kept for the release velocity.
pub const VELOCITY_WINDOW_MS: f64 = 50.0;
/// Wheel pixels per doubling of the scale.
pub const WHEEL_PX_PER_DOUBLING: f64 = 400.0;

/// Scale limits and data extents (relative time, values).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limits {
    pub min_ms_per_px: f64,
    pub max_ms_per_px: f64,
    pub min_v_per_px: f64,
    pub max_v_per_px: f64,
    pub t_range: (f64, f64),
    pub v_range: (f64, f64),
}

/// The visible window: left edge time (relative to the layer start), bottom value and scales.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera2d {
    pub t_left_rel_ms: f64,
    pub ms_per_px: f64,
    pub v_bottom: f64,
    pub v_per_px: f64,
}

impl Camera2d {
    /// The data point at plot-relative device px `(x, y)`.
    pub fn data_at(&self, _x: f64, _y: f64) -> (f64, f64) {
        (0.0, 0.0)
    }

    /// The plot-relative device px of a data point.
    pub fn screen_of(&self, _t: f64, _v: f64) -> (f64, f64) {
        (0.0, 0.0)
    }

    /// Scales by `fx`, `fy` (clamped) keeping the clamped anchor under `(x, y)` in place.
    pub fn zoom_at(&mut self, _x: f64, _y: f64, _fx: f64, _fy: f64, _l: &Limits) {}

    /// Pans by device px (`dy` down-positive, as the pointer moves).
    pub fn pan_px(&mut self, _dx: f64, _dy: f64) {}
}

/// A CSS px pointer position (canvas top-left origin) in plot-relative device px, y up.
pub fn plot_xy(_plot: &Plot, _dpr: f32, _x_css: f32, _y_css: f32) -> (f64, f64) {
    (0.0, 0.0)
}

/// Drives a [`Camera2d`] from input records.
#[derive(Debug)]
pub struct Controller {
    camera: Camera2d,
    limits: Limits,
}

impl Controller {
    pub fn new(c: Camera2d, l: Limits) -> Self {
        Controller {
            camera: c,
            limits: l,
        }
    }

    pub fn camera(&self) -> &Camera2d {
        &self.camera
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    pub fn set_camera(&mut self, c: Camera2d, l: Limits) {
        self.camera = c;
        self.limits = l;
    }

    /// Inertia is running.
    pub fn moving(&self) -> bool {
        false
    }

    /// A pan, zoom or inertia step was applied since construction.
    pub fn user_moved(&self) -> bool {
        false
    }

    pub fn apply(&mut self, _h: &RecordHeader, _r: &InputRecord, _plot: &Plot, _dpr: f32) {}

    /// Advances inertia to main-thread time `t_main_ms`.
    pub fn step(&mut self, _t_main_ms: f64) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use dash_protocol::input::PointerPhase;
    use pulsus_synth::SplitMix64;

    const SHIFT: u16 = 1;
    const CTRL: u16 = 2;

    fn hdr(t_ms: f64) -> RecordHeader {
        RecordHeader {
            kind: 0,
            flags: 0,
            size: 40,
            seq: 0,
            t_ms,
        }
    }

    fn pointer(phase: PointerPhase, x: f32, y: f32, buttons: u16) -> InputRecord {
        InputRecord::Pointer {
            phase,
            x,
            y,
            pointer_id: 1,
            mods: 0,
            buttons,
            button: if matches!(phase, PointerPhase::Move) {
                -1
            } else {
                0
            },
            ptype: 0,
            pressure: 0,
            width: 1,
            height: 1,
            tilt_x: 0,
            tilt_y: 0,
        }
    }

    fn wheel(x: f32, y: f32, dy: f32, mods: u16) -> InputRecord {
        InputRecord::Wheel {
            x,
            y,
            dx: 0.0,
            dy,
            mods,
            mode: 0,
        }
    }

    fn plot(w: u32, h: u32) -> Plot {
        Plot {
            x0: 48.0,
            y0: 24.0,
            w,
            h,
        }
    }

    /// The §3.4 fit and limits of `n` samples `step` apart with values in [−1, 1].
    fn fitted(n: u32, step: f64, p: &Plot) -> Controller {
        let (w, h) = (f64::from(p.w), f64::from(p.h));
        let e = f64::from(n) * step;
        let r = 2.0;
        let c = Camera2d {
            t_left_rel_ms: 0.0,
            ms_per_px: e / w,
            v_bottom: -1.0 - 0.05 * r,
            v_per_px: 1.1 * r / h,
        };
        let l = Limits {
            min_ms_per_px: step / 16.0,
            max_ms_per_px: 4.0 * e / w,
            min_v_per_px: r * 1e-3 / h,
            max_v_per_px: r * 100.0 / h,
            t_range: (0.0, e),
            v_range: (-1.0, 1.0),
        };
        Controller::new(c, l)
    }

    #[test]
    fn zoom_anchor_100_steps() {
        let p = plot(1_000, 500);
        let c = Camera2d {
            t_left_rel_ms: 0.0,
            ms_per_px: 10.0,
            v_bottom: 0.0,
            v_per_px: 0.1,
        };
        let l = Limits {
            min_ms_per_px: 1e-6,
            max_ms_per_px: 1e9,
            min_v_per_px: 1e-9,
            max_v_per_px: 1e9,
            t_range: (-1e12, 1e12),
            v_range: (-1e12, 1e12),
        };
        let mut ctl = Controller::new(c, l);
        let mut rng = SplitMix64::new(2);
        for i in 0..100 {
            let x = 48.0 + (rng.next_f64() * 999.0) as f32;
            let y = 8.0 + (rng.next_f64() * 499.0) as f32;
            let dy = if rng.next_f64() < 0.5 { 300.0 } else { -300.0 };
            let mods = [0, SHIFT, CTRL][(rng.next_u64() % 3) as usize];
            let (px, py) = plot_xy(&p, 1.0, x, y);
            let before = *ctl.camera();
            let (t, v) = before.data_at(px, py);
            ctl.apply(&hdr(f64::from(i)), &wheel(x, y, dy, mods), &p, 1.0);
            let after = *ctl.camera();
            let (sx, sy) = after.screen_of(t, v);
            assert!(
                (sx - px).abs() < 1e-6 && (sy - py).abs() < 1e-6,
                "wheel {i}: ({sx}, {sy}) vs ({px}, {py})"
            );
            match mods {
                SHIFT => {
                    assert_eq!(after.ms_per_px, before.ms_per_px, "wheel {i}");
                    assert_ne!(after.v_per_px, before.v_per_px, "wheel {i}");
                }
                0 => {
                    assert_eq!(after.v_per_px, before.v_per_px, "wheel {i}");
                    assert_ne!(after.ms_per_px, before.ms_per_px, "wheel {i}");
                }
                _ => {
                    assert_ne!(after.ms_per_px, before.ms_per_px, "wheel {i}");
                    assert_ne!(after.v_per_px, before.v_per_px, "wheel {i}");
                }
            }
        }
        assert!(ctl.user_moved());
    }

    #[test]
    fn zoom_clamped_keeps_anchor() {
        let p = plot(1_000, 500);
        let mut ctl = fitted(1_000, 10.0, &p);
        let (px, py) = plot_xy(&p, 1.0, 700.0, 100.0);
        let (t, _) = ctl.camera().data_at(px, py);
        for i in 0..200 {
            ctl.apply(&hdr(f64::from(i)), &wheel(700.0, 100.0, -300.0, 0), &p, 1.0);
        }
        assert_eq!(ctl.camera().ms_per_px, 10.0 / 16.0);
        let (sx, _) = ctl.camera().screen_of(t, 0.0);
        assert!((sx - px).abs() < 1.0, "drift {}", sx - px);
    }

    /// Down at (400, 200), then `moves` moves of `dx` CSS px every 10 ms, then Up; returns the
    /// Up time.
    fn drag(ctl: &mut Controller, p: &Plot, dx: f32, moves: u32) -> f64 {
        ctl.apply(
            &hdr(0.0),
            &pointer(PointerPhase::Down, 400.0, 200.0, 1),
            p,
            1.0,
        );
        let mut x = 400.0;
        for i in 1..=moves {
            x += dx;
            ctl.apply(
                &hdr(f64::from(10 * i)),
                &pointer(PointerPhase::Move, x, 200.0, 1),
                p,
                1.0,
            );
        }
        let t = f64::from(10 * moves);
        ctl.apply(&hdr(t), &pointer(PointerPhase::Up, x, 200.0, 0), p, 1.0);
        t
    }

    #[test]
    fn inertia_settles_no_overshoot() {
        let p = plot(800, 400);
        let mut ctl = fitted(1_000, 10.0, &p);
        let up = drag(&mut ctl, &p, 10.0, 10);
        let mpp = ctl.camera().ms_per_px;
        let at_up = ctl.camera().t_left_rel_ms;
        assert_eq!(at_up, -100.0 * mpp);
        assert!(ctl.moving());
        let mut prev = at_up;
        let mut ended = None;
        for j in 0..40 {
            let t = up + 16.667 * f64::from(j);
            ctl.step(t);
            let now = ctl.camera().t_left_rel_ms;
            assert!(now <= prev, "reversed at step {j}");
            prev = now;
            if ended.is_none() && !ctl.moving() {
                ended = Some(t - up);
            }
        }
        let tau = ended.unwrap();
        assert!((250.0..=350.0).contains(&tau), "ended at τ {tau}");
        let extra = (at_up - prev) / mpp;
        assert!((100.0..=103.1).contains(&extra), "extra pan {extra} px");
    }

    #[test]
    fn inertia_stops_on_next_record() {
        let p = plot(800, 400);
        for stop in [
            pointer(PointerPhase::Down, 300.0, 200.0, 1),
            wheel(300.0, 200.0, 0.0, 0),
        ] {
            let mut ctl = fitted(1_000, 10.0, &p);
            let up = drag(&mut ctl, &p, 10.0, 10);
            for j in 1..=3 {
                ctl.step(up + 16.667 * f64::from(j));
            }
            assert!(ctl.moving());
            ctl.apply(&hdr(up + 55.0), &stop, &p, 1.0);
            assert!(!ctl.moving(), "{stop:?}");
            let before = *ctl.camera();
            ctl.step(up + 16.667 * 4.0);
            assert_eq!(*ctl.camera(), before, "{stop:?}");
        }
    }

    #[test]
    fn slow_release_no_inertia() {
        let p = plot(800, 400);
        let mut ctl = fitted(1_000, 10.0, &p);
        drag(&mut ctl, &p, 2.0, 10);
        assert!(!ctl.moving());
        assert!(ctl.user_moved());
    }

    #[test]
    fn drag_pans_device_px() {
        let p = plot(1_600, 800);
        let mut ctl = fitted(1_000, 10.0, &p);
        let c0 = *ctl.camera();
        ctl.apply(
            &hdr(0.0),
            &pointer(PointerPhase::Down, 400.0, 200.0, 1),
            &p,
            2.0,
        );
        ctl.apply(
            &hdr(10.0),
            &pointer(PointerPhase::Move, 450.0, 210.0, 1),
            &p,
            2.0,
        );
        let c = ctl.camera();
        assert_eq!(c.t_left_rel_ms, c0.t_left_rel_ms - 100.0 * c0.ms_per_px);
        assert_eq!(c.v_bottom, c0.v_bottom + 20.0 * c0.v_per_px);
    }

    #[test]
    fn camera_bounds() {
        let p = plot(800, 400);
        let mut ctl = fitted(1_000, 10.0, &p);
        let fit = *ctl.camera();
        let l = *ctl.limits();
        let span = 800.0 * fit.ms_per_px;
        let vspan = 400.0 * fit.v_per_px;
        ctl.apply(
            &hdr(0.0),
            &pointer(PointerPhase::Down, 400.0, 200.0, 1),
            &p,
            1.0,
        );
        ctl.apply(
            &hdr(1.0),
            &pointer(PointerPhase::Move, 400.0 + 1e12, 200.0 + 1e12, 1),
            &p,
            1.0,
        );
        assert_eq!(ctl.camera().t_left_rel_ms, -span);
        assert_eq!(ctl.camera().v_bottom, l.v_range.1);
        ctl.apply(
            &hdr(2.0),
            &pointer(PointerPhase::Move, 400.0 - 1e12, 200.0 - 1e12, 1),
            &p,
            1.0,
        );
        assert_eq!(ctl.camera().t_left_rel_ms, 10_000.0);
        assert_eq!(ctl.camera().v_bottom, l.v_range.0 - vspan);
        ctl.apply(
            &hdr(3.0),
            &pointer(PointerPhase::Cancel, 0.0, 0.0, 0),
            &p,
            1.0,
        );

        // A fast flick to the left end stops at the bound.
        ctl.set_camera(fit, l);
        let up = drag(&mut ctl, &p, 200.0, 3);
        assert!(ctl.moving());
        for j in 1..30 {
            ctl.step(up + 16.667 * f64::from(j));
        }
        assert_eq!(ctl.camera().t_left_rel_ms, -span);
        assert!(!ctl.moving());

        // Over empty space the anchor is the nearest data end.
        let mut c = fit;
        c.t_left_rel_ms = -span + 20.0 * fit.ms_per_px;
        ctl.set_camera(c, l);
        assert!((ctl.camera().screen_of(0.0, 0.0).0 - 780.0).abs() < 1e-6);
        ctl.apply(&hdr(400.0), &wheel(58.0, 200.0, -300.0, 0), &p, 1.0);
        assert!(ctl.camera().ms_per_px < fit.ms_per_px);
        assert!((ctl.camera().screen_of(0.0, 0.0).0 - 780.0).abs() < 1e-6);

        ctl.set_camera(fit, l);
        for i in 0..1_000 {
            let t = 500.0 + 2.0 * f64::from(i);
            ctl.apply(&hdr(t), &wheel(48.0, 8.0, 300.0, CTRL), &p, 1.0);
            ctl.apply(&hdr(t + 1.0), &wheel(848.0, 408.0, -300.0, CTRL), &p, 1.0);
            let c = *ctl.camera();
            let span = 800.0 * c.ms_per_px;
            assert!(
                c.t_left_rel_ms >= -span && c.t_left_rel_ms <= 10_000.0,
                "pair {i}: {c:?}"
            );
            let vspan = 400.0 * c.v_per_px;
            assert!(
                c.v_bottom >= l.v_range.0 - vspan && c.v_bottom <= l.v_range.1,
                "pair {i}: {c:?}"
            );
            let k0 = dash_scales::lod::XMap::new(10.0, c.t_left_rel_ms, c.ms_per_px).k0;
            assert!(k0.abs() <= 4_000, "pair {i}: k0 {k0}");
        }
    }
}
