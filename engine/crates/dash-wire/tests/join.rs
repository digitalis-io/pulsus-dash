//! unit:join-grid (plan #68 D2 §3.2, §5; ADR-0034): the batch chunks of a streamed grid part,
//! joined into one chunk bit-equal to the batches in arrival order; a joined size that overflows
//! is refused before anything is allocated (a counting global allocator, this test binary only).
mod common;
mod support;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::path::PathBuf;
use std::sync::Arc;

use dash_wire::chunk::MAX_SAMPLES;
use dash_wire::{Chunk, ChunkId, Event, JoinError, SeriesMeta, TimeAxis, join_grid, joined_size};

thread_local! {
    /// The largest single allocation since the last reset.
    static LARGEST: Cell<usize> = const { Cell::new(0) };
}

struct Counting;

// SAFETY: every method forwards to `System` with the caller's arguments unchanged; the only
// addition is a thread-local maximum, which does not allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = LARGEST.try_with(|a| a.set(a.get().max(layout.size())));
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract for `layout`.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` was allocated by `System` (through `alloc`) with `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn largest_during<T>(f: impl FnOnce() -> T) -> (T, usize) {
    LARGEST.with(|a| a.set(0));
    let out = f();
    (out, LARGEST.with(Cell::get))
}

fn route(name: &str) -> Vec<u8> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../wire/fixtures/route")
        .join(name);
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()))
}

/// The data part's batch chunks of a route body, in arrival order.
fn batches(name: &str) -> Vec<Chunk> {
    support::run(&route(name), 1)
        .into_iter()
        .filter_map(|e| match e {
            Event::Chunk { chunk, .. } => Some(chunk),
            _ => None,
        })
        .collect()
}

fn valid(c: &Chunk, i: usize) -> bool {
    c.present
        .as_ref()
        .is_none_or(|w| w.get(i / 64).is_some_and(|w| w >> (i % 64) & 1 == 1))
}

#[test]
fn many_batches_join_into_one_chunk_bit_equal_to_the_batches() {
    let parts = batches("many.dsf");
    assert!(parts.len() > 1, "many.dsf has {} batch chunks", parts.len());
    let expect_series: Vec<SeriesMeta> = parts.iter().flat_map(|c| c.series.clone()).collect();
    let mut expect_values: Vec<u64> = Vec::new();
    let mut expect_valid: Vec<bool> = Vec::new();
    for c in &parts {
        expect_values.extend(c.values.iter().map(|v| v.to_bits()));
        expect_valid.extend((0..c.values.len()).map(|i| valid(c, i)));
    }
    let time = parts[0].time.clone();
    let TimeAxis::Grid { len, .. } = time else {
        panic!("a grid part");
    };
    let joined = join_grid(parts, ChunkId(42));
    let j = match joined {
        Ok(j) => j,
        Err(e) => panic!("join: {e}"),
    };
    assert_eq!(j.id, ChunkId(42));
    assert_eq!(j.time, time);
    assert_eq!(j.series, expect_series);
    assert_eq!(j.series.len(), 600);
    let offsets: Vec<u32> = (0..=600u32).map(|s| s * len).collect();
    assert_eq!(j.offsets, offsets);
    assert_eq!(
        j.values.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
        expect_values
    );
    assert_eq!(
        (0..j.values.len())
            .map(|i| valid(&j, i))
            .collect::<Vec<_>>(),
        expect_valid
    );
    assert_eq!(j.values.capacity(), j.values.len(), "exact-size values");
    let finite = j
        .values
        .iter()
        .filter(|v| v.is_finite())
        .fold(None, |acc: Option<(f64, f64)>, &v| {
            Some(acc.map_or((v, v), |(lo, hi)| (lo.min(v), hi.max(v))))
        });
    assert_eq!(j.finite, finite);
}

