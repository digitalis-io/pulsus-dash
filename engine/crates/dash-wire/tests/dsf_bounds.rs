//! unit:dsf-bounds (plan #68 B2 §5 (a)–(c), (e), (e′), (f); T04-009, T04-010): split points,
//! header faults, frame and state rules, links between parts, semantic checks, arithmetic
//! boundaries and end of input. The layout, padding, closed-set and IPC cases (d) are in
//! `dsf_bounds_layout.rs`. Never a panic; in two-part bodies the other part's events are
//! unchanged.
mod bounds;
mod common;
mod support;

use bounds::*;
use common::*;
use dash_wire::{DsfError, Event, IpcError, MAX_PAYLOAD, PartError, Verdict};
use support::*;

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
        for k in 0..=body.len() {
            let (calls, fin) = support::run_split(&[&body[..k], &body[k..]], 1);
            let got: Vec<Event> = calls.into_iter().flatten().chain(fin).collect();
            assert!(support::same(&got, &base), "{name} split at {k}");
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
