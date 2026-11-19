//! The line loader (plan #24 §3.7, §4.1): synthesises the layer with `pulsus-synth`, encodes it as
//! `metric_matrix.grid/1`, copies each message into a slab, decodes it zero-copy and publishes
//! one chunk per series. Runs on data-0 (MT) or in `render_start` (ST).

use dash_wire::WireError;

use crate::flags::{LineFault, LineParams};
use crate::line_table::LineTable;

/// The seed of the line scene's data.
pub const LINE_SEED: u64 = 24;
/// Samples the render worker converts and uploads per frame (T04 §5.7).
pub const UPLOAD_SAMPLES_PER_FRAME: u64 = 1 << 21;

/// Loads `held` of `p.series` series into `t`; returns the series published.
pub fn run(
    _t: &LineTable,
    _p: LineParams,
    _held: u32,
    _producer: &'static str,
    _fault: Option<LineFault>,
) -> Result<u32, WireError> {
    Ok(0)
}

/// Series to upload this frame: `min(published − uploaded, max(1, 2²¹ / n))`.
pub fn uploads_this_frame(_published: u32, _uploaded: u32, _n: u32) -> u32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use dash_scales::lod::prepare;
    use pulsus_synth::line::{custom, series};

    #[test]
    fn line_load_small() {
        let p = LineParams {
            series: 20,
            points: 10_000,
        };
        let t = LineTable::new();
        assert_eq!(run(&t, p, 20, "test", None), Ok(20));
        assert_eq!(t.published(), 20);
        let layer = t.layer().unwrap();
        assert_eq!(
            (layer.requested, layer.held, layer.producer),
            (20, 20, "test")
        );
        assert_eq!(layer.grid.len, 10_000);
        assert_eq!(layer.grid.source, "synth");
        let preset = custom(20, 10_000);
        for id in 0..20 {
            let c = t.pin(id).unwrap();
            let want = series(LINE_SEED, &preset, id);
            assert_eq!(c.id, id);
            assert_eq!(c.series.values.len(), 10_000);
            for k in 0..10_000 {
                assert_eq!(c.series.is_valid(k), want.valid[k], "series {id} k {k}");
                if want.valid[k] {
                    assert_eq!(c.series.values[k].to_bits(), want.values[k].to_bits());
                }
            }
            assert_eq!(c.prepared, prepare(&want.values, &|k| want.valid[k]));
            // Zero-copy: the values view a 64-byte aligned slab holding the whole message.
            let buf = c.series.values.inner();
            let base = buf.data_ptr().as_ptr() as usize;
            assert_eq!(base % 64, 0, "series {id}");
            assert!(
                buf.capacity() > 8 * 10_000,
                "series {id}: a slab, not a copy"
            );
            let start = c.series.values.as_ptr() as usize;
            assert!(
                start >= base && start + 80_000 <= base + buf.capacity(),
                "series {id}"
            );
        }

        let t = LineTable::new();
        assert_eq!(
            run(&t, p, 20, "test", Some(LineFault::Wire)),
            Err(WireError::Ipc("truncated message".into()))
        );
        assert!(t.load_failed());
        assert_eq!(t.published(), 13);
        assert!(t.pin(13).is_none());
    }

    #[test]
    fn uploads_budget() {
        assert_eq!(uploads_this_frame(10, 3, 100_000), 7);
        assert_eq!(uploads_this_frame(10, 3, 1_000_000), 2);
        assert_eq!(uploads_this_frame(3, 3, 10), 0);
    }
}
