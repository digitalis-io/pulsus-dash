//! The 2D camera controller (T02-021, T02-022; plan #24 §4.5): wheel zoom anchored at the
//! pointer, drag pan, flick inertia. Device px, plot-relative, y up.
//!
//! The window always overlaps the data on both axes: pans, inertia and zooms clamp
//! `t_left_rel_ms` to `[t_range.0 − span, t_range.1]` and `v_bottom` to
//! `[v_range.0 − plot.h·v_per_px, v_range.1]`. Inertia is critically damped,
//! `D(τ) = v0·(2 − (2 + ωτ)e^(−ωτ))/ω`: monotone, no overshoot; it ends when
//! `(1 + ωτ)e^(−ωτ) < 0.02` (τ ≈ 300 ms), at a bound, or on the next input record.

use std::collections::VecDeque;

use dash_protocol::input::{InputRecord, PointerPhase, RecordHeader};
use dash_scales::Plot;
use dash_tokens::spike::PLOT_INSET_CSS;

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

/// Input modifier bits (T03 §5.4).
const MOD_SHIFT: u16 = 1;
const MOD_CTRL: u16 = 2;
const MOD_META: u16 = 8;

/// `max(lo).min(hi)`: never panics, `hi` wins if the range is empty.
fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

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
    pub fn data_at(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.t_left_rel_ms + x * self.ms_per_px,
            self.v_bottom + y * self.v_per_px,
        )
    }

    /// The plot-relative device px of a data point.
    pub fn screen_of(&self, t: f64, v: f64) -> (f64, f64) {
        (
            (t - self.t_left_rel_ms) / self.ms_per_px,
            (v - self.v_bottom) / self.v_per_px,
        )
    }

    /// Scales by `fx`, `fy` (clamped to the limits), keeping the anchor at its screen position.
    /// The anchor is the data point under `(x, y)`, clamped into the data: over empty space it
    /// is the nearest data end.
    pub fn zoom_at(&mut self, x: f64, y: f64, fx: f64, fy: f64, l: &Limits) {
        let (t, v) = self.data_at(x, y);
        let t_a = clampf(t, l.t_range.0, l.t_range.1);
        let v_a = clampf(v, l.v_range.0, l.v_range.1);
        let (x_a, y_a) = self.screen_of(t_a, v_a);
        let mpp = clampf(self.ms_per_px * fx, l.min_ms_per_px, l.max_ms_per_px);
        let vpp = clampf(self.v_per_px * fy, l.min_v_per_px, l.max_v_per_px);
        if mpp != self.ms_per_px {
            self.ms_per_px = mpp;
            self.t_left_rel_ms = t_a - x_a * mpp;
        }
        if vpp != self.v_per_px {
            self.v_per_px = vpp;
            self.v_bottom = v_a - y_a * vpp;
        }
    }

    /// Pans by a pointer displacement in device px (`dy` down-positive): the data follows it.
    pub fn pan_px(&mut self, dx: f64, dy: f64) {
        self.t_left_rel_ms -= dx * self.ms_per_px;
        self.v_bottom += dy * self.v_per_px;
    }
}

/// A CSS px pointer position (canvas top-left origin) in plot-relative device px, y up. The
/// plot's top edge is `PLOT_INSET_CSS[2]` (rounded device px) below the canvas top.
pub fn plot_xy(plot: &Plot, dpr: f32, x_css: f32, y_css: f32) -> (f64, f64) {
    let dpr = f64::from(dpr);
    let top = (f64::from(PLOT_INSET_CSS[2]) * dpr).round();
    (
        f64::from(x_css) * dpr - f64::from(plot.x0),
        f64::from(plot.h) + top - f64::from(y_css) * dpr,
    )
}

/// An active drag.
#[derive(Clone, Debug, PartialEq)]
struct Drag {
    pointer_id: u32,
    last: (f32, f32),
    /// `(t_ms, x, y)` CSS px within the velocity window.
    samples: VecDeque<(f64, f32, f32)>,
}

/// Running inertia: release velocity (device px/ms), release time, displacement applied.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Inertia {
    v0: (f64, f64),
    t0: f64,
    applied: f64,
}

/// `D(τ)/v0`.
fn travel(tau: f64) -> f64 {
    let wt = OMEGA_PER_MS * tau;
    (2.0 - (2.0 + wt) * (-wt).exp()) / OMEGA_PER_MS
}

/// Drives a [`Camera2d`] from input records.
#[derive(Debug)]
pub struct Controller {
    camera: Camera2d,
    limits: Limits,
    drag: Option<Drag>,
    inertia: Option<Inertia>,
    user_moved: bool,
    /// The plot size of the last applied record (device px), for the bounds.
    plot: Option<(u32, u32)>,
}

impl Controller {
    pub fn new(c: Camera2d, l: Limits) -> Self {
        Controller {
            camera: c,
            limits: l,
            drag: None,
            inertia: None,
            user_moved: false,
            plot: None,
        }
    }

    pub fn camera(&self) -> &Camera2d {
        &self.camera
    }

    pub fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Replaces the camera and limits (a fit); does not count as a user move.
    pub fn set_camera(&mut self, c: Camera2d, l: Limits) {
        self.camera = c;
        self.limits = l;
    }

    /// Inertia is running.
    pub fn moving(&self) -> bool {
        self.inertia.is_some()
    }

    /// A pan, zoom or inertia step moved the camera since construction.
    pub fn user_moved(&self) -> bool {
        self.user_moved
    }

