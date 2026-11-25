//! unit:dsf-bounds (plan #68 B2 §5 (a)–(f); T04-009, T04-010): split points, header faults,
//! frame and state rules, mutations of the B1 fixtures, arithmetic boundaries and end of input.
//! Never a panic; in two-part bodies the other part's events are unchanged.
mod common;
mod support;

use common::{
    BATCH, END, ERROR, F, FIXTURES, LAST, META, Msg, PING, PROGRESS, Piece, SCHEMA, Tb, V,
    VOLATILE, encode, find_frame, fixture, parse,
};
use dash_wire::{DsfError, Event, IpcError, MAX_PAYLOAD, PartError, Verdict};
use support::{chunks, coverages, failure, fingerprint, of_part, run, run_calls, run_dec, silent};

fn frames(name: &str) -> Vec<F> {
    parse(&fixture(name))
}

fn ev(frames: &[F]) -> Vec<Event> {
    run(&encode(frames), 1)
}

fn ipc(e: IpcError) -> Option<PartError> {
    Some(PartError::Ipc(e))
}

fn order(r: Option<PartError>) -> bool {
    matches!(r, Some(PartError::Order(_)))
}

fn is_schema(r: &Option<PartError>) -> bool {
    matches!(r, Some(PartError::Schema(_)))
}

fn grids(ev: &[Event], part: u32) -> usize {
    ev.iter()
        .filter(|e| matches!(e, Event::Grid { part: p, .. } if *p == part))
        .count()
}

fn upstreams(ev: &[Event], part: u32) -> usize {
    ev.iter()
        .filter(|e| matches!(e, Event::Upstream { part: p, .. } if *p == part))
        .count()
}

fn incomplete(ev: &[Event]) -> bool {
    matches!(ev.last(), Some(Event::Verdict(Verdict::Incomplete(_))))
}

/// Edits message `m` of frame `fi`.
fn edit_msg(fr: &mut [F], fi: usize, m: usize, f: impl FnOnce(&mut Tb)) {
    let new = fr[fi].msg(m).edit(f);
    *fr[fi].msg_mut(m) = new;
}

/// Edits the body bytes of message `m` of frame `fi`.
fn edit_body(fr: &mut [F], fi: usize, m: usize, f: impl FnOnce(&mut Vec<u8>)) {
    f(&mut fr[fi].msg_mut(m).body);
}

fn set_bufs(fr: &mut [F], fi: usize, m: usize, f: impl FnOnce(&mut Vec<(i64, i64)>)) {
    edit_msg(fr, fi, m, |t| {
        let rb = t.t_mut(2);
        let mut b = rb.pairs(2);
        f(&mut b);
        rb.set_pairs(2, &b);
    });
}

fn set_nodes(fr: &mut [F], fi: usize, m: usize, f: impl FnOnce(&mut Vec<(i64, i64)>)) {
    edit_msg(fr, fi, m, |t| {
        let rb = t.t_mut(2);
        let mut n = rb.pairs(1);
        f(&mut n);
        rb.set_pairs(1, &n);
    });
}

fn bufs(fr: &[F], fi: usize, m: usize) -> Vec<(i64, i64)> {
    fr[fi].msg(m).tree().t(2).pairs(2)
}

/// Counter frame indices.
const C_SCHEMA_L: usize = 0;
const C_META_P: usize = 1;
const C_SCHEMA_D: usize = 2;
const C_BATCH_L: usize = 3;
const C_BATCH_D: usize = 4;
const C_BATCH_L2: usize = 5;
const C_BATCH_D2: usize = 6;
const C_META_F: usize = 7;
const C_END: usize = 8;

