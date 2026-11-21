//! unit:epoch-adjacency (plan #68 §5, T02-014, PRF-016): samples 1 ms apart at an epoch-scale
//! timestamp land in different columns and their instances are 10 CSS px apart.
mod common;

use common::*;
use dash_scales::column_of;

#[test]
fn adjacent_milliseconds_are_ten_columns_apart() {
    let t = 1_795_089_600_000.0;
    assert_eq!(column_of(t, t, t + 100.0, 1000), 0);
    assert_eq!(column_of(t + 1.0, t, t + 100.0, 1000), 10);
    let chunk = explicit(&[(vec![t, t + 1.0], vec![1.0, 2.0])]);
    let enc = encoding_for(&chunk);
    let p = prepare(&chunk, &enc, t, t + 100.0, 1000);
    let d = run(&chunk, &p);
    let seg: Vec<_> = d.instances.iter().filter(|i| kind(i) == KIND_SEGMENT).collect();
    assert_eq!(seg.len(), 1, "{:?}", d.instances);
    let x_b = column(seg[0]);
    let x_a = x_b - dx(seg[0]);
    assert_eq!((x_a, x_b), (0, 10));
}
