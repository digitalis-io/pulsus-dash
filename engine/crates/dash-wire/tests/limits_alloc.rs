//! unit:dsf-limits, allocation bounds (plan #68 B3 §3.3; review r1 findings 1 and 2): a schema
//! whose accounted size is above the body budget left is refused before any of its strings is
//! copied, whether the part would keep it (SCHEMA) or not (the schema of a META or ERROR
//! stream); and schema diagnostics quote at most a bounded snippet of untrusted input. A
//! counting global allocator (this test binary only) measures the allocations of each `frame`.
mod common;
mod limits;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use common::*;
use dash_wire::limits::BODY_BUDGET;
use dash_wire::{BodyDecoder, DsfError, Event, Frame, Limits, PartError};
use limits::*;

thread_local! {
    static ALLOCATED: Cell<usize> = const { Cell::new(0) };
}

struct Counting;

// SAFETY: every method forwards to `System` with the caller's arguments unchanged; the only
// addition is a thread-local counter, which does not allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = ALLOCATED.try_with(|a| a.set(a.get() + layout.size()));
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

/// Decodes `f`, returning its events and the bytes the call allocated.
fn counted(d: &mut BodyDecoder, f: Frame) -> (Vec<Event>, usize) {
    ALLOCATED.with(|a| a.set(0));
    let ev = d.frame(f);
    (ev, ALLOCATED.with(Cell::get))
}

fn budget_failure(ev: &[Event]) -> bool {
    ev.iter().any(|e| {
        matches!(
            e,
            Event::Failed {
                reason: PartError::Stream(DsfError::Limit("body budget")),
                ..
            }
        )
    })
}

/// 1 MiB of metadata: far above the small budgets below (and the 64 KiB allocation bound of
/// a refused frame), far below `MAX_PAYLOAD`.
const BIG: usize = 1 << 20;

/// A body whose frame `at` carries `msg0` as its first message, decoded up to that frame with
/// `budget`; returns that frame's events and allocations, and the decoder.
fn near_budget(frames: Vec<F>, at: usize, budget: u64) -> (Vec<Event>, usize, BodyDecoder) {
    let fs = frames_of(&encode(&frames));
    let lim = Limits {
        body_budget: budget,
        ..Limits::default()
    };
    let mut d = BodyDecoder::with_limits(1, lim);
    for f in fs[..at].iter().cloned() {
        let ev = d.frame(f);
        assert!(
            !ev.iter().any(|e| matches!(e, Event::Failed { .. })),
            "{ev:?}"
        );
    }
    let (ev, n) = counted(&mut d, fs[at].clone());
    (ev, n, d)
}

#[test]
fn retained_schema_past_the_budget_is_refused_before_copying() {
    let e = empty_frames();
    // The data SCHEMA of grid-empty with 1 MiB of dash.planned: its cost is above the budget.
    let big = "p".repeat(BIG);
    let mut fr = e.clone();
    fr[2] = F::new(SCHEMA, 0, 2, 0, vec![Piece::M(grid_schema(5, Some(&big)))]);
    let (ev, n, d) = near_budget(fr.clone(), 2, 64 << 10);
    assert!(budget_failure(&ev), "{ev:?}");
    assert!(n < 64 << 10, "{n} bytes allocated");
    assert!(d.retained().2 <= 64 << 10);

    // At exactly the cost left it is accepted (and debited once).
    let cost = schema_cost(&grid_schema(5, Some(&big)));
    let (_, _, probe) = near_budget(fr.clone(), 2, u64::MAX);
    // The probe accepted and debited the schema: what was used before it.
    let used = probe.retained().2 - cost;
    let (ev, n, d) = near_budget(fr.clone(), 2, used + cost);
    let Some(Event::Grid { info, .. }) =
        ev.iter().find(|e| matches!(e, Event::Grid { part: 2, .. }))
    else {
        panic!("no grid: {ev:?}")
    };
    // Holding the decoder and the grid event: one copy of the schema's strings, no second
    // copy of dash.planned for the event (it shares the schema's string).
    assert_eq!(info.planned.as_deref().map(str::len), Some(BIG));
    assert_eq!(d.retained().2, used + cost);
    assert!(
        (n as u64) <= cost + (64 << 10),
        "{n} bytes allocated for a schema of cost {cost} (budget {})",
        used + cost
    );
    drop((ev, d));
    let (ev, _, _) = near_budget(fr, 2, used + cost - 1);
    assert!(budget_failure(&ev), "{ev:?}");
}

