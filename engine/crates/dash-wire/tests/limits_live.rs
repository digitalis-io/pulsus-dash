//! unit:dsf-limits, live memory over a whole body (plan #68 B3 §3.3; review r3 finding 3): a
//! global allocator tracking live and peak bytes (this test binary only) measures the decoding
//! interval of a body with large schemas, many label sets, coverage lists of thousands of empty
//! strings and a near-1 MiB stream-level ERROR, while the decoder and every emitted event are
//! held. The documented bound (docs/client/engine.md, "Limits and budgets"):
//!
//! - retained (decoder + events' heap) ≤ body budget used + value budget used;
//! - at every point of a frame, live ≤ body budget used + value budget used + that frame's
//!   scratch, released before the next frame: at most `SCRATCH_PER_PAYLOAD` × its payload
//!   length + `SCRATCH_FIXED` (column descriptors, the flatbuffer verifier's extents, a labels
//!   batch's series slice under construction and one series' label vector, a list's end
//!   offsets, the returned event vector). The labels part's batch list, its old copy included
//!   while it grows, is inside the per-series charge.
mod common;
mod limits;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use common::*;
use dash_wire::{BodyDecoder, Event, Frame, Limits, Verdict};
use limits::*;

thread_local! {
    static LIVE: Cell<isize> = const { Cell::new(0) };
    static PEAK: Cell<isize> = const { Cell::new(0) };
}

struct Live;

