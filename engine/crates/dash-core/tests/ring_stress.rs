//! unit:input-ring, stress leg (plan #68 C2a1 §5 `ring_stress`; T03-006): a producer thread and
//! the decoder on another, the consumer stalling 0–2 ms between drains (seed 7), the counters
//! starting at 0xFFFF_0000: 10⁶ records arrive in order, none lost, over at least 15 wraps of the
//! ring and the 2³² rollover.
mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use common::{Block, Producer, Rec};
use dash_core::input::{Record, drain};
use dash_protocol::RING_BYTES;

const N: u32 = 1_000_000;
const START: u32 = 0xFFFF_0000;

/// mulberry32: the consumer's stalls.
fn rng(seed: u32) -> impl FnMut() -> f64 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6D2B_79F5);
        let mut t = a;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

fn record(i: u32) -> Rec {
    if i % 3 == 0 {
        Rec::Resize {
            frame: i % 7 + 1,
            css: (i as f32, 1.0),
            dpr: 1.0,
            device: (i, 1),
        }
    } else {
        Rec::camera(i % 7 + 1, f64::from(i), f64::from(i) + 1.0)
    }
}

#[test]
fn ring_stress() {
    let b = Arc::new(Block::default());
    b.start_at(START);
    let done = Arc::new(AtomicBool::new(false));
    let producer = {
        let b = Arc::clone(&b);
        let done = Arc::clone(&done);
        std::thread::spawn(move || {
            let mut p = Producer::default();
            let mut bytes: u64 = 0;
            for i in 0..N {
                let r = record(i);
                while !p.publish(&b, &r, i.wrapping_add(1), f64::from(i)) {
                    std::thread::yield_now();
                }
                bytes += u64::from(r.size());
            }
            done.store(true, Ordering::SeqCst);
            bytes
        })
    };
    let mut stall = rng(7);
    let mut out = Vec::new();
    let mut next: u32 = 0;
    let mut in_order = true;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let finished = done.load(Ordering::SeqCst);
        out.clear();
        assert_eq!(drain(&*b, &mut out), Ok(()));
        for d in &out {
            let want = record(next);
            let ok = d.seq == next.wrapping_add(1)
                && match (d.rec, want) {
                    (
                        Record::Resize {
                            frame, device_w, ..
                        },
                        Rec::Resize {
                            frame: f, device, ..
                        },
                    ) => frame == f && device_w == device.0,
                    (
                        Record::Camera { frame, view, .. },
                        Rec::Camera {
                            frame: f, view: v, ..
                        },
                    ) => frame == f && view == v,
                    _ => false,
                };
            in_order &= ok;
            next += 1;
        }
        if (finished && out.is_empty()) || Instant::now() > deadline {
            break;
        }
        let us = (stall() * 2_000.0) as u64;
        std::thread::sleep(Duration::from_micros(us));
    }
    let bytes = producer.join().unwrap_or(0);
    assert!(in_order, "records in order");
    assert_eq!(next, N, "none lost");
    let wraps = bytes / u64::from(RING_BYTES);
    assert!(wraps >= 15, "{wraps} wraps");
    assert!(u64::from(START) + bytes > 1 << 32, "the counters roll over");
    assert_eq!(b.tail(), b.head());
    assert!(b.head() < START);
}