/// `f`'s stream schema with an extra 1 MiB metadata value.
fn with_big_schema(f: &F) -> F {
    let mut g = f.clone();
    let big = "x".repeat(BIG);
    let m = g.msg(0).edit(|t| set_kv(t, "dash.x", &big));
    *g.msg_mut(0) = m;
    g
}

/// One frame of `f` (encoded alone at body offset 0).
fn one_frame(f: &F) -> Frame {
    frames_of(&encode(std::slice::from_ref(f)))
        .pop()
        .unwrap_or_else(|| panic!("no frame"))
}

#[test]
fn meta_and_error_schemas_are_checked_without_copying() {
    // The planned META of grid-empty with a 1 MiB embedded schema: the part fails, nothing of
    // the schema is copied and nothing is debited for it.
    let mut fr = empty_frames();
    fr[1] = with_big_schema(&fr[1]);
    let (ev, n, d) = near_budget(fr, 1, u64::MAX);
    assert!(
        matches!(failure_of(&ev, 2), Some(PartError::Schema(_))),
        "{ev:?}"
    );
    assert!(n < 64 << 10, "META: {n} bytes allocated");
    let (_, _, before) = near_budget(empty_frames(), 1, u64::MAX);
    assert!(
        d.retained().2 <= before.retained().2,
        "the embedded schema was debited"
    );

    // A part ERROR and the stream-level ERROR.
    let er = parse(&fixture("grid-error"));
    let like = er[find_frame(&er, ERROR, 5, 0)].clone();
    for part in [5, 0] {
        let mut f = with_big_schema(&like);
        f.part = part;
        let (ev, n, mut d) = near_budget(vec![f], 0, u64::MAX);
        assert!(n < 64 << 10, "ERROR({part}): {n} bytes allocated");
        assert!(
            ev.iter().all(|e| !matches!(e, Event::Upstream { .. })),
            "{ev:?}"
        );
        if part != 0 {
            assert!(
                matches!(failure_of(&ev, 5), Some(PartError::Schema(_))),
                "{ev:?}"
            );
        } else {
            assert_eq!(
                d.finish().last(),
                Some(&Event::Verdict(dash_wire::Verdict::Incomplete(
                    "stream failed"
                )))
            );
        }
    }
}

fn failure_of(ev: &[Event], part: u32) -> Option<PartError> {
    ev.iter().find_map(|e| match e {
        Event::Failed { part: p, reason } if *p == part => Some(reason.clone()),
        _ => None,
    })
}

#[test]
fn repeated_rejected_schemas_exhaust_the_budget() {
    // Distinct parts, each a labels SCHEMA with a 1 MiB unknown key: each is rejected, its
    // debit stays, and the body budget ends the stream; the copies total at most the budget.
    let big = "k".repeat(BIG);
    let f = one_frame(&F::new(
        SCHEMA,
        0,
        1,
        0,
        vec![Piece::M(labels_schema("labels/1", &[(&big, "v")]))],
    ));
    let mut d = BodyDecoder::new(1);
    let (mut total, mut parts) = (0usize, 0u32);
    for p in 1..=200u32 {
        let g = retarget(&f, p, 0);
        let (ev, n) = counted(&mut d, g);
        total += n;
        parts = p;
        if budget_failure(&ev) {
            break;
        }
        assert!(
            matches!(failure_of(&ev, p), Some(PartError::Schema(_))),
            "part {p}: {ev:?}"
        );
    }
    let per = BIG as u64 + 256;
    assert!(
        parts < 200 && u64::from(parts) <= BODY_BUDGET / per + 1,
        "{parts} parts"
    );
    assert!(
        total as u64 <= BODY_BUDGET + u64::from(parts) * (64 << 10),
        "{total} bytes allocated over {parts} parts"
    );
    assert!(d.retained().2 <= BODY_BUDGET);
}

