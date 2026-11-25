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

    // At exactly the cost left it is accepted (and charged).
    let cost = schema_cost(&grid_schema(5, Some(&big)));
    let (_, _, probe) = near_budget(fr.clone(), 2, u64::MAX);
    // The probe accepted and charged the schema: what was used before it.
    let used = probe.retained().2 - cost;
    let (ev, _, d) = near_budget(fr.clone(), 2, used + cost);
    assert!(
        ev.iter().any(|e| matches!(e, Event::Grid { part: 2, .. })),
        "{ev:?}"
    );
    assert_eq!(d.retained().2, used + cost);
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

#[test]
fn meta_and_error_schemas_past_the_budget_are_refused_before_copying() {
    // The planned META of grid-empty.
    let mut fr = empty_frames();
    fr[1] = with_big_schema(&fr[1]);
    let (ev, n, _) = near_budget(fr, 1, 64 << 10);
    assert!(budget_failure(&ev), "{ev:?}");
    assert!(n < 64 << 10, "META: {n} bytes allocated");

    // A part ERROR and the stream-level ERROR.
    let er = parse(&fixture("grid-error"));
    let like = er[find_frame(&er, ERROR, 5, 0)].clone();
    for part in [5, 0] {
        let mut f = with_big_schema(&like);
        f.part = part;
        let (ev, n, mut d) = near_budget(vec![f], 0, 64 << 10);
        assert!(n < 64 << 10, "ERROR({part}): {n} bytes allocated");
        assert!(
            ev.iter().all(|e| !matches!(e, Event::Upstream { .. })),
            "{ev:?}"
        );
        if part != 0 {
            assert!(budget_failure(&ev), "{ev:?}");
        }
        assert_eq!(
            d.finish().last(),
            Some(&Event::Verdict(dash_wire::Verdict::Incomplete(
                "stream failed"
            ))),
            "ERROR({part})"
        );
    }
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
