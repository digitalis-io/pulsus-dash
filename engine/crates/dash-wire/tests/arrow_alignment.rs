//! unit:arrow-alignment, Rust side (plan #68 B2 §5; T04-015 as amended, B1 §3.2): split frames
//! keep their body position mod 64 and pin nothing; misaligned buffers and bodies are refused.
mod common;
mod support;

use common::{BATCH, F, FIXTURES, fixture};
use dash_wire::{BodyDecoder, Event, FrameSplitter, IpcError, PartError, SharedBytes, Verdict};
use support::{chunks, failure, run};

/// Drains `s` into `d`; every frame is dropped when `frame` returns.
fn drain(s: &mut FrameSplitter, d: &mut BodyDecoder, ev: &mut Vec<Event>) {
    loop {
        match s.next() {
            Ok(Some(f)) => ev.extend(d.frame(f)),
            Ok(None) => return,
            Err(e) => {
                ev.extend(d.fail_stream(e));
                return;
            }
        }
    }
}

#[test]
fn i_every_split_point_same_events_nothing_pinned() {
    for name in FIXTURES {
        let body = fixture(name);
        let base = run(&body, 1);
        assert_eq!(
            base.last(),
            Some(&Event::Verdict(Verdict::Complete)),
            "{name}"
        );
        for k in 0..=body.len() {
            let a = SharedBytes::copy_from(&body[..k], 0);
            let b = SharedBytes::copy_from(&body[k..], k % 64);
            let mut s = FrameSplitter::new();
            let mut d = BodyDecoder::new(1);
            let mut ev = Vec::new();
            for piece in [&a, &b] {
                if let Err(e) = s.push(piece.clone()) {
                    ev.extend(d.fail_stream(e));
                }
                drain(&mut s, &mut d, &mut ev);
                assert_eq!(piece.strong_count(), 1, "{name} at {k}: a piece is pinned");
            }
            if let Err(e) = s.finish() {
                ev.extend(d.fail_stream(e));
            }
            ev.extend(d.finish());
            assert!(support::same(&ev, &base), "{name} split at {k}");
        }
    }
}

const C_BATCH_D: usize = 4;

#[test]
fn iv_grid_buffer_8_but_not_64_aligned() {
    let body = fixture("promql-range-counter");
    let at = common::struct_vec_at(&body, C_BATCH_D, 0, 2);
    // Buffer 4 (the values): offset 192 → 200, length 5824 → 5816 (still ≥ 721 × 8).
    let b4 = at + 16 * 4;
    assert_eq!(
        (common::i64_at(&body, b4), common::i64_at(&body, b4 + 8)),
        (192, 5824)
    );
    let mut b = body.clone();
    common::put_i64(&mut b, b4, 200);
    common::put_i64(&mut b, b4 + 8, 5816);
    let e = run(&b, 1);
    assert_eq!(
        failure(&e, 2),
        Some(PartError::Ipc(IpcError::Layout("align"))),
        "{e:?}"
    );
    assert_eq!(chunks(&e, 2), 0);
    // The unmodified body is accepted.
    assert_eq!(failure(&run(&body, 1), 2), None);
}

#[test]
fn v_body_at_8_mod_64() {
    let body = fixture("promql-range-counter");
    let offs = common::frame_offsets(&body);
    let mut payload = body[offs[C_BATCH_D] + 16..offs[C_BATCH_D + 1]].to_vec();
    let l = common::u32_at(&payload, 4) as usize;
    common::put_u32(&mut payload, 4, (l + 8) as u32);
    payload.splice(8 + l..8 + l, [0u8; 8]);
    let mut fr = common::parse(&body);
    let f = &fr[C_BATCH_D];
    assert_eq!(f.kind, BATCH);
    fr[C_BATCH_D] = F::raw(BATCH, f.flags, f.part, f.rank, payload);
    let e = run(&common::encode(&fr), 1);
    assert_eq!(
        failure(&e, 2),
        Some(PartError::Ipc(IpcError::Layout("body align"))),
        "{e:?}"
    );
    assert_eq!(chunks(&e, 2), 0);
}
