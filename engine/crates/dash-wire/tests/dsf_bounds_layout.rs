//! unit:dsf-bounds, layout cases (plan #68 B2 §5 (c) padding, offsets and metadata length,
//! closed value sets, (d) IPC corruptions; T04-010): single mutations of the B1 fixtures, each
//! failing only its part before any event or chunk of the frame.
mod bounds;
mod common;
mod support;

use bounds::*;
use common::*;
use dash_wire::{Event, IpcError, PartError};
use support::*;

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
