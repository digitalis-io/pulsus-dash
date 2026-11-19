//! The line loader (plan #24 §3.7, §4.1): synthesises the layer with `pulsus-synth`, encodes it as
//! `metric_matrix.grid/1`, copies each message into a slab, decodes it zero-copy and publishes
//! one chunk per series. Runs on data-0 (MT) or in `render_start` (ST).

use dash_scales::lod::prepare;
use dash_wire::{GridDecoder, GridEncoder, GridMeta, Slab, WireError, series_per_batch};
use pulsus_synth::line::{SynthSeries, custom, series};

use crate::flags::{LineFault, LineParams};
use crate::line_table::{LayerMeta, LineChunk, LineTable};

/// The seed of the line scene's data.
pub const LINE_SEED: u64 = 24;
/// Samples the render worker converts and uploads per frame (T04 §5.7).
pub const UPLOAD_SAMPLES_PER_FRAME: u64 = 1 << 21;

/// Loads `held` of `p.series` series into `t`; returns the series published. `Wire` truncates
/// the second batch message by 8 bytes. Any error marks the table load-failed (published
/// series stay) and is returned.
pub fn run(
    t: &LineTable,
    p: LineParams,
    held: u32,
    producer: &'static str,
    fault: Option<LineFault>,
) -> Result<u32, WireError> {
    let r = load(t, p, held, producer, fault);
    if r.is_err() {
        t.set_load_failed();
    }
    r
}

fn load(
    t: &LineTable,
    p: LineParams,
    held: u32,
    producer: &'static str,
    fault: Option<LineFault>,
) -> Result<u32, WireError> {
    let preset = custom(p.series, p.points);
    let grid = GridMeta {
        start_ms: preset.start_ms,
        step_ms: preset.step_ms,
        len: p.points,
        result: "metric".into(),
        source: "synth".into(),
        unit: String::new(),
    };
    t.publish_layer(LayerMeta {
        grid: grid.clone(),
        requested: p.series,
        held,
        producer,
    });
    let (mut enc, schema) = GridEncoder::new(&grid)?;
    let dec = GridDecoder::new(&Slab::copy_from(&schema)?)?;
    let per = series_per_batch(p.points);
    let mut first = 0u32;
    let mut batch_no = 0u32;
    while first < held {
        let ids = first..(first + per).min(held);
        let rows: Vec<_> = ids
            .clone()
            .map(|id| match fault {
                Some(LineFault::Ramps) => ramp(id, p.points),
                _ => series(LINE_SEED, &preset, id),
            })
            .collect();
        let refs: Vec<(&[f64], &[bool])> =
            rows.iter().map(|s| (&s.values[..], &s.valid[..])).collect();
        let mut msg = enc.batch(first, &refs)?;
        if fault == Some(LineFault::Wire) && batch_no == 1 {
            msg.truncate(msg.len().saturating_sub(8));
        }
        drop(rows);
        let slab = Slab::copy_from(&msg)?;
        drop(msg);
        for s in dec.decode(&slab)? {
            let prepared = prepare(&s.values, &|k| s.is_valid(k));
            t.publish_chunk(LineChunk {
                id: s.series_id,
                series: s,
                prepared,
            })
            .map_err(|_| WireError::Schema("series_id"))?;
        }
        first = ids.end;
        batch_no += 1;
    }
    Ok(t.published())
}

/// `fault=line-ramps`: series `id` is the all-valid ramp `a + (b − a)·k/(n − 1)` with
/// `(a, b)` = (0, 100) for 0, (300, 400) for 670, (200, 250) for 671 and (150, 150) otherwise, so
/// the e2e test can tell drawn values from zeroed ones.
fn ramp(id: u32, n: u32) -> SynthSeries {
    let (a, b) = match id {
        0 => (0.0, 100.0),
        670 => (300.0, 400.0),
        671 => (200.0, 250.0),
        _ => (150.0, 150.0),
    };
    let last = f64::from(n.saturating_sub(1).max(1));
    SynthSeries {
        values: (0..n).map(|k| a + (b - a) * f64::from(k) / last).collect(),
        valid: vec![true; n as usize],
        spikes: 0,
    }
}

/// Series to upload this frame: `min(published − uploaded, max(1, 2²¹ / n))`.
pub fn uploads_this_frame(published: u32, uploaded: u32, n: u32) -> u32 {
    let budget = (UPLOAD_SAMPLES_PER_FRAME / u64::from(n.max(1))).max(1);
    let budget = u32::try_from(budget).unwrap_or(u32::MAX);
    published.saturating_sub(uploaded).min(budget)
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
    fn line_load_ramps() {
        let p = LineParams {
            series: 672,
            points: 11,
        };
        let t = LineTable::new();
        assert_eq!(run(&t, p, 672, "test", Some(LineFault::Ramps)), Ok(672));
        let ramp = |id: u32| -> Vec<f64> {
            let c = t.pin(id).unwrap();
            assert!((0..11).all(|k| c.series.is_valid(k)), "series {id}");
            c.series.values.iter().copied().collect()
        };
        let lin = |a: f64, b: f64| -> Vec<f64> {
            (0..11).map(|k| a + (b - a) * f64::from(k) / 10.0).collect()
        };
        assert_eq!(ramp(0), lin(0.0, 100.0));
        assert_eq!(ramp(670), lin(300.0, 400.0));
        assert_eq!(ramp(671), lin(200.0, 250.0));
        assert_eq!(ramp(5), lin(150.0, 150.0));
        assert_eq!(t.pin(0).unwrap().prepared.v_ref, 50.0);
    }

    #[test]
    fn uploads_budget() {
        assert_eq!(uploads_this_frame(10, 3, 100_000), 7);
        assert_eq!(uploads_this_frame(10, 3, 1_000_000), 2);
        assert_eq!(uploads_this_frame(3, 3, 10), 0);
    }
}