#[test]
fn gaps_validity_survives_the_join_at_any_bit_offset() {
    // Two copies of the gaps batch (one series of 61 points with absent points): the second's
    // validity starts at bit 61 of the joined words.
    let one = batches("gaps.dsf");
    assert_eq!(one.len(), 1);
    let a = one[0].clone();
    let mut b = a.clone();
    b.series = vec![SeriesMeta {
        key_hash: 7,
        labels: Arc::from(Vec::new()),
    }];
    let n = a.values.len();
    let j = match join_grid(vec![a.clone(), b], ChunkId(3)) {
        Ok(j) => j,
        Err(e) => panic!("join: {e}"),
    };
    assert_eq!(j.values.len(), 2 * n);
    for i in 0..n {
        assert_eq!(valid(&j, i), valid(&a, i), "bit {i}");
        assert_eq!(valid(&j, n + i), valid(&a, i), "bit {}", n + i);
    }
    assert!((0..n).any(|i| !valid(&a, i)), "gaps has absent points");
}

#[test]
fn one_batch_is_reused_without_a_copy() {
    let parts = batches("two-series.dsf");
    assert_eq!(parts.len(), 1);
    let ptr = parts[0].values.as_ptr();
    let bytes = parts[0].values.len() * 8;
    let (j, largest) = largest_during(|| join_grid(parts, ChunkId(9)));
    let j = match j {
        Ok(j) => j,
        Err(e) => panic!("join: {e}"),
    };
    assert_eq!(j.id, ChunkId(9));
    assert_eq!(j.values.as_ptr(), ptr, "the batch's own values");
    assert!(
        largest < bytes,
        "largest allocation {largest} of {bytes} value bytes"
    );
}

/// A chunk that claims `series` series of a `len`-point grid but holds no values (the size check
/// comes first, so nothing of the claimed size is ever touched).
fn claiming(series: usize, len: u32) -> Chunk {
    Chunk {
        id: ChunkId(1),
        time: TimeAxis::Grid {
            start_ms: 0,
            step_ms: 1000,
            len,
        },
        series: vec![
            SeriesMeta {
                key_hash: 1,
                labels: Arc::from(Vec::new()),
            };
            series
        ],
        offsets: vec![0],
        values: Vec::new(),
        present: None,
        finite: None,
    }
}

#[test]
fn an_overflowing_size_is_refused_before_any_allocation() {
    assert_eq!(joined_size(usize::MAX / 2, 3), Err(JoinError::Size));
    assert_eq!(joined_size(3, usize::MAX / 2), Err(JoinError::Size));
    assert_eq!(joined_size(2, MAX_SAMPLES / 2 + 1), Err(JoinError::Size));
    assert_eq!(joined_size(2, MAX_SAMPLES / 2), Ok(MAX_SAMPLES));
    assert_eq!(joined_size(600, 11), Ok(6600));
    // 3 chunks of 2 series × 2³² − 1 points: the product passes 2³¹ samples (and, on a 32-bit
    // target, usize). Refused with nothing allocated of the claimed size.
    let parts = vec![
        claiming(2, u32::MAX),
        claiming(2, u32::MAX),
        claiming(2, u32::MAX),
    ];
    let (r, largest) = largest_during(|| join_grid(parts, ChunkId(5)));
    assert_eq!(r.map(|c| c.id), Err(JoinError::Size));
    assert!(largest < 1 << 20, "largest allocation {largest}");
}

#[test]
fn chunks_of_other_grids_are_refused() {
    let mut parts = batches("many.dsf");
    if let Some(TimeAxis::Grid { start_ms, .. }) = parts.get_mut(1).map(|c| &mut c.time) {
        *start_ms += 1;
    }
    assert_eq!(
        join_grid(parts, ChunkId(1)).map(|c| c.id),
        Err(JoinError::Shape)
    );
    assert_eq!(
        join_grid(Vec::new(), ChunkId(1)).map(|c| c.id),
        Err(JoinError::Empty)
    );
}
