//! Frame-start input (T03-019) and ST input batches (T03-020, T03-022). Stub.

use dash_protocol::input::{InputRecord, RecordHeader};
use dash_protocol::ring::RingView;
use dash_scene::spike::SpikeScene;

/// Step 2 of the frame: drains the ring into the scene; returns records drained.
pub fn begin_frame(
    _ring: &mut RingView,
    _scene: &mut SpikeScene,
    _frame_no: u64,
    _log: Option<&mut Vec<(RecordHeader, InputRecord, u64)>>,
) -> u32 {
    0
}

/// ST: pushes a batch's records in order; returns records pushed.
pub fn push_batch(_ring: &mut RingView, _bytes: &[u8], _dropped: u32) -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::Control;
    use dash_protocol::input::{PointerPhase, encode};
    use dash_protocol::layout::off;
    use std::sync::atomic::Ordering::Relaxed;

    fn mv(seq: u32, x: f32, y: f32) -> Vec<u8> {
        let h = RecordHeader {
            kind: 0x02,
            flags: 0,
            size: 40,
            seq,
            t_ms: seq as f64,
        };
        encode(
            &h,
            &InputRecord::Pointer {
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
            },
        )
    }

    fn sized_scene() -> SpikeScene {
        let mut s = SpikeScene::default();
        s.apply(&InputRecord::Resize {
            css_w: 600.0,
            css_h: 300.0,
            dpr: 1.0,
            device_w: 600,
            device_h: 300,
        });
        s
    }

    #[test]
    fn frame_drains_input_before_update() {
        let cb = Control::alloc().expect("control block");
        let mut ring = cb.input_ring();
        let mut producer = cb.input_ring();
        let mut scene = sized_scene();
        let mut log = Vec::new();
        producer.push(&mv(0, 300.0, 150.0)).unwrap();
        assert_eq!(begin_frame(&mut ring, &mut scene, 1, Some(&mut log)), 1);
        assert_eq!(scene.uniforms(0.0).cursor, [0.0, 0.0]);
        producer.push(&mv(1, 0.0, 0.0)).unwrap();
        assert_eq!(scene.uniforms(0.0).cursor, [0.0, 0.0], "not before frame 2");
        assert_eq!(begin_frame(&mut ring, &mut scene, 2, Some(&mut log)), 1);
        assert_eq!(scene.uniforms(0.0).cursor, [-1.0, 1.0]);
        let frames: Vec<(u32, u64)> = log.iter().map(|(h, _, f)| (h.seq, *f)).collect();
        assert_eq!(frames, vec![(0, 1), (1, 2)]);
    }

    fn drained(ring: &mut RingView) -> Vec<u32> {
        let mut v = Vec::new();
        ring.drain(&mut |h, _| v.push(h.seq));
        v
    }

    #[test]
    fn st_push_batch() {
        let w = |cb: &Control, at: u32| cb.word(at).load(Relaxed);

        let cb = Control::alloc().expect("control block");
        let mut ring = cb.input_ring();
        let batch: Vec<u8> = (0..3).flat_map(|s| mv(s, 1.0, 1.0)).collect();
        assert_eq!(push_batch(&mut ring, &batch, 2), 3);
        assert_eq!(drained(&mut ring), vec![0, 1, 2]);
        assert_eq!(w(&cb, off::INPUT_OVERFLOW), 2);

        let cb = Control::alloc().expect("control block");
        let mut ring = cb.input_ring();
        let mut bad = mv(1, 1.0, 1.0);
        bad[2] = 13;
        let batch: Vec<u8> = [mv(0, 1.0, 1.0), bad, mv(2, 1.0, 1.0)].concat();
        assert_eq!(push_batch(&mut ring, &batch, 0), 1);
        assert_eq!(drained(&mut ring), vec![0]);
        assert_eq!(w(&cb, off::FS_RING_CORRUPT), 1);
        assert_eq!(w(&cb, off::INPUT_OVERFLOW), 0);

        let cb = Control::alloc().expect("control block");
        let mut ring = cb.input_ring();
        let batch: Vec<u8> = (0..1700).flat_map(|s| mv(s, 1.0, 1.0)).collect();
        assert_eq!(push_batch(&mut ring, &batch, 0), 1638);
        assert_eq!(w(&cb, off::INPUT_OVERFLOW), 62);
        assert_eq!(drained(&mut ring), (0..1638).collect::<Vec<_>>());
    }
}