fn counter() -> Vec<F> {
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

// ---------------------------------------------------------------------------------------------
// (a), (b), (c)

#[test]
fn a_every_split_point_gives_the_same_events() {
    for name in FIXTURES {
        let body = fixture(name);
        let base = run(&body, 1);
        assert_eq!(
            base.last(),
            Some(&Event::Verdict(Verdict::Complete)),
            "{name}"
        );
        let whole = fingerprint(&base);
        for k in 0..=body.len() {
            let (calls, fin) = support::run_split(&[&body[..k], &body[k..]], 1);
            let got: Vec<Event> = calls.into_iter().flatten().chain(fin).collect();
            assert_eq!(fingerprint(&got), whole, "{name} split at {k}");
        }
    }
}

#[test]
fn b_payload_past_the_end_is_truncated() {
    let body = fixture("promql-range-counter");
    let mut b = body.clone();
    let at = common::frame_offsets(&body)[C_BATCH_D2];
    common::put_u32(&mut b, at + 8, 1 << 20);
    let ev = run(&b, 1);
    assert_eq!(
        failure(&ev, 2),
        Some(PartError::Stream(DsfError::Truncated))
    );
    assert!(ev.contains(&Event::Truncated));
    assert!(incomplete(&ev));
}

/// The counter with frame `C_BATCH_D`'s header byte `at` set to `v`.
fn header_fault(at: usize, v: &[u8]) -> Vec<Event> {
    let body = fixture("promql-range-counter");
    let mut b = body.clone();
    let p = common::frame_offsets(&body)[C_BATCH_D];
    b[p + at..p + at + v.len()].copy_from_slice(v);
    run(&b, 1)
}

#[test]
fn c_header_faults_fail_every_open_part() {
    let cases: [(usize, Vec<u8>, DsfError); 6] = [
        (0, vec![2], DsfError::Version(2)),
        (14, vec![1, 0], DsfError::Reserved(1)),
        (1, vec![0], DsfError::FrameType(0)),
        (1, vec![9], DsfError::FrameType(9)),
        (
            8,
            (MAX_PAYLOAD + 1).to_le_bytes().to_vec(),
            DsfError::PayloadTooLarge(MAX_PAYLOAD + 1),
        ),
        (2, vec![8, 0], DsfError::Flags(8)),
    ];
    for (at, v, e) in cases {
        let ev = header_fault(at, &v);
        for part in [1, 2] {
            assert_eq!(
                failure(&ev, part),
                Some(PartError::Stream(e.clone())),
                "{e:?}: {ev:?}"
            );
        }
        assert_eq!(chunks(&ev, 2), 0);
        assert!(incomplete(&ev));
    }
}

/// The counter with `f` inserted before frame `at`.
fn with_frame(at: usize, f: F) -> Vec<Event> {
    let mut fr = counter();
    fr.insert(at, f);
    ev(&fr)
}

#[test]
fn c_end_and_ping_rules() {
    let stream = |ev: &[Event], e: DsfError| {
        failure(ev, 1) == Some(PartError::Stream(e.clone()))
            && failure(ev, 2) == Some(PartError::Stream(e))
            && !ev.contains(&Event::End)
            && incomplete(ev)
    };
    let end = DsfError::Malformed("end");
    let cases = [
        F::raw(END, 0, 0, 0, vec![0; 8]),
        F::raw(END, 0, 1, 0, Vec::new()),
        F::raw(END, 0, 0, 1, Vec::new()),
        F::raw(END, LAST, 0, 0, Vec::new()),
    ];
    for f in cases {
        let e = with_frame(C_BATCH_D, f.clone());
        assert!(stream(&e, end.clone()), "{f:?}: {e:?}");
    }
    let ping = DsfError::Malformed("ping");
    let e = with_frame(C_BATCH_D, F::raw(PING, 0, 0, 0, vec![0; 4]));
    assert!(stream(&e, ping.clone()), "{e:?}");
    let e = with_frame(C_BATCH_D, F::raw(PING, 0, 1, 0, Vec::new()));
    assert!(stream(&e, ping), "{e:?}");
    let e = with_frame(C_BATCH_D, F::raw(PROGRESS, 0, 2, 0, Vec::new()));
    assert!(stream(&e, DsfError::FrameType(PROGRESS)), "{e:?}");
    // A valid PING keeps no state.
    let e = with_frame(C_BATCH_D, F::raw(PING, 0, 0, 0, Vec::new()));
    assert_eq!(e.last(), Some(&Event::Verdict(Verdict::Complete)), "{e:?}");
    // A part-0 frame other than END, PING or the stream-level ERROR.
    let mut b = counter()[C_BATCH_D].clone();
    b.part = 0;
    let e = with_frame(C_BATCH_D, b);
    assert!(stream(&e, DsfError::Malformed("part 0")), "{e:?}");
}

/// grid-error's data ERROR (part 4), with LAST cleared.
fn error_without_last() -> F {
    let fr = frames("grid-error");
    let mut f = fr[find_frame(&fr, ERROR, 4, 0)].clone();
    f.flags &= !LAST;
    f
}

#[test]
fn c_error_needs_last_and_last_rules() {
    // new and data-open, on the counter's data part.
    for at in [C_META_P, C_BATCH_D] {
        let mut f = error_without_last();
        f.part = 2;
        let e = with_frame(at, f);
        assert!(order(failure(&e, 2)), "{e:?}");
        assert_eq!(upstreams(&e, 2), 0);
    }
    // closing: grid-error itself.
    let mut fr = frames("grid-error");
    let i = find_frame(&fr, ERROR, 4, 0);
    fr[i].flags &= !LAST;
    let e = ev(&fr);
    assert!(order(failure(&e, 4)), "{e:?}");
    assert_eq!(upstreams(&e, 4), 0);
    // A data BATCH, a planned META and a SCHEMA with LAST.
    for (fi, part) in [(C_BATCH_D, 2), (C_META_P, 2), (C_SCHEMA_L, 1)] {
        let mut fr = counter();
        fr[fi].flags |= LAST;
        let e = ev(&fr);
        assert!(order(failure(&e, part)), "frame {fi}: {e:?}");
    }
}

#[test]
fn c_per_part_flags_are_fixed() {
    let base = frames("grid-batches");
    let mut fr = base.clone();
    let i = find_frame(&fr, BATCH, 2, 2);
    fr[i].flags &= !VOLATILE;
    let e = ev(&fr);
    assert_eq!(failure(&e, 2), Some(PartError::Order("flags")), "{e:?}");
    assert_eq!(chunks(&e, 2), 2, "the third chunk is not emitted");
    let mut fr = base.clone();
    let i = find_frame(&fr, BATCH, 1, 1);
    fr[i].flags &= !VOLATILE;
    let e = ev(&fr);
    assert_eq!(failure(&e, 1), Some(PartError::Order("flags")), "{e:?}");
    assert_eq!(failure(&e, 2), Some(PartError::Order("labels part failed")));
}

#[test]
fn c_labels_link_is_checked_at_schema() {
    for target in ["7", "2"] {
        let mut fr = frames("grid-empty");
        edit_msg(&mut fr, 2, 0, |t| {
            common::set_kv(t, "dash.labels_part", target)
        });
        let e = ev(&fr);
        assert_eq!(
            failure(&e, 2),
            Some(PartError::Schema("labels_part".into())),
            "{target}: {e:?}"
        );
        assert_eq!(grids(&e, 2), 0);
        assert_eq!(coverages(&e, 2), 0);
    }
    // Naming another data part (part-ids: 4 → 2).
    let mut fr = frames("part-ids");
    let i = find_frame(&fr, SCHEMA, 4, 0);
    edit_msg(&mut fr, i, 0, |t| {
        common::set_kv(t, "dash.labels_part", "2")
    });
    let e = ev(&fr);
    assert_eq!(
        failure(&e, 4),
        Some(PartError::Schema("labels_part".into())),
        "{e:?}"
    );
    assert_eq!(grids(&e, 4), 0);
    assert_eq!(coverages(&e, 4), 0);
    let base = run(&fixture("part-ids"), 1);
    assert_eq!(
        fingerprint(&of_part(&e, 2)),
        fingerprint(&of_part(&base, 2))
    );
}

/// grid-empty frames: SCHEMA(1), META(2, planned), SCHEMA(2), BATCH(1)|LAST, META(2)|LAST, END.
fn empty() -> Vec<F> {
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
fn bad_first_offset(fr: &mut [F], fi: usize) {
    let off = bufs(fr, fi, 0)[5].0 as usize;
    edit_body(fr, fi, 0, |b| common::put_u32(b, off, 1));
}

#[test]
fn c_final_coverage_waits_for_the_labels_part() {
    // META(2)|LAST before the labels batch, which is then corrupted.
    let mut fr = empty();
    fr.swap(3, 4);
    let mut bad = fr.clone();
    bad_first_offset(&mut bad, 4);
    let e = ev(&bad);
    let before_end: Vec<Event> = e
        .iter()
        .take_while(|e| **e != Event::End)
        .cloned()
        .collect();
    assert_eq!(before_end.len(), 3, "{e:?}");
    assert!(matches!(before_end[0], Event::Grid { part: 2, .. }));
    assert_eq!(
        before_end[1],
        Event::Failed {
            part: 1,
            reason: PartError::Ipc(IpcError::Layout("first offset"))
        }
    );
    assert_eq!(
        before_end[2],
        Event::Failed {
            part: 2,
            reason: PartError::Order("labels part failed")
        }
    );
    // Uncorrupted: Coverage(final) and PartEnd(2) in the call that delivers the labels LAST.
    let calls = run_calls(&encode(&fr));
    assert!(calls[3].is_empty(), "the coverage is held: {:?}", calls[3]);
    assert_eq!(calls[4].len(), 3, "{:?}", calls[4]);
    assert_eq!(calls[4][0], Event::PartEnd { part: 1 });
    assert!(
        matches!(&calls[4][1], Event::Coverage { part: 2, coverage } if coverage.phase == dash_wire::Phase::Final)
    );
    assert_eq!(calls[4][2], Event::PartEnd { part: 2 });
    // The labels LAST batch removed, END following.
    let mut fr = empty();
    fr.remove(3);
    let e = ev(&fr);
    assert_eq!(
        failure(&e, 1),
        Some(PartError::Order("open at END")),
        "{e:?}"
    );
    assert_eq!(failure(&e, 2), Some(PartError::Order("labels part failed")));
    assert_eq!(coverages(&e, 2), 0);
    assert!(e.contains(&Event::End));
}

#[test]
fn c_body_verdict() {
    let ok = run(&fixture("promql-range-counter"), 1);
    assert_eq!(ok.last(), Some(&Event::Verdict(Verdict::Complete)));
    // An extra 0-row labels BATCH for the finished part 1, before END.
    let extra = empty()[3].clone();
    let e = with_frame(C_END, extra);
    let cov = e
        .iter()
        .position(|e| matches!(e, Event::Coverage { part: 2, .. }));
    let fail = e
        .iter()
        .position(|e| matches!(e, Event::Failed { part: 1, .. }));
    assert!(matches!((cov, fail), (Some(c), Some(f)) if c < f), "{e:?}");
    assert!(order(failure(&e, 1)));
    assert!(incomplete(&e), "{e:?}");
    // A part-0 ERROR: Upstream { part: 0 }, stream_error set, Incomplete.
    let er = frames("grid-error");
    let mut f = er[find_frame(&er, ERROR, 5, 0)].clone();
    f.part = 0;
    let mut fr = counter();
    fr.insert(C_END, f.clone());
    let (e, fin, d) = run_dec(&encode(&fr));
    assert_eq!(upstreams(&e, 0), 1, "{e:?}");
    assert!(d.stream_error().is_some());
    assert!(incomplete(&fin));
    // A second stream-level ERROR fails the stream.
    let mut fr = counter();
    fr.insert(C_BATCH_D2, f.clone());
    fr.insert(C_BATCH_D2, f);
    let e = ev(&fr);
    assert_eq!(
        failure(&e, 2),
        Some(PartError::Stream(DsfError::Malformed("part 0")))
    );
}

// ---------------------------------------------------------------------------------------------
// Padding, offsets, metadata length

/// Single-byte change at body-relative `at` of message `m` of frame `fi` of `name`; returns the
/// failure of `part`, its chunk count and the full events.
fn poke(name: &str, fi: usize, m: usize, at: usize, f: impl FnOnce(&mut u8)) -> Vec<Event> {
    let mut fr = frames(name);
    edit_body(&mut fr, fi, m, |b| f(&mut b[at]));
    ev(&fr)
}

#[test]
fn metadata_padding_must_be_zero() {
    let body = fixture("promql-range-counter");
    let (meta_at, l, _) = common::locate(&body, C_BATCH_D, 0);
    let h = common::read_tree(&body[meta_at..meta_at + l]).1;
    assert!(h < l);
    let mut b = body.clone();
    b[meta_at + h] = 1;
    let e = run(&b, 1);
    assert_eq!(failure(&e, 2), ipc(IpcError::Layout("padding")), "{e:?}");
    assert_eq!(chunks(&e, 2), 0);
    assert_eq!(coverages(&e, 2), 0);
}

#[test]
fn body_padding_must_be_zero() {
    let nz = ipc(IpcError::Layout("nonzero padding"));
    let c = counter();
    let grid = bufs(&c, C_BATCH_D, 0);
    let labels = bufs(&c, C_BATCH_L, 0);
    let set = |b: &mut u8| *b = 1;
    // (part, events)
    let cases: Vec<(&str, u32, Vec<Event>)> = vec![
        (
            "values tail",
            2,
            poke(
                "promql-range-counter",
                C_BATCH_D,
                0,
                grid[4].0 as usize + 721 * 8 + 2,
                set,
            ),
        ),
        (
            "series_id tail",
            2,
            poke(
                "promql-range-counter",
                C_BATCH_D,
                0,
                grid[1].0 as usize + 10,
                set,
            ),
        ),
        (
            "child validity tail",
            2,
            poke(
                "promql-range-counter",
                C_BATCH_D,
                0,
                grid[3].0 as usize + 100,
                set,
            ),
        ),
        ("unused validity bit", 2, {
            let fr = frames("grid-batches");
            let fi = find_frame(&fr, BATCH, 2, 0);
            let v = bufs(&fr, fi, 0)[3].0 as usize;
            poke("grid-batches", fi, 0, v, |b| *b |= 0x80)
        }),
        (
            "gap between labels buffers",
            1,
            poke(
                "promql-range-counter",
                C_BATCH_L,
                0,
                (labels[5].0 + labels[5].1) as usize + 1,
                set,
            ),
        ),
        (
            "body tail after the last buffer",
            1,
            poke(
                "promql-range-counter",
                C_BATCH_L,
                0,
                c[C_BATCH_L].msg(0).body.len() - 1,
                set,
            ),
        ),
        (
            "after the last offset of label data",
            1,
            poke(
                "promql-range-counter",
                C_BATCH_L,
                0,
                (labels[6].0 + labels[6].1) as usize,
                set,
            ),
        ),
        (
            "after the label_value offsets",
            1,
            poke(
                "promql-range-counter",
                C_BATCH_L,
                0,
                (labels[8].0 + labels[8].1) as usize + 1,
                set,
            ),
        ),
    ];
    for (name, part, e) in cases {
        assert_eq!(failure(&e, part), nz, "{name}: {e:?}");
        if part == 2 {
            assert_eq!(chunks(&e, 2), 0, "{name}");
        }
    }
}

#[test]
fn first_offsets_and_list_children() {
    let mut fr = counter();
    bad_first_offset(&mut fr, C_BATCH_L);
    let e = ev(&fr);
    assert_eq!(
        failure(&e, 1),
        ipc(IpcError::Layout("first offset")),
        "{e:?}"
    );
    // coverage/1: `warnings` is node 15 (list) with child node 16; its offsets are buffer 33.
    let mut fr = counter();
    assert_eq!(fr[C_META_F].msg(1).tree().t(2).pairs(1).len(), 26);
    let off = bufs(&fr, C_META_F, 1)[33].0 as usize;
    edit_body(&mut fr, C_META_F, 1, |b| common::put_u32(b, off, 1));
    let e = ev(&fr);
    assert_eq!(
        failure(&e, 2),
        ipc(IpcError::Layout("first offset")),
        "{e:?}"
    );
    assert_eq!(coverages(&e, 2), 0);
    let mut fr = counter();
    set_nodes(&mut fr, C_META_F, 1, |n| n[16].0 += 1);
    let e = ev(&fr);
    assert_eq!(failure(&e, 2), ipc(IpcError::Layout("list child")), "{e:?}");
    assert_eq!(coverages(&e, 2), 0);
}

#[test]
fn metadata_length_must_be_minimal() {
    let mut fr = counter();
    let body = encode(&fr);
    let (meta_at, l, body_at) = common::locate(&body, C_BATCH_D, 0);
    let start = common::frame_offsets(&body)[C_BATCH_D] + 16;
    let end = common::frame_offsets(&body)[C_BATCH_D + 1];
    let mut payload = body[start..end].to_vec();
    common::put_u32(&mut payload, 4, (l + 64) as u32);
    let rel = body_at - start;
    payload.splice(rel..rel, std::iter::repeat_n(0u8, 64));
    assert_eq!(meta_at - start, 8);
    let f = &fr[C_BATCH_D];
    fr[C_BATCH_D] = F::raw(BATCH, f.flags, f.part, f.rank, payload);
    let e = ev(&fr);
    assert_eq!(
        failure(&e, 2),
        ipc(IpcError::Layout("metadata length")),
        "{e:?}"
    );
    assert_eq!(chunks(&e, 2), 0);
    assert_eq!(coverages(&e, 2), 0);
    // Every committed fixture is writer-valid.
    for name in FIXTURES {
        let e = run(&fixture(name), 1);
        assert!(
            !e.iter().any(|e| matches!(e, Event::Failed { .. })),
            "{name}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Links between parts

#[test]
fn linked_ranks_must_match() {
    let mut fr = frames("grid-batches");
    for f in fr.iter_mut().filter(|f| f.part == 1) {
        f.rank = 2;
    }
    let e = ev(&fr);
    assert_eq!(
        failure(&e, 2),
        Some(PartError::Schema("labels_part rank".into())),
        "{e:?}"
    );
    assert_eq!(grids(&e, 2), 0);
}

/// Sets the first byte of the counter's first labels batch `label_value` data to 0xFF.
fn bad_utf8(fr: &mut [F], fi: usize) {
    let at = bufs(fr, fi, 0)[9].0 as usize;
    edit_body(fr, fi, 0, |b| b[at] = 0xFF);
}

#[test]
fn failed_labels_parts_fail_their_data_parts() {
    // Before the link: the labels batch moved before META(planned).
    let mut fr = counter();
    bad_utf8(&mut fr, C_BATCH_L);
    let b = fr.remove(C_BATCH_L);
    fr.insert(C_META_P, b);
    let e = ev(&fr);
    assert_eq!(failure(&e, 1), ipc(IpcError::Utf8), "{e:?}");
    assert_eq!(
        failure(&e, 2),
        Some(PartError::Schema("labels_part".into()))
    );
    assert_eq!(grids(&e, 2), 0);
    // After the link, counter: both failures in the same call.
    let mut fr = counter();
    bad_utf8(&mut fr, C_BATCH_L);
    let calls = run_calls(&encode(&fr));
    assert_eq!(
        calls[C_BATCH_L],
        [
            Event::Failed {
                part: 1,
                reason: PartError::Ipc(IpcError::Utf8)
            },
            Event::Failed {
                part: 2,
                reason: PartError::Order("labels part failed")
            }
        ]
    );
    let all: Vec<Event> = calls.concat();
    assert_eq!(chunks(&all, 2), 0);
    assert_eq!(coverages(&all, 2), 0);
    // After the link, grid-empty: its 0-row labels batch corrupted.
    let mut fr = empty();
    bad_first_offset(&mut fr, 3);
    let calls = run_calls(&encode(&fr));
    assert_eq!(calls[3].len(), 2, "{:?}", calls[3]);
    assert!(matches!(&calls[3][0], Event::Failed { part: 1, .. }));
    assert_eq!(
        calls[3][1],
        Event::Failed {
            part: 2,
            reason: PartError::Order("labels part failed")
        }
    );
    assert_eq!(coverages(&calls.concat(), 2), 0);
}

// ---------------------------------------------------------------------------------------------
// Closed value sets

#[test]
fn closed_value_sets() {
    let base = run(&fixture("promql-range-counter"), 1);
    let check = |fr: &[F], part: u32, field: &'static str| {
        let e = ev(fr);
        assert_eq!(
            failure(&e, part),
            Some(PartError::Value(field)),
            "{field}: {e:?}"
        );
        assert_eq!(coverages(&e, part), 0, "{field}");
        assert_eq!(upstreams(&e, part), 0, "{field}");
        e
    };
    // Coverage byte columns: phase is buffer 1, exactness buffer 3, read_cache buffer 48.
    let poke_cov = |fi: usize, buf: usize, v: u8| {
        let mut fr = counter();
        let at = bufs(&fr, fi, 1)[buf].0 as usize;
        edit_body(&mut fr, fi, 1, |b| b[at] = v);
        fr
    };
    let e = check(&poke_cov(C_META_F, 1, 3), 2, "phase");
    assert_eq!(of_part(&e, 1), of_part(&base, 1));
    check(&poke_cov(C_META_P, 1, 2), 2, "phase");
    check(&poke_cov(C_META_F, 3, 5), 2, "exactness");
    let c = counter();
    assert_eq!(
        c[C_META_F].msg(1).tree().t(2).pairs(1)[21],
        (1, 0),
        "read_cache set"
    );
    check(&poke_cov(C_META_F, 48, 4), 2, "read_cache");
    // Grid metadata.
    for (key, value, field) in [
        ("dash.result", "metrics", "dash.result"),
        ("dash.source", "PulsusDB", "dash.source"),
        ("dash.time_unit", "ns", "dash.time_unit"),
    ] {
        let mut fr = counter();
        edit_msg(&mut fr, C_SCHEMA_D, 0, |t| common::set_kv(t, key, value));
        let e = check(&fr, 2, field);
        assert_eq!(grids(&e, 2), 0);
        assert_eq!(of_part(&e, 1), of_part(&base, 1), "{field}");
    }
    // error/1 code 9 on part 5; parts 3 and 4 unchanged.
    let er = frames("grid-error");
    let ebase = ev(&er);
    let mut fr = er.clone();
    let fi = find_frame(&fr, ERROR, 5, 0);
    let at = bufs(&fr, fi, 1)[1].0 as usize;
    edit_body(&mut fr, fi, 1, |b| b[at] = 9);
    let e = check(&fr, 5, "code");
    for p in [3, 4] {
        assert_eq!(
            fingerprint(&of_part(&e, p)),
            fingerprint(&of_part(&ebase, p))
        );
    }
    // A META/ERROR payload whose schema is another valid schema.
    let mut fr = counter();
    edit_msg(&mut fr, C_META_F, 0, |t| {
        common::set_kv(t, "dash.schema", "error/1");
    });
    let e = ev(&fr);
    assert!(failure(&e, 2).is_some(), "{e:?}");
    assert_eq!(coverages(&e, 2), 0);
}

// ---------------------------------------------------------------------------------------------
// (d) IPC corruptions of the counter's data part

fn data_fails(fr: &[F]) -> Option<PartError> {
    let e = ev(fr);
    assert_eq!(chunks(&e, 2), 0, "{e:?}");
    failure(&e, 2)
}

/// The counter with the raw payload of frame `fi` edited.
fn raw_edit(fi: usize, f: impl FnOnce(&mut Vec<u8>)) -> Vec<F> {
    let body = fixture("promql-range-counter");
    let offs = common::frame_offsets(&body);
    let mut payload = body[offs[fi] + 16..offs[fi + 1]].to_vec();
    f(&mut payload);
    let mut fr = counter();
    let g = &fr[fi];
    fr[fi] = F::raw(g.kind, g.flags, g.part, g.rank, payload);
    fr
}

#[test]
fn d_message_framing() {
    let fr = raw_edit(C_BATCH_D, |p| p[0] = 0xFE);
    assert!(matches!(data_fails(&fr), Some(PartError::Ipc(_))));
    let fr = raw_edit(C_BATCH_D, |p| {
        let l = common::u32_at(p, 4);
        common::put_u32(p, 4, l - 4);
    });
    assert!(
        matches!(data_fails(&fr), Some(PartError::Ipc(_))),
        "L not ≡ 0 mod 8"
    );
    let fr = raw_edit(C_BATCH_D, |p| common::put_u32(p, 4, 100_000));
    assert!(
        matches!(data_fails(&fr), Some(PartError::Ipc(_))),
        "L past the payload"
    );
    let mut fr = counter();
    edit_msg(&mut fr, C_BATCH_D, 0, |t| {
        let bl = t.int(3);
        t.set_int(3, 8, bl - 8);
    });
    assert_eq!(
        data_fails(&fr),
        ipc(IpcError::Messages),
        "bodyLength ≠ remaining"
    );
    let mut fr = counter();
    let m = fr[C_BATCH_D].msg(0).clone();
    fr[C_BATCH_D].pieces = vec![Piece::M(m.clone()), Piece::M(m)];
    assert_eq!(data_fails(&fr), ipc(IpcError::Messages), "two messages");
}

#[test]
fn d_metadata_corruptions() {
    let unsupported = |fr: &[F]| {
        matches!(
            data_fails(fr),
            Some(PartError::Ipc(IpcError::Unsupported(_)))
        )
    };
    let mut fr = counter();
    edit_msg(&mut fr, C_BATCH_D, 0, |t| t.set_int(0, 2, 3));
    assert_eq!(data_fails(&fr), ipc(IpcError::Version), "V4");
    let mut fr = counter();
    edit_msg(&mut fr, C_BATCH_D, 0, |t| t.set_int(1, 1, 2));
    assert!(unsupported(&fr), "DictionaryBatch");
    let mut fr = counter();
    edit_msg(&mut fr, C_SCHEMA_D, 0, |t| t.t_mut(2).set_int(0, 2, 1));
    assert!(unsupported(&fr), "big-endian");
    let mut fr = counter();
    edit_msg(&mut fr, C_SCHEMA_D, 0, |t| {
        let mut d = Tb::default();
        d.set_int(0, 8, 0);
        t.t_mut(2).tv_mut(1)[1].f.insert(4, V::T(d));
    });
    assert!(unsupported(&fr), "dictionary-encoded field");
    let mut fr = counter();
    edit_msg(&mut fr, C_SCHEMA_D, 0, |t| {
        t.t_mut(2).tv_mut(1)[0].t_mut(3).set_int(1, 1, 1);
    });
    assert!(unsupported(&fr), "signed Int");
    let mut fr = counter();
    edit_msg(&mut fr, C_SCHEMA_D, 0, |t| {
        t.t_mut(2).tv_mut(1)[1].tv_mut(5)[0]
            .t_mut(3)
            .set_int(0, 2, 1);
    });
    assert!(unsupported(&fr), "SINGLE");
    let mut fr = counter();
    edit_msg(&mut fr, C_META_P, 0, |t| {
        t.t_mut(2).tv_mut(1)[12].t_mut(3).set_int(0, 2, 0);
    });
    assert!(unsupported(&fr), "timestamp in seconds");
    let mut fr = counter();
    edit_msg(&mut fr, C_BATCH_D, 0, |t| {
        let mut c = Tb::default();
        c.set_int(0, 1, 0);
        c.set_int(1, 1, 0);
        t.t_mut(2).f.insert(3, V::T(c));
    });
    assert!(unsupported(&fr), "compression");
}

#[test]
fn d_nodes_and_buffers() {
    let mut fr = counter();
    set_nodes(&mut fr, C_BATCH_D, 0, |n| {
        n.pop();
    });
    assert_eq!(data_fails(&fr), ipc(IpcError::Messages), "node count");
    let mut fr = counter();
    set_bufs(&mut fr, C_BATCH_D, 0, |b| {
        b.pop();
    });
    assert_eq!(data_fails(&fr), ipc(IpcError::Messages), "buffer count");
    let mut fr = counter();
    set_bufs(&mut fr, C_BATCH_D, 0, |b| b[1] = (4, 60));
    assert_eq!(
        data_fails(&fr),
        ipc(IpcError::Layout("align")),
        "offset ≢ 0 mod 8"
    );
    let mut fr = counter();
    set_bufs(&mut fr, C_BATCH_D, 0, |b| b[4].1 += 64);
    assert_eq!(data_fails(&fr), ipc(IpcError::Bounds), "past the body");
    let mut fr = counter();
    set_bufs(&mut fr, C_BATCH_D, 0, |b| b[1] = (0, 72));
    assert_eq!(data_fails(&fr), ipc(IpcError::Layout("overlap")), "overlap");
    let mut fr = counter();
    set_bufs(&mut fr, C_BATCH_D, 0, |b| b.swap(3, 4));
    assert_eq!(
        data_fails(&fr),
        ipc(IpcError::Layout("overlap")),
        "out of order"
    );
    let mut fr = counter();
    set_bufs(&mut fr, C_BATCH_D, 0, |b| b[3].1 = 64);
    assert_eq!(
        data_fails(&fr),
        ipc(IpcError::Layout("nulls")),
        "short validity"
    );
    let mut fr = counter();
    set_nodes(&mut fr, C_BATCH_D, 0, |n| n[2].0 = 720);
    assert!(
        matches!(data_fails(&fr), Some(PartError::Ipc(IpcError::Layout(_)))),
        "fsl child"
    );
    // Bool data shorter than ⌈len/8⌉ (coverage `truncated` data is buffer 9).
    let mut fr = counter();
    set_bufs(&mut fr, C_META_P, 1, |b| b[9].1 = 0);
    assert!(
        matches!(data_fails(&fr), Some(PartError::Ipc(IpcError::Layout(_)))),
        "bool data"
    );
}

/// The counter with its first labels batch replaced.
fn with_labels(m: Msg) -> Vec<Event> {
    let mut fr = counter();
    *fr[C_BATCH_L].msg_mut(0) = m;
    ev(&fr)
}

const K0: u64 = 0x47ad_55f1_f828_d9ee;

#[test]
fn d_label_rows() {
    let shape = |e: &[Event]| matches!(failure(e, 1), Some(PartError::Shape(_)));
    let ba = common::labels_msg(
        &[
            (0, K0, Some(b"b"), Some(b"x")),
            (0, K0, Some(b"a"), Some(b"y")),
        ],
        false,
    );
    assert!(shape(&with_labels(ba)), "b then a");
    let aa = common::labels_msg(
        &[
            (0, K0, Some(b"a"), Some(b"x")),
            (0, K0, Some(b"a"), Some(b"y")),
        ],
        false,
    );
    assert!(shape(&with_labels(aa)), "a, a");
    let null_and_named = common::labels_msg(
        &[(0, K0, None, None), (0, K0, Some(b"a"), Some(b"b"))],
        false,
    );
    assert!(
        shape(&with_labels(null_and_named)),
        "null row and named row"
    );
    let half = common::labels_msg(&[(0, K0, Some(b"a"), None)], false);
    assert!(shape(&with_labels(half)), "half-null");
    let mixed = common::labels_msg(
        &[
            (0, K0, Some(b"a"), Some(b"x")),
            (0, 1, Some(b"b"), Some(b"y")),
        ],
        false,
    );
    assert!(shape(&with_labels(mixed)), "mixed key hashes");
    let split = common::labels_msg(
        &[
            (0, K0, Some(b"a"), Some(b"x")),
            (1, 2, Some(b"a"), Some(b"x")),
            (0, K0, Some(b"b"), Some(b"y")),
        ],
        false,
    );
    assert!(shape(&with_labels(split)), "non-contiguous rows");
    // A series' rows over two labels batches.
    let mut fr = counter();
    *fr[C_BATCH_L2].msg_mut(0) = common::labels_msg(&[(0, K0, Some(b"z"), Some(b"v"))], false);
    let e = ev(&fr);
    assert_eq!(failure(&e, 1), Some(PartError::DuplicateSeries(0)), "{e:?}");
    // Invalid UTF-8.
    let mut fr = counter();
    bad_utf8(&mut fr, C_BATCH_L);
    assert_eq!(failure(&ev(&fr), 1), ipc(IpcError::Utf8));
}

/// 70 one-label rows (series 0…69) with every bitmap written.
fn rows70(nulls: &[u32]) -> Msg {
    let rows: Vec<common::LabelRow<'_>> = (0..70u32)
        .map(|i| {
            if nulls.contains(&i) {
                (i, u64::from(i), None, None)
            } else {
                (i, u64::from(i), Some(&b"a"[..]), Some(&b"x"[..]))
            }
        })
        .collect();
    common::labels_msg(&rows, true)
}

fn edit_rb(m: &Msg, f: impl FnOnce(&mut Vec<(i64, i64)>, &mut Vec<(i64, i64)>)) -> Msg {
    m.edit(|t| {
        let rb = t.t_mut(2);
        let mut n = rb.pairs(1);
        let mut b = rb.pairs(2);
        f(&mut n, &mut b);
        rb.set_pairs(1, &n);
        rb.set_pairs(2, &b);
    })
}

#[test]
fn d_validity_counts() {
    let nulls = ipc(IpcError::Layout("nulls"));
    // Sanity: the 70-row batch is accepted (series 0 and 1 then appear with label a=x).
    assert_eq!(
        failure(&with_labels(rows70(&[])), 1),
        Some(PartError::DuplicateSeries(1))
    );
    let cases: Vec<(&str, Msg)> = vec![
        (
            "1-byte bitmap, 0 nulls",
            edit_rb(&rows70(&[]), |_, b| b[4].1 = 1),
        ),
        (
            "1-byte bitmap, 3 nulls",
            edit_rb(&rows70(&[]), |n, b| {
                b[4].1 = 1;
                n[2].1 = 3;
            }),
        ),
        (
            "2 zero bits, null_count 1",
            edit_rb(&rows70(&[5, 6]), |n, _| n[2].1 = 1),
        ),
        (
            "all ones, null_count 1",
            edit_rb(&rows70(&[]), |n, _| n[2].1 = 1),
        ),
        (
            "a 0 bit, null_count 0",
            edit_rb(&rows70(&[5]), |n, _| n[2].1 = 0),
        ),
        (
            "non-nullable series_id",
            edit_rb(&rows70(&[]), |n, _| n[0].1 = 1),
        ),
    ];
    for (name, m) in cases {
        assert_eq!(failure(&with_labels(m), 1), nulls, "{name}");
    }
}

#[test]
fn d_utf8_offsets() {
    let c = counter();
    let off = bufs(&c, C_BATCH_L, 0)[5].0 as usize;
    let mut fr = counter();
    edit_body(&mut fr, C_BATCH_L, 0, |b| common::put_u32(b, off + 4, 20));
    assert!(
        matches!(
            failure(&ev(&fr), 1),
            Some(PartError::Ipc(IpcError::Layout(_)))
        ),
        "decreasing"
    );
    let mut fr = counter();
    edit_body(&mut fr, C_BATCH_L, 0, |b| common::put_u32(b, off + 8, 100));
    assert!(
        matches!(
            failure(&ev(&fr), 1),
            Some(PartError::Ipc(IpcError::Layout(_)))
        ),
        "last > data"
    );
}

#[test]
fn d_additional_columns() {
    let column = ipc(IpcError::Unsupported("column"));
    for values in [&[&b"x"[..], &b"y"[..]][..], &[&b"\xff"[..], &b"y"[..]][..]] {
        let mut fr = counter();
        edit_msg(&mut fr, C_SCHEMA_L, 0, |t| {
            t.t_mut(2)
                .tv_mut(1)
                .push(common::field("extra", false, 5, Tb::default(), Vec::new()));
        });
        for fi in [C_BATCH_L, C_BATCH_L2] {
            let (v, o, d) = common::utf8_bufs(values);
            let m = common::append_column(fr[fi].msg(0), &[(2, 0)], &[&v, &o, &d]);
            *fr[fi].msg_mut(0) = m;
        }
        let e = ev(&fr);
        assert_eq!(failure(&e, 1), column, "{e:?}");
    }
    let mut fr = counter();
    edit_msg(&mut fr, C_SCHEMA_D, 0, |t| {
        t.t_mut(2).tv_mut(1).push(common::field(
            "extra",
            false,
            2,
            common::int_ty(32),
            Vec::new(),
        ));
    });
    for fi in [C_BATCH_D, C_BATCH_D2] {
        let m = common::append_column(fr[fi].msg(0), &[(1, 0)], &[&[][..], &[7u8, 0, 0, 0][..]]);
        *fr[fi].msg_mut(0) = m;
    }
    assert_eq!(failure(&ev(&fr), 2), column);
}

// ---------------------------------------------------------------------------------------------
// (e) semantic checks, (e′) arithmetic boundaries

#[test]
fn e_semantic() {
    let schema = |fr: &[F]| {
        let e = ev(fr);
        assert_eq!(grids(&e, 2), 0, "{e:?}");
        failure(&e, 2)
    };
    let kv = |key: &str, value: &str| {
        let mut fr = counter();
        edit_msg(&mut fr, C_SCHEMA_D, 0, |t| common::set_kv(t, key, value));
        fr
    };
    assert!(is_schema(&schema(&kv(
        "dash.schema",
        "metric_matrix.grid/2"
    ))));
    assert!(is_schema(&schema(&kv("dash.grid.step_ms", "0"))));
    assert!(is_schema(&schema(&kv("dash.grid.len", "0"))));
    assert!(is_schema(&schema(&kv("dash.grid.len", "4194305"))));
    assert!(is_schema(&schema(&kv(
        "dash.grid.requested_start_ms",
        "1767225605000"
    ))));
    let mut fr = counter();
    edit_msg(&mut fr, C_SCHEMA_D, 0, |t| {
        t.t_mut(2).tv_mut(1)[1].t_mut(3).set_int(0, 4, 720);
    });
    assert!(
        matches!(schema(&fr), Some(PartError::Shape(_))),
        "list size ≠ len"
    );
    // Null slots without the canonical bits.
    let c = counter();
    let grid = bufs(&c, C_BATCH_D, 0);
    let body = &c[C_BATCH_D].msg(0).body;
    let v = grid[3].0 as usize;
    let null = (0..721)
        .find(|i| body[v + i / 8] >> (i % 8) & 1 == 0)
        .unwrap_or_else(|| panic!("no null slot"));
    for bits in [0x7FF8_0000_0000_0001u64, 0xFFF8_0000_0000_0000] {
        let mut fr = counter();
        let at = grid[4].0 as usize + 8 * null;
        edit_body(&mut fr, C_BATCH_D, 0, |b| {
            b[at..at + 8].copy_from_slice(&bits.to_le_bytes())
        });
        let e = ev(&fr);
        assert_eq!(failure(&e, 2), Some(PartError::NullBits), "{bits:x}");
        assert_eq!(chunks(&e, 2), 0);
    }
    // Series ids.
    let mut fr = counter();
    let at = grid[1].0 as usize;
    edit_body(&mut fr, C_BATCH_D, 0, |b| common::put_u32(b, at, 7));
    assert_eq!(failure(&ev(&fr), 2), Some(PartError::MissingLabels(7)));
    let mut fr = counter();
    let at = bufs(&fr, C_BATCH_D2, 0)[1].0 as usize;
    edit_body(&mut fr, C_BATCH_D2, 0, |b| common::put_u32(b, at, 0));
    let e = ev(&fr);
    assert_eq!(failure(&e, 2), Some(PartError::DuplicateSeries(0)));
    assert_eq!(chunks(&e, 2), 1);
    // BATCH before META(planned).
    let mut b = counter()[C_BATCH_D].clone();
    b.part = 9;
    let e = with_frame(C_META_P, b);
    assert!(order(failure(&e, 9)), "{e:?}");
    // A frame after END.
    let mut fr = counter();
    fr.push(fr[C_BATCH_L].clone());
    let e = ev(&fr);
    assert_eq!(failure(&e, 1), Some(PartError::Stream(DsfError::AfterEnd)));
    assert!(incomplete(&e));
}

#[test]
fn e_prime_arithmetic_boundaries() {
    let one_point = |start: i64, requested: i64| {
        let mut fr = empty();
        edit_msg(&mut fr, 2, 0, |t| {
            common::set_kv(t, "dash.grid.start_ms", &start.to_string());
            common::set_kv(t, "dash.grid.requested_start_ms", &requested.to_string());
            common::set_kv(t, "dash.grid.step_ms", "1000");
            common::set_kv(t, "dash.grid.len", "1");
            t.t_mut(2).tv_mut(1)[1].t_mut(3).set_int(0, 4, 1);
        });
        ev(&fr)
    };
    let e = one_point(i64::MAX - 10, i64::MAX);
    assert!(
        !e.iter().any(|e| matches!(e, Event::Failed { .. })),
        "{e:?}"
    );
    let grid = e.iter().find_map(|e| match e {
        Event::Grid { info, .. } => Some(info.clone()),
        _ => None,
    });
    assert!(matches!(grid, Some(g) if g.start_ms == i64::MAX - 10 && g.len == 1));
    let e = one_point(i64::MAX - 10, i64::MAX - 11);
    assert!(is_schema(&failure(&e, 2)), "requested before start: {e:?}");
    let e = one_point(i64::MIN, i64::MAX);
    assert!(
        is_schema(&failure(&e, 2)),
        "ordered unsigned difference: {e:?}"
    );
    // Chunk ids.
    let e = run(&fixture("promql-range-counter"), u64::MAX);
    let ids: Vec<u64> = e
        .iter()
        .filter_map(|e| match e {
            Event::Chunk { chunk, .. } => Some(chunk.id.0),
            _ => None,
        })
        .collect();
    assert_eq!(ids, [u64::MAX]);
    assert_eq!(failure(&e, 2), Some(PartError::Limit("chunk ids")));
}

// ---------------------------------------------------------------------------------------------
// (f) end of input

/// The events of the first `finish` call for a body cut at frame `cut` (frames before it kept).
fn finish_after(name: &str, cut: usize) -> (Vec<Event>, Vec<Event>) {
    let body = fixture(name);
    let offs = common::frame_offsets(&body);
    let end = offs.get(cut).copied().unwrap_or(body.len());
    let (_, fin, mut d) = run_dec(&body[..end]);
    let again = d.finish();
    (fin, again)
}

fn truncated(part: u32) -> Event {
    Event::Failed {
        part,
        reason: PartError::Stream(DsfError::Truncated),
    }
}

#[test]
fn f_end_of_input() {
    let (fin, again) = finish_after("promql-range-counter", C_BATCH_D + 1);
    assert_eq!(fin.len(), 4, "{fin:?}");
    assert_eq!(
        fin[..3],
        [truncated(1), truncated(2), Event::Truncated],
        "{fin:?}"
    );
    assert!(incomplete(&fin));
    assert!(again.is_empty());
    let er = frames("grid-error");
    let partial = find_frame(&er, META, 4, 1);
    let (fin, again) = finish_after("grid-error", partial + 1);
    assert_eq!(fin.len(), 3, "{fin:?}");
    assert_eq!(fin[..2], [truncated(4), Event::Truncated], "{fin:?}");
    assert!(incomplete(&fin));
    assert!(again.is_empty());
    let (fin, again) = finish_after("promql-range-counter", C_END);
    assert_eq!(fin.len(), 2, "{fin:?}");
    assert_eq!(fin[..1], [Event::Truncated], "{fin:?}");
    assert!(incomplete(&fin));
    assert!(again.is_empty());
    let (fin, again) = finish_after("promql-range-counter", C_END + 1);
    assert_eq!(fin, [Event::Verdict(Verdict::Complete)]);
    assert!(again.is_empty());
    // The final META removed: END fails part 2; finish gives the verdict only.
    let mut fr = counter();
    fr.remove(C_META_F);
    let (e, fin, mut d) = run_dec(&encode(&fr));
    assert_eq!(
        failure(&e, 2),
        Some(PartError::Order("open at END")),
        "{e:?}"
    );
    assert!(e.contains(&Event::End));
    assert_eq!(fin.len(), 1);
    assert!(incomplete(&fin));
    assert!(d.finish().is_empty());
    assert!(silent(&e, 0));
}