    /// Clamps the window to overlap the data; returns whether x, y were clamped.
    fn clamp_bounds(&mut self) -> (bool, bool) {
        let Some((w, h)) = self.plot else {
            return (false, false);
        };
        let (c, l) = (&mut self.camera, &self.limits);
        let span = f64::from(w) * c.ms_per_px;
        let vspan = f64::from(h) * c.v_per_px;
        let t = clampf(c.t_left_rel_ms, l.t_range.0 - span, l.t_range.1);
        let v = clampf(c.v_bottom, l.v_range.0 - vspan, l.v_range.1);
        let clamped = (t != c.t_left_rel_ms, v != c.v_bottom);
        c.t_left_rel_ms = t;
        c.v_bottom = v;
        clamped
    }

    /// Pans by device px within the bounds; returns whether a bound was hit.
    fn pan(&mut self, dx: f64, dy: f64) -> bool {
        let before = self.camera;
        self.camera.pan_px(dx, dy);
        let (cx, cy) = self.clamp_bounds();
        if self.camera != before {
            self.user_moved = true;
        }
        (cx && dx != 0.0) || (cy && dy != 0.0)
    }

    /// Applies one input record (plan §4.5). Every record first stops inertia (T02-022).
    pub fn apply(&mut self, h: &RecordHeader, r: &InputRecord, plot: &Plot, dpr: f32) {
        self.inertia = None;
        self.plot = Some((plot.w, plot.h));
        let d = f64::from(dpr);
        match *r {
            InputRecord::Wheel {
                x,
                y,
                dx,
                dy,
                mods,
                mode,
            } => {
                let delta = f64::from(if dy != 0.0 { dy } else { dx });
                let unit = match mode {
                    0 => 1.0,
                    1 => 16.0,
                    _ => f64::from(plot.h) / d,
                };
                let f = (delta * unit / WHEEL_PX_PER_DOUBLING).exp2();
                let (fx, fy) = if mods & (MOD_CTRL | MOD_META) != 0 {
                    (f, f)
                } else if mods & MOD_SHIFT != 0 {
                    (1.0, f)
                } else {
                    (f, 1.0)
                };
                let (ax, ay) = plot_xy(plot, dpr, x, y);
                let before = self.camera;
                let l = self.limits;
                self.camera.zoom_at(ax, ay, fx, fy, &l);
                self.clamp_bounds();
                if self.camera != before {
                    self.user_moved = true;
                }
            }
            InputRecord::Pointer {
                phase,
                x,
                y,
                pointer_id,
                buttons,
                button,
                ..
            } => match phase {
                PointerPhase::Down => {
                    let (px, py) = plot_xy(plot, dpr, x, y);
                    let inside = (0.0..f64::from(plot.w)).contains(&px)
                        && (0.0..f64::from(plot.h)).contains(&py);
                    if button == 0 && inside {
                        self.drag = Some(Drag {
                            pointer_id,
                            last: (x, y),
                            samples: VecDeque::from([(h.t_ms, x, y)]),
                        });
                    }
                }
                PointerPhase::Move => {
                    if buttons & 1 == 1 {
                        self.drag_to(h.t_ms, pointer_id, x, y, d);
                    }
                }
                PointerPhase::Up => {
                    self.drag_to(h.t_ms, pointer_id, x, y, d);
                    if let Some(drag) = self.drag.take().filter(|g| g.pointer_id == pointer_id) {
                        self.release(&drag, h.t_ms, d);
                    }
                }
                PointerPhase::Cancel => self.drag = None,
            },
            _ => {}
        }
    }

    /// Pans the drag of `pointer_id` to `(x, y)` CSS px and records the sample.
    fn drag_to(&mut self, t: f64, pointer_id: u32, x: f32, y: f32, dpr: f64) {
        let Some(drag) = self.drag.as_mut().filter(|g| g.pointer_id == pointer_id) else {
            return;
        };
        let dx = f64::from(x - drag.last.0) * dpr;
        let dy = f64::from(y - drag.last.1) * dpr;
        drag.last = (x, y);
        drag.samples.push_back((t, x, y));
        while drag
            .samples
            .front()
            .is_some_and(|s| s.0 < t - VELOCITY_WINDOW_MS)
        {
            drag.samples.pop_front();
        }
        self.pan(dx, dy);
    }

    /// Starts inertia if the release velocity over the last 50 ms exceeds the flick threshold.
    fn release(&mut self, drag: &Drag, t_up: f64, dpr: f64) {
        let first = drag
            .samples
            .iter()
            .find(|s| s.0 >= t_up - VELOCITY_WINDOW_MS);
        let (Some(a), Some(b)) = (first, drag.samples.back()) else {
            return;
        };
        let dt = b.0 - a.0;
        if dt <= 0.0 {
            return;
        }
        let v = (f64::from(b.1 - a.1) / dt, f64::from(b.2 - a.2) / dt);
        if v.0.hypot(v.1) > FLICK_MIN_PX_PER_MS {
            self.inertia = Some(Inertia {
                v0: (v.0 * dpr, v.1 * dpr),
                t0: t_up,
                applied: 0.0,
            });
        }
    }

    /// Advances inertia to main-thread time `t_main_ms`.
    pub fn step(&mut self, t_main_ms: f64) {
        let Some(mut i) = self.inertia else {
            return;
        };
        let tau = t_main_ms - i.t0;
        if tau <= 0.0 {
            return;
        }
        let d = travel(tau);
        let delta = d - i.applied;
        i.applied = d;
        let hit = self.pan(i.v0.0 * delta, i.v0.1 * delta);
        let wt = OMEGA_PER_MS * tau;
        let settled = (1.0 + wt) * (-wt).exp() < SETTLE_FRACTION;
        self.inertia = (!hit && !settled).then_some(i);
    }
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
