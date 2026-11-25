//! unit:chunk-builder (plan #68 §5, T03-007).
use dash_wire::{ChunkBuilder, ChunkError, ChunkId, SeriesMeta};

fn meta(k: u64) -> SeriesMeta {
    SeriesMeta {
        key_hash: k,
        labels: vec![("pod".into(), format!("p{k}"))].into(),
    }
}

#[test]
fn rejects_unequal_lengths() {
    let mut b = ChunkBuilder::explicit(ChunkId(1));
    assert_eq!(
        b.push_series(meta(1), Some(&[1.0, 2.0]), &[1.0]),
        Err(ChunkError::Length)
    );
    let mut g = ChunkBuilder::grid(ChunkId(2), 0, 1000, 3);
    assert_eq!(
        g.push_series(meta(1), None, &[1.0, 2.0]),
        Err(ChunkError::Length)
    );
}

#[test]
fn rejects_non_increasing_and_nan_timestamps() {
    let mut b = ChunkBuilder::explicit(ChunkId(1));
    assert_eq!(
        b.push_series(meta(1), Some(&[1.0, 1.0]), &[1.0, 2.0]),
        Err(ChunkError::Order)
    );
    assert_eq!(
        b.push_series(meta(1), Some(&[2.0, 1.0]), &[1.0, 2.0]),
        Err(ChunkError::Order)
    );
    assert_eq!(
        b.push_series(meta(1), Some(&[1.0, f64::NAN]), &[1.0, 2.0]),
        Err(ChunkError::Order)
    );
}

#[test]
fn finite_range_spans_max_and_skips_nan() {
    let mut b = ChunkBuilder::explicit(ChunkId(1));
    let vs = [f64::MAX, f64::NAN, -f64::MAX, f64::INFINITY, 3.0];
    assert_eq!(
        b.push_series(meta(1), Some(&[1.0, 2.0, 3.0, 4.0, 5.0]), &vs),
        Ok(())
    );
    let c = b.finish();
    assert_eq!(c.finite, Some((-f64::MAX, f64::MAX)));
    assert_eq!(c.offsets, vec![0, 5]);
    assert_eq!(c.series.len(), 1);
}