// SAFETY: every method forwards to `System` with the caller's arguments unchanged; the only
// addition is two thread-local counters, which do not allocate.
unsafe impl GlobalAlloc for Live {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = LIVE.try_with(|l| {
            let v = l.get() + layout.size() as isize;
            l.set(v);
            let _ = PEAK.try_with(|p| p.set(p.get().max(v)));
        });
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract for `layout`.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _ = LIVE.try_with(|l| l.set(l.get() - layout.size() as isize));
        // SAFETY: `ptr` was allocated by `System` (through `alloc`) with `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Live = Live;

fn live() -> isize {
    LIVE.with(Cell::get)
}

/// The scratch bound of one frame (released before the next frame).
const SCRATCH_PER_PAYLOAD: usize = 4;
const SCRATCH_FIXED: usize = 64 << 10;

/// A body exercising every retained kind: a labels part of 20 000 series (two labels each, and
/// 1 000 without labels), 100 data parts each with a 128 KiB `dash.planned`, planned and final
/// coverages of 4 000 empty warnings each, and one batch of 64 series; then a stream-level
/// ERROR with a 1 MiB − 1 KiB message.
fn body() -> Vec<u8> {
    let e = empty_frames();
    let mut out = Vec::new();
    append(&mut out, &e[0]);
    let vals: Vec<String> = (0..21_000).map(|i| format!("v{i:08}")).collect();
    for b in 0..21u32 {
        let mut rows: Vec<LabelRow<'_>> = Vec::new();
        for i in b * 1000..(b + 1) * 1000 {
            if i >= 20_000 {
                rows.push((i, u64::from(i), None, None));
            } else {
                rows.push((
                    i,
                    u64::from(i),
                    Some(&b"a"[..]),
                    Some(vals[i as usize].as_bytes()),
                ));
                rows.push((i, u64::from(i), Some(&b"b"[..]), Some(&b"x"[..])));
            }
        }
        let flags = if b == 20 { LAST } else { 0 };
        append(
            &mut out,
            &F::new(BATCH, flags, 1, 0, vec![Piece::M(labels_msg(&rows, false))]),
        );
    }
    let empties: Vec<&[u8]> = vec![b""; 4000];
    let planned = stream_frame(
        &e[1],
        0,
        2,
        coverage_batch(0, None, [&[], &empties, &[], &[]]),
    );
    let fin = stream_frame(
        &e[4],
        LAST,
        2,
        coverage_batch(2, Some(b"limit"), [&[], &empties, &[], &[]]),
    );
    let pad = "p".repeat(128 << 10);
    let schema = F::new(SCHEMA, 0, 2, 0, vec![Piece::M(grid_schema(5, Some(&pad)))]);
    let grid: Vec<(u32, Vec<(bool, u64)>)> = (0..64u32)
        .map(|i| (i * 300, vec![(true, 1f64.to_bits()); 5]))
        .collect();
    let batch = F::new(BATCH, 0, 2, 0, vec![Piece::M(grid_msg(&grid))]);
    for p in 2..102u32 {
        for f in [&planned, &schema, &batch, &fin] {
            let mut g = f.clone();
            g.part = p;
            append(&mut out, &g);
        }
    }
    let er = parse(&fixture("grid-error"));
    let mut err = stream_frame(
        &er[find_frame(&er, ERROR, 5, 0)],
        LAST,
        0,
        error_batch(&vec![b'm'; (1 << 20) - 1024], None),
    );
    err.part = 0;
    append(&mut out, &err);
    append(&mut out, &e[5]);
    out
}

#[test]
fn decoder_and_held_events_stay_within_the_budget() {
    let body = body();
    let frames: Vec<Frame> = frames_of(&body);
    // A dry run sizes the event vector, so that it does not grow during the measured run.
    let mut dry = BodyDecoder::new(1);
    let n_events: usize = frames
        .iter()
        .map(|f| dry.frame(f.clone()).len())
        .sum::<usize>()
        + 1;
    drop(dry);

    let lim = Limits::default();
    let mut held: Vec<Event> = Vec::with_capacity(n_events);
    let base = live();
    PEAK.with(|p| p.set(base));
    let mut d = BodyDecoder::with_limits(1, lim);
    let mut worst_scratch = 0isize;
    let mut worst_frame = 0usize;
    let mut values = 0u64;
    for (i, f) in frames.iter().enumerate() {
        let before = live();
        PEAK.with(|p| p.set(before));
        let payload = f.payload.len();
        let ev = d.frame(f.clone());
        for e in &ev {
            if let Event::Chunk { chunk, .. } = e {
                values +=
                    8 * chunk.values.len() as u64 + 8 * chunk.values.len().div_ceil(64) as u64;
            }
        }
        held.extend(ev);
        let after = live();
        let scratch = PEAK.with(Cell::get) - before.max(after);
        // The one bound: live ≤ body budget used + value budget used + this frame's scratch.
        let peak = PEAK.with(Cell::get) - base;
        let bound = (d.retained().2 + values) as isize
            + (SCRATCH_PER_PAYLOAD * payload + SCRATCH_FIXED) as isize;
        assert!(
            peak <= bound,
            "frame {i}: peak {peak} > {bound} (payload {payload})"
        );
        if scratch > worst_scratch {
            worst_scratch = scratch;
            worst_frame = i;
        }
    }
    let retained = live() - base;
    let used = d.retained().2;
    assert!(held.len() <= n_events);
    assert!(d.stream_error().is_some());
    assert!(
        retained as u64 <= used + values,
        "retained {retained} > body budget used {used} + values {values}"
    );
    assert!(used <= lim.body_budget);
    eprintln!(
        "retained {retained}, body used {used}, values {values}, worst scratch {worst_scratch} at frame {worst_frame}"
    );
    // The stream error's strings are held once: the decoder's copy and the event share them.
    let held_error = held.iter().find_map(|e| match e {
        Event::Upstream { part: 0, error } => Some(error.clone()),
        _ => None,
    });
    let (Some(h), Some(s)) = (held_error, d.stream_error()) else {
        panic!("no stream error")
    };
    assert!(std::sync::Arc::ptr_eq(&h.message, &s.message));
    let fin = d.finish();
    assert_eq!(
        fin.last(),
        Some(&Event::Verdict(Verdict::Incomplete("stream error")))
    );
}

/// Retained bytes of `frames` decoded with every event held, and the body budget used.
fn retained_of(frames: &[Frame]) -> (isize, u64) {
    let mut held: Vec<Event> = Vec::with_capacity(4 * frames.len() + 8);
    let base = live();
    let mut d = BodyDecoder::new(1);
    for f in frames {
        let before = live();
        PEAK.with(|p| p.set(before));
        let ev = d.frame(f.clone());
        assert!(ev.len() <= 4, "{ev:?}");
        held.extend(ev);
        // The one bound: live ≤ body budget used + this frame's scratch, at every point.
        let peak = PEAK.with(Cell::get) - base;
        let scratch = (SCRATCH_PER_PAYLOAD * f.payload.len() + SCRATCH_FIXED) as isize;
        let bound = d.retained().2 as isize + scratch;
        assert!(peak <= bound, "peak {peak} > {bound}");
    }
    (live() - base, d.retained().2)
}

#[test]
fn label_sets_and_lists_fit_their_charges() {
    let e = empty_frames();
    // 200 000 series without labels (96 B each) and 50 000 with one empty label (96 + 48 B).
    let mut fr = vec![e[0].clone()];
    for b in 0..5u32 {
        let rows: Vec<LabelRow<'_>> = (b * 50_000..(b + 1) * 50_000)
            .map(|i| {
                if b < 4 {
                    (i, 0, None, None)
                } else {
                    (i, 0, Some(&b""[..]), Some(&b""[..]))
                }
            })
            .collect();
        fr.push(F::new(
            BATCH,
            if b == 4 { LAST } else { 0 },
            1,
            0,
            vec![Piece::M(labels_msg(&rows, false))],
        ));
    }
    // 300 data parts whose final coverages (held; the planned one is not emitted) hold
    // 4 096 empty strings each.
    let empties: Vec<&[u8]> = vec![b""; 4096];
    for p in 2..302u32 {
        let mut planned = stream_frame(&e[1], 0, p, coverage_batch(0, None, [&[], &[], &[], &[]]));
        planned.part = p;
        let mut schema = e[2].clone();
        schema.part = p;
        let mut fin = stream_frame(
            &e[4],
            LAST,
            p,
            coverage_batch(2, None, [&[], &[], &empties, &[]]),
        );
        fin.part = p;
        fr.extend([planned, schema, fin]);
    }
    // Measured separately, so that neither kind's slack covers the other's.
    let split = 6;
    for (name, part) in [
        ("labels", fr[..split].to_vec()),
        ("lists", [&fr[..split], &fr[split..]].concat()),
    ] {
        let frames = frames_of(&encode(&part));
        let (base_retained, base_used) = if name == "lists" {
            retained_of(&frames[..split])
        } else {
            (0, 0)
        };
        let (retained, used) = retained_of(&frames);
        let (retained, used) = (retained - base_retained, used - base_used);
        eprintln!("{name}: retained {retained}, body used {used}");
        assert!(
            retained as u64 <= used,
            "{name}: retained {retained} > body budget used {used}"
        );
    }
}

#[test]
fn one_series_labels_batches_fit_their_charges() {
    // 20 000 labels batches of one labelled series each (the worst slack of the batch list).
    let e = empty_frames();
    let mut fr = vec![e[0].clone()];
    for i in 0..20_000u32 {
        let flags = if i == 19_999 { LAST } else { 0 };
        let m = labels_msg(&[(i, 0, Some(&b""[..]), Some(&b""[..]))], false);
        fr.push(F::new(BATCH, flags, 1, 0, vec![Piece::M(m)]));
    }
    let frames = frames_of(&encode(&fr));
    let (base, base_used) = retained_of(&frames[..1]);
    let (retained, used) = retained_of(&frames);
    let (retained, used) = (retained - base, used - base_used);
    eprintln!("one-series batches: retained {retained}, body used {used}");
    assert!(
        retained as u64 <= used,
        "retained {retained} > body budget used {used}"
    );
}
