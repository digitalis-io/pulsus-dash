//! The #23 runtime spike scene: 10 000 instanced rects in one draw call, pulsing, brightened
//! around the pointer (VIZ-001 pre-requisite). The default page; `?scene=line` shows the #24
//! line chart instead.

use dash_protocol::input::{InputRecord, RecordHeader};

use crate::InputSink;

/// Grid side: `GRID × GRID` instances.
const GRID: usize = 100;
/// Half the rect size in NDC before the pulse (grid pitch is 1.9 / 99 ≈ 0.019).
const HALF_SIZE: f32 = 0.0075;

/// Instance columns of the spike scene.
#[derive(Clone, Debug, PartialEq)]
pub struct InstanceColumns {
    pub xy: Vec<[f32; 2]>,
    pub phase: Vec<f32>,
}

/// 100 × 100 grid in [-0.95, 0.95]², phase = xorshift64(seed) mapped to [0, τ).
pub fn instances(seed: u64) -> InstanceColumns {
    let tau = std::f32::consts::TAU;
    let mut x = seed ^ 0x9E37_79B9_7F4A_7C15;
    if x == 0 {
        x = 1;
    }
    let n = GRID * GRID;
    let mut cols = InstanceColumns {
        xy: Vec::with_capacity(n),
        phase: Vec::with_capacity(n),
    };
    let at = |i: usize| (-0.95 + 1.9 * i as f32 / (GRID - 1) as f32).clamp(-0.95, 0.95);
    for row in 0..GRID {
        for col in 0..GRID {
            cols.xy.push([at(col), at(row)]);
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let p = (x >> 40) as f32 / (1u64 << 24) as f32 * tau;
            cols.phase.push(if p < tau { p } else { 0.0 });
        }
    }
    cols
}

/// The rect pipeline's uniform block (48 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct SpikeUniforms {
    pub t_s: f32,
    pub aspect: f32,
    pub cursor: [f32; 2],
    pub half_size: f32,
    pub _pad: [f32; 3],
    pub colour: [f32; 4],
}

/// Scene state driven by input records.
#[derive(Clone, Debug, PartialEq)]
pub struct SpikeScene {
    css_w: f32,
    css_h: f32,
    cursor_css: [f32; 2],
    visible: bool,
}

impl Default for SpikeScene {
    /// A 1 × 1 CSS-pixel canvas (until the first Resize record), cursor at the top-left corner.
    fn default() -> Self {
        SpikeScene {
            css_w: 1.0,
            css_h: 1.0,
            cursor_css: [0.0, 0.0],
            visible: true,
        }
    }
}

impl SpikeScene {
    /// Applies one input record: pointer records move the cursor; Resize sets the CSS size;
    /// Visibility 2 (hidden) / 3 (visible) sets visibility. Other records are ignored.
    pub fn apply(&mut self, r: &InputRecord) {
        match *r {
            InputRecord::Pointer { x, y, .. } => self.cursor_css = [x, y],
            InputRecord::Resize { css_w, css_h, .. } if css_w > 0.0 && css_h > 0.0 => {
                self.css_w = css_w;
                self.css_h = css_h;
            }
            InputRecord::Visibility(2) => self.visible = false,
            InputRecord::Visibility(3) => self.visible = true,
            _ => {}
        }
    }

    /// Whether the page reported itself visible (last Visibility record).
    pub fn visible(&self) -> bool {
        self.visible
    }

    /// The uniforms at time `t_ms`: cursor in NDC (y up), aspect = width / height.
    pub fn uniforms(&self, t_ms: f64) -> SpikeUniforms {
        SpikeUniforms {
            t_s: (t_ms / 1000.0) as f32,
            aspect: self.css_w / self.css_h,
            cursor: [
                self.cursor_css[0] / self.css_w * 2.0 - 1.0,
                1.0 - self.cursor_css[1] / self.css_h * 2.0,
            ],
            half_size: HALF_SIZE,
            _pad: [0.0; 3],
            colour: dash_tokens::spike::MARK,
        }
    }
}

impl InputSink for SpikeScene {
    fn apply(&mut self, _h: &RecordHeader, r: &InputRecord) {
        SpikeScene::apply(self, r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dash_protocol::input::PointerPhase;

    fn moved(x: f32, y: f32) -> InputRecord {
        InputRecord::Pointer {
            phase: PointerPhase::Move,
            x,
            y,
            pointer_id: 1,
            mods: 0,
            buttons: 0,
            button: -1,
            ptype: 0,
            pressure: 0,
            width: 1,
            height: 1,
            tilt_x: 0,
            tilt_y: 0,
        }
    }

    #[test]
    fn spike_instances_deterministic() {
        let a = instances(7);
        assert_eq!(a, instances(7));
        assert_eq!(a.xy.len(), 10_000);
        assert_eq!(a.phase.len(), 10_000);
        assert!(
            a.xy.iter()
                .all(|p| p[0].abs() <= 0.95 && p[1].abs() <= 0.95)
        );
        assert!(
            a.phase
                .iter()
                .all(|p| (0.0..std::f32::consts::TAU).contains(p))
        );
        assert_ne!(a.phase, instances(8).phase);
        assert_eq!(std::mem::size_of::<SpikeUniforms>(), 48);
    }

    #[test]
    fn spike_scene_applies_input() {
        let mut s = SpikeScene::default();
        s.apply(&InputRecord::Resize {
            css_w: 600.0,
            css_h: 300.0,
            dpr: 2.0,
            device_w: 1200,
            device_h: 600,
        });
        s.apply(&moved(300.0, 150.0));
        let u = s.uniforms(0.0);
        assert_eq!(u.aspect, 2.0);
        assert_eq!(u.cursor, [0.0, 0.0]);
        s.apply(&moved(0.0, 0.0));
        assert_eq!(s.uniforms(500.0).cursor, [-1.0, 1.0]);
        assert_eq!(s.uniforms(500.0).t_s, 0.5);
    }
}
