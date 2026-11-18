//! The #23 runtime spike scene: 10 000 instanced rects, animated, following the pointer. Stub.

use dash_protocol::input::InputRecord;

/// Instance columns of the spike scene.
#[derive(Clone, Debug, PartialEq)]
pub struct InstanceColumns {
    pub xy: Vec<[f32; 2]>,
    pub phase: Vec<f32>,
}

/// 100 × 100 grid in [-0.95, 0.95]², phase = xorshift64(seed) mapped to [0, τ).
pub fn instances(_seed: u64) -> InstanceColumns {
    InstanceColumns {
        xy: Vec::new(),
        phase: Vec::new(),
    }
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
    fn default() -> Self {
        SpikeScene {
            css_w: 0.0,
            css_h: 0.0,
            cursor_css: [0.0, 0.0],
            visible: false,
        }
    }
}

impl SpikeScene {
    pub fn apply(&mut self, _r: &InputRecord) {}

    pub fn uniforms(&self, _t_ms: f64) -> SpikeUniforms {
        let _ = (self.css_w, self.css_h, self.cursor_css, self.visible);
        bytemuck::Zeroable::zeroed()
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
