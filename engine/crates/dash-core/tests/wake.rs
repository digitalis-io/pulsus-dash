//! unit:input-ring, wake-up leg (plan #68 C2a1 §4.1, §4.2, §5 `wake_interleavings`; T03-004
//! revised): the producer clears the idle word after a publish and wakes only when it was set; the
//! render worker sets it and re-checks the ring before sleeping. Scripted interleavings of the two
//! sides (the producer is §4.1 restated in `common`).
mod common;

use common::{Block, Producer, Rec};
use dash_core::input::{before_sleep, drain};

#[test]
fn wake_interleavings() {
    // A: the worker is awake (idle 0) and has drained; a publish lands before it sleeps. The
    // re-check sees the record, so it ticks again without a wake-up message.
    let b = Block::default();
    let mut p = Producer::default();
    let mut out = Vec::new();
    assert_eq!(drain(&b, &mut out), Ok(()));
    assert!(out.is_empty());
    assert!(p.publish(&b, &Rec::camera(1, 1.0, 2.0), 1, 0.0));
    assert_eq!(b.idle(), 0);
    assert!(before_sleep(&b), "A: the re-check sees the record");
    assert_eq!(b.idle(), 0, "A: a tick follows, so the worker is not idle");
    assert_eq!(drain(&b, &mut out), Ok(()));
    assert_eq!(out.len(), 1, "A: the record is applied");
    assert_eq!(p.wakes, 0, "A: no wake-up message");

    // B: the worker sleeps first; the publish clears the idle word and wakes it once.
    let b = Block::default();
    let mut p = Producer::default();
    let mut out = Vec::new();
    assert!(!before_sleep(&b), "B: nothing to read");
    assert_eq!(b.idle(), 1);
    assert!(p.publish(&b, &Rec::camera(1, 1.0, 2.0), 1, 0.0));
    assert_eq!(p.wakes, 1);
    assert_eq!(b.idle(), 0);
    assert_eq!(drain(&b, &mut out), Ok(()));
    assert_eq!(out.len(), 1, "B: the record is applied after the wake-up");

    // C: three publishes in one idle period wake once.
    let b = Block::default();
    let mut p = Producer::default();
    assert!(!before_sleep(&b));
    for s in 1..=3 {
        assert!(p.publish(&b, &Rec::camera(1, 1.0, f64::from(s) + 1.0), s, 0.0));
    }
    assert_eq!(p.wakes, 1, "C: one wake-up per idle period");
    let mut out = Vec::new();
    assert_eq!(drain(&b, &mut out), Ok(()));
    assert_eq!(out.len(), 3);
    assert!(!before_sleep(&b), "C: drained, so it sleeps");
}
