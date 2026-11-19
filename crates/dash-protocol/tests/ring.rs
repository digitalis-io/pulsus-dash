#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The SPSC input ring (T03-006).

use std::alloc::{Layout, alloc_zeroed};
use std::sync::atomic::{AtomicU32, Ordering};

use dash_protocol::input::{InputRecord, PointerPhase, RecordHeader, encode};
use dash_protocol::layout::{CB_SIZE, off};
use dash_protocol::ring::{RingFull, RingView};

/// A zeroed, 64-byte aligned control block, leaked ('static, as in the core).
fn cb() -> *mut u8 {
    let layout = Layout::from_size_align(CB_SIZE as usize, 64).unwrap();
    // SAFETY: the layout has a non-zero size.
    let p = unsafe { alloc_zeroed(layout) };
    assert!(!p.is_null());
    p
}

fn word(base: *mut u8, at: u32) -> u32 {
    // SAFETY: `at` is a 4-aligned offset inside the control block.
    unsafe { (*(base.add(at as usize) as *const AtomicU32)).load(Ordering::SeqCst) }
}

fn mv(seq: u32) -> Vec<u8> {
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
            x: seq as f32,
            y: 0.0,
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

fn vis(seq: u32) -> Vec<u8> {
    let h = RecordHeader {
        kind: 0x21,
        flags: 0,
        size: 24,
        seq,
        t_ms: 0.0,
    };
    encode(&h, &InputRecord::Visibility(3))
}

fn ring(base: *mut u8) -> RingView {
    // SAFETY: `base` is a leaked, aligned CB_SIZE block used by one producer and one consumer.
    unsafe { RingView::input(base) }
}

fn drain_seqs(r: &mut RingView) -> Vec<u32> {
    let mut seqs = Vec::new();
    r.drain(&mut |h, _| seqs.push(h.seq));
    seqs
}

#[test]
fn ring_drains_in_order() {
    let base = cb();
    let mut r = ring(base);
    for s in 0..10 {
        r.push(&mv(s)).unwrap();
    }
    assert_eq!(drain_seqs(&mut r), (0..10).collect::<Vec<_>>());
    assert_eq!(word(base, off::INPUT_HEAD), 400);
    assert_eq!(word(base, off::INPUT_TAIL), 400);
}

#[test]
fn ring_wraps_with_marker() {
    let base = cb();
    let mut r = ring(base);
    for s in 0..1637 {
        r.push(&mv(s)).unwrap();
    }
    r.push(&vis(1637)).unwrap();
    r.push(&vis(1638)).unwrap();
    assert_eq!(drain_seqs(&mut r).len(), 1639);
    assert_eq!(word(base, off::INPUT_HEAD), 65_528);
    r.push(&mv(5000)).unwrap();
    // SAFETY: inside the control block.
    let data = unsafe { std::slice::from_raw_parts(base.add(off::INPUT_DATA as usize), 65_536) };
    assert_eq!(data[65_528], 0x00, "wrap marker");
    assert_eq!(&data[..40], &mv(5000)[..], "record at offset 0");
    assert_eq!(word(base, off::INPUT_HEAD), 65_576);
    assert_eq!(drain_seqs(&mut r), vec![5000]);
    assert_eq!(word(base, off::INPUT_TAIL), 65_576);
}

#[test]
fn ring_full_and_corrupt() {
    let base = cb();
    let mut r = ring(base);
    for s in 0..1638 {
        r.push(&mv(s)).unwrap();
    }
    assert_eq!(r.push(&mv(1638)), Err(RingFull));

    let base = cb();
    let mut r = ring(base);
    r.push(&mv(0)).unwrap();
    r.push(&mv(1)).unwrap();
    let mut bad = mv(2);
    bad[2] = 13;
    r.push(&bad).unwrap();
    r.push(&mv(3)).unwrap();
    assert_eq!(drain_seqs(&mut r), vec![0, 1]);
    assert_eq!(word(base, off::INPUT_TAIL), word(base, off::INPUT_HEAD));
    assert_eq!(word(base, off::FS_RING_CORRUPT), 1);
}

#[test]
fn ring_two_threads_no_loss() {
    const N: u32 = 100_000;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let base = cb() as usize;
    let producer = std::thread::spawn(move || {
        let mut r = ring(base as *mut u8);
        for s in 0..N {
            let rec = if s % 3 == 0 { vis(s) } else { mv(s) };
            while r.push(&rec).is_err() {
                if std::time::Instant::now() > deadline {
                    return;
                }
                std::hint::spin_loop();
            }
        }
    });
    let mut r = ring(base as *mut u8);
    let mut seen = Vec::with_capacity(N as usize);
    while seen.len() < N as usize && std::time::Instant::now() < deadline {
        r.drain(&mut |h, _| seen.push(h.seq));
    }
    producer.join().unwrap();
    assert_eq!(seen, (0..N).collect::<Vec<_>>());
}