#[test]
fn repeated_embedded_schemas_allocate_nothing_proportional() {
    // 1 025 distinct parts alternating a planned META and an ERROR, each with a 1 MiB embedded
    // schema (1 GiB in all): none is copied; the stream ends at distinct_parts.
    let mut meta = empty_frames()[1].clone();
    meta = with_big_schema(&meta);
    let er = parse(&fixture("grid-error"));
    let error = with_big_schema(&er[find_frame(&er, ERROR, 5, 0)]);
    let frames = [one_frame(&meta), one_frame(&error)];
    let mut d = BodyDecoder::new(1);
    let mut total = 0usize;
    let mut ended = false;
    for p in 1..=1025u32 {
        let g = retarget(&frames[p as usize % 2], p, 0);
        let (ev, n) = counted(&mut d, g);
        total += n;
        if p == 1025 {
            ended = ev.is_empty()
                && d.finish().last()
                    == Some(&Event::Verdict(dash_wire::Verdict::Incomplete(
                        "stream failed",
                    )));
        } else {
            assert!(
                matches!(failure_of(&ev, p), Some(PartError::Schema(_))),
                "part {p}: {ev:?}"
            );
        }
    }
    assert!(ended, "no distinct_parts limit");
    // Per frame: the verifier's extents, the events and the part entry (≪ the 1 MiB schema).
    assert!(total <= 1025 * (16 << 10), "{total} bytes allocated");
}

/// A labels SCHEMA message with its `dash.schema` value replaced by `id` and extra metadata.
fn labels_schema(id: &str, extra: &[(&str, &str)]) -> Msg {
    let m = empty_frames()[0].msg(0).clone();
    m.edit(|t| {
        set_kv(t, "dash.schema", id);
        for (k, v) in extra {
            set_kv(t, k, v);
        }
    })
}

#[test]
fn schema_diagnostics_stay_bounded() {
    let esc = "\u{1}\"\\".repeat(20_000);
    let cases: Vec<Msg> = vec![
        labels_schema(&format!("{esc}/1"), &[]),
        labels_schema(&format!("labels/{esc}"), &[]),
        labels_schema(&esc, &[]),
        labels_schema("coverage/1", &[]),
        labels_schema("labels/1", &[(&esc, "v")]),
    ];
    let mut total = 0usize;
    let parts = 200u32;
    let mut d = BodyDecoder::new(1);
    for p in 1..=parts {
        let m = cases[(p as usize) % cases.len()].clone();
        let meta = m.meta.len();
        let f = frames_of(&encode(&[F::new(SCHEMA, 0, p, 0, vec![Piece::M(m)])]))
            .pop()
            .unwrap_or_else(|| panic!("no frame"));
        let (ev, n) = counted(&mut d, f);
        let reason = ev
            .iter()
            .find_map(|e| match e {
                Event::Failed {
                    reason: PartError::Schema(s),
                    ..
                } => Some(s.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("part {p}: {ev:?}"));
        assert!(
            reason.len() <= 200,
            "part {p}: {} bytes of diagnostic",
            reason.len()
        );
        total += reason.len();
        // The schema's own strings are copied once (≤ its metadata); nothing proportional to
        // the input is added for the diagnostic.
        assert!(
            n <= meta + (16 << 10),
            "part {p}: {n} bytes for {meta} bytes of metadata"
        );
    }
    assert!(total <= parts as usize * 200);
}

#[test]
fn a_near_budget_stream_error_is_held_once() {
    // A stream-level ERROR of 1 MiB − 1 KiB at exactly the budget left: accepted, and its
    // strings allocated once although the decoder keeps it and the event carries it.
    let er = parse(&fixture("grid-error"));
    let msg = vec![b'm'; (1 << 20) - 1024];
    let mut f = stream_frame(
        &er[find_frame(&er, ERROR, 5, 0)],
        LAST,
        0,
        error_batch(&msg, None),
    );
    f.part = 0;
    let cost = 256 + msg.len() as u64;
    let (ev, n, d) = near_budget(vec![f.clone()], 0, cost);
    let Some(Event::Upstream { error, .. }) = ev.first() else {
        panic!("{ev:?}")
    };
    let kept = d
        .stream_error()
        .unwrap_or_else(|| panic!("no stream error"));
    assert!(std::sync::Arc::ptr_eq(&error.message, &kept.message));
    assert_eq!(d.retained().2, cost);
    // One copy of the message plus the frame's bounded scratch (< 64 KiB, released).
    assert!(
        (n as u64) <= cost + (64 << 10) && n < 2 * msg.len(),
        "{n} bytes allocated for an error of cost {cost}"
    );
    // One byte less: refused with the body budget, nothing of the message copied.
    let (_, n, mut d) = near_budget(vec![f], 0, cost - 1);
    assert!(n < 64 << 10, "{n}");
    assert_eq!(
        d.finish().last(),
        Some(&Event::Verdict(dash_wire::Verdict::Incomplete(
            "stream failed"
        )))
    );
}
