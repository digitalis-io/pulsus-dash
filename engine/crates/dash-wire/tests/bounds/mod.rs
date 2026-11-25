//! Shared helpers of the unit:dsf-bounds files (`dsf_bounds.rs`, `dsf_bounds_layout.rs`):
//! fixture frames, single edits of their messages, and event queries.
#![allow(dead_code)]

use crate::common::{BATCH, END, F, META, SCHEMA, Tb, encode, fixture, parse};
use crate::support::run;
use dash_wire::{Event, IpcError, PartError, Verdict};

pub fn frames(name: &str) -> Vec<F> {
    parse(&fixture(name))
}

pub fn ev(frames: &[F]) -> Vec<Event> {
    run(&encode(frames), 1)
}

pub fn ipc(e: IpcError) -> Option<PartError> {
    Some(PartError::Ipc(e))
}

pub fn order(r: Option<PartError>) -> bool {
    matches!(r, Some(PartError::Order(_)))
}

pub fn is_schema(r: &Option<PartError>) -> bool {
    matches!(r, Some(PartError::Schema(_)))
}

pub fn grids(ev: &[Event], part: u32) -> usize {
    ev.iter()
        .filter(|e| matches!(e, Event::Grid { part: p, .. } if *p == part))
        .count()
}

pub fn upstreams(ev: &[Event], part: u32) -> usize {
    ev.iter()
        .filter(|e| matches!(e, Event::Upstream { part: p, .. } if *p == part))
        .count()
}

pub fn incomplete(ev: &[Event]) -> bool {
    matches!(ev.last(), Some(Event::Verdict(Verdict::Incomplete(_))))
}

/// Edits message `m` of frame `fi`.
pub fn edit_msg(fr: &mut [F], fi: usize, m: usize, f: impl FnOnce(&mut Tb)) {
    let new = fr[fi].msg(m).edit(f);
    *fr[fi].msg_mut(m) = new;
}

/// Edits the body bytes of message `m` of frame `fi`.
pub fn edit_body(fr: &mut [F], fi: usize, m: usize, f: impl FnOnce(&mut Vec<u8>)) {
    f(&mut fr[fi].msg_mut(m).body);
}

pub fn set_bufs(fr: &mut [F], fi: usize, m: usize, f: impl FnOnce(&mut Vec<(i64, i64)>)) {
    edit_msg(fr, fi, m, |t| {
        let rb = t.t_mut(2);
        let mut b = rb.pairs(2);
        f(&mut b);
        rb.set_pairs(2, &b);
    });
}

pub fn set_nodes(fr: &mut [F], fi: usize, m: usize, f: impl FnOnce(&mut Vec<(i64, i64)>)) {
    edit_msg(fr, fi, m, |t| {
        let rb = t.t_mut(2);
        let mut n = rb.pairs(1);
        f(&mut n);
        rb.set_pairs(1, &n);
    });
}

pub fn bufs(fr: &[F], fi: usize, m: usize) -> Vec<(i64, i64)> {
    fr[fi].msg(m).tree().t(2).pairs(2)
}

/// Counter frame indices.
pub const C_SCHEMA_L: usize = 0;
pub const C_META_P: usize = 1;
pub const C_SCHEMA_D: usize = 2;
pub const C_BATCH_L: usize = 3;
pub const C_BATCH_D: usize = 4;
pub const C_BATCH_L2: usize = 5;
pub const C_BATCH_D2: usize = 6;
pub const C_META_F: usize = 7;
pub const C_END: usize = 8;

pub fn counter() -> Vec<F> {
    let fr = frames("promql-range-counter");
    let shape: Vec<(u8, u32)> = fr.iter().map(|f| (f.kind, f.part)).collect();
    assert_eq!(
        shape,
        [
            (SCHEMA, 1),
            (META, 2),
            (SCHEMA, 2),
            (BATCH, 1),
            (BATCH, 2),
            (BATCH, 1),
            (BATCH, 2),
            (META, 2),
            (END, 0)
        ]
    );
    fr
}

/// The counter with `f` inserted before frame `at`.
pub fn with_frame(at: usize, f: F) -> Vec<Event> {
    let mut fr = counter();
    fr.insert(at, f);
    ev(&fr)
}

/// grid-empty frames: SCHEMA(1), META(2, planned), SCHEMA(2), BATCH(1)|LAST, META(2)|LAST, END.
pub fn empty() -> Vec<F> {
    let fr = frames("grid-empty");
    let shape: Vec<(u8, u32)> = fr.iter().map(|f| (f.kind, f.part)).collect();
    assert_eq!(
        shape,
        [
            (SCHEMA, 1),
            (META, 2),
            (SCHEMA, 2),
            (BATCH, 1),
            (META, 2),
            (END, 0)
        ]
    );
    fr
}

/// Sets the first `label_key` offset of a labels batch to 1 (its offsets buffer is buffer 5).
pub fn bad_first_offset(fr: &mut [F], fi: usize) {
    let off = bufs(fr, fi, 0)[5].0 as usize;
    edit_body(fr, fi, 0, |b| crate::common::put_u32(b, off, 1));
}

/// Sets the first byte of the counter's first labels batch `label_value` data to 0xFF.
pub fn bad_utf8(fr: &mut [F], fi: usize) {
    let at = bufs(fr, fi, 0)[9].0 as usize;
    edit_body(fr, fi, 0, |b| b[at] = 0xFF);
}
