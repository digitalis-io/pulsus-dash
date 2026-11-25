//! unit:dsf-limits (plan #68 B3 §5; T04-010, T04-012): the source, input and aggregate bounds of
//! the reader, the body and value budgets, and every writer-valid `limits-*.dsf` fixture decoded
//! with `wire/schemas/limits-test.json`.
mod common;
mod limits;
mod support;

use std::sync::Arc;

use common::*;
use dash_wire::limits::{BODY_BUDGET, VALUE_BUDGET, cost};
use dash_wire::{
    BodyDecoder, DsfError, Event, FrameHeader, FrameSplitter, HEADER_LEN, Limits, MAX_CHUNK,
    MAX_PAYLOAD, PartError, SOURCE_BUFFER, SharedBytes, Verdict, slabs_from,
};
use limits::*;
use support::*;

fn stream_limit(ev: &[Event]) -> bool {
    ev.iter().any(|e| {
        matches!(
            e,
            Event::Failed {
                reason: PartError::Stream(DsfError::Limit(_)),
                ..
            }
        )
    })
}

fn any_limit(ev: &[Event], part: u32) -> bool {
    matches!(
        failure(ev, part),
        Some(PartError::Limit(_) | PartError::Stream(DsfError::Limit(_)))
    )
}

fn no_failure(ev: &[Event]) -> bool {
    !ev.iter().any(|e| matches!(e, Event::Failed { .. }))
}

fn batch(flags: u16, part: u32, m: Msg) -> F {
    F::new(BATCH, flags, part, 0, vec![Piece::M(m)])
}

fn schema(part: u32, m: Msg) -> F {
    F::new(SCHEMA, 0, part, 0, vec![Piece::M(m)])
}

fn with_part(f: &F, part: u32) -> F {
    let mut g = f.clone();
    g.part = part;
    g
}

/// Drains the splitter into the decoder.
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

/// A comparable, small image of events (chunks by id, series, value count and range).
fn summary(ev: &[Event]) -> Vec<String> {
    ev.iter()
        .map(|e| match e {
            Event::Chunk { part, chunk, .. } => format!(
                "Chunk {part} {:?} {:?} {} {:?}",
                chunk.id,
                chunk.series,
                chunk.values.len(),
                chunk.finite
            ),
            other => format!("{other:?}"),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Source and input bounds, the byte pump

/// A valid body of one labels part and one data part with `batches` one-series batches of
/// 2²⁰ points (8 MiB each).
fn big_body(batches: u32) -> Vec<u8> {
    const LEN: u32 = 1 << 20;
    let e = empty_frames();
    let mut out = Vec::new();
    append(&mut out, &e[0]);
    let rows: Vec<LabelRow<'_>> = (0..batches)
        .map(|i| (i, u64::from(i), Some(&b"i"[..]), Some(&b""[..])))
        .collect();
    append(&mut out, &batch(LAST, 1, labels_msg(&rows, false)));
    append(&mut out, &e[1]);
    append(&mut out, &schema(2, grid_schema(LEN, None)));
    let tmpl = grid_msg(&[(0, vec![(true, 1.5f64.to_bits()); LEN as usize])]);
    for i in 0..batches {
        let mut m = tmpl.clone();
        m.body[..4].copy_from_slice(&i.to_le_bytes());
        append(&mut out, &batch(0, 2, m));
    }
    append(&mut out, &e[4]);
    append(&mut out, &e[5]);
    out
}

/// The browser's BYOB read, modelled: fills the one source buffer (moved in and handed back,
/// as `read(view)` detaches the old buffer and returns the new one).
fn read_into(src: &[u8], pos: usize, mut buf: Vec<u8>) -> (Vec<u8>, usize) {
    let n = (src.len() - pos).min(buf.len());
    buf[..n].copy_from_slice(&src[pos..pos + n]);
    (buf, n)
}

#[test]
fn source_bound_and_byte_pump_of_a_300_mib_body() {
    let body = big_body(38);
    assert!(body.len() > 300 << 20, "{}", body.len());
    let bound = SOURCE_BUFFER + MAX_CHUNK + MAX_PAYLOAD as usize + HEADER_LEN;

    // Source bound: one 1 MiB buffer, rebound after every read, copied into slabs.
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(1);
    let mut buf = vec![0u8; SOURCE_BUFFER];
    let (mut pos, mut peak, mut ev) = (0usize, 0usize, Vec::new());
    while pos < body.len() {
        let (b, n) = read_into(&body, pos, buf);
        buf = b;
        for slab in slabs_from(&buf[..n], pos as u64, MAX_CHUNK) {
            if let Err(e) = s.push(slab) {
                panic!("push: {e:?}");
            }
            peak = peak.max(buf.len() + s.retained_bytes());
            loop {
                match s.next() {
                    Ok(Some(f)) => {
                        peak = peak.max(buf.len() + s.retained_bytes() + f.payload.backing_len());
                        ev.extend(summary(&d.frame(f)));
                    }
                    Ok(None) => break,
                    Err(e) => panic!("next: {e:?}"),
                }
            }
        }
        pos += n;
    }
    assert_eq!(s.finish(), Ok(()));
    ev.extend(summary(&d.finish()));
    assert_eq!(ev.last().map(String::as_str), Some("Verdict(Complete)"));
    assert!(peak <= bound, "peak {peak} > {bound}");
    assert!(peak > 0);

    // Byte pump: body offset 40 first, then the rest from offset 40 in max_chunk slabs.
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(1);
    let mut ev2 = Vec::new();
    let mut raw = Vec::new();
    for slab in slabs_from(&body[..40], 0, MAX_CHUNK) {
        assert_eq!(s.push(slab), Ok(()));
        drain(&mut s, &mut d, &mut raw);
    }
    for (i, slab) in slabs_from(&body[40..], 40, MAX_CHUNK).enumerate() {
        assert!(
            slab.backing_len() <= MAX_CHUNK,
            "slab {i}: {}",
            slab.backing_len()
        );
        if i == 0 {
            assert_eq!(slab.len(), MAX_CHUNK - 40);
            assert_eq!(slab.backing_len(), MAX_CHUNK);
        }
        assert_eq!(s.push(slab), Ok(()));
        drain(&mut s, &mut d, &mut raw);
        ev2.extend(summary(&raw));
        raw.clear();
    }
    assert_eq!(s.finish(), Ok(()));
    ev2.extend(summary(&d.finish()));
    assert_eq!(ev, ev2);
}

#[test]
fn byte_pump_copies_out_of_a_larger_buffer() {
    let c = fixture("promql-range-counter");
    let mut big = vec![0u8; 200 << 20];
    big[4096..4096 + c.len()].copy_from_slice(&c);
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(1);
    let mut ev = Vec::new();
    for slab in slabs_from(&big[4096..4096 + c.len()], 0, MAX_CHUNK) {
        assert!(slab.backing_len() <= MAX_CHUNK);
        assert!(slab.backing_len() < 1 << 20, "the slab copies, never wraps");
        assert_eq!(s.push(slab), Ok(()));
        drain(&mut s, &mut d, &mut ev);
    }
    assert_eq!(s.finish(), Ok(()));
    ev.extend(d.finish());
    // The counter's events are its .expect.json (unit:codec-roundtrip).
    assert!(same(&ev, &run(&c, 1)), "{ev:?}");

    // With 4 KiB slabs the same bytes come out as many slabs, none with a larger backing.
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(1);
    let mut ev = Vec::new();
    let mut n = 0;
    for slab in slabs_from(&big[4096..4096 + c.len()], 0, 4096) {
        assert!(slab.backing_len() <= 4096, "{}", slab.backing_len());
        n += 1;
        assert_eq!(s.push(slab), Ok(()));
        drain(&mut s, &mut d, &mut ev);
    }
    assert_eq!(n, c.len().div_ceil(4096));
    assert_eq!(s.finish(), Ok(()));
    ev.extend(d.finish());
    assert!(same(&ev, &run(&c, 1)));
}

#[test]
fn slabs_keep_body_offsets_and_never_exceed_max() {
    let data: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
    for (offset, max) in [(0u64, 64usize), (40, 64), (63, 128), (5, 256), (1, 100)] {
        let mut pos = 0usize;
        for slab in slabs_from(&data, offset, max) {
            assert!(slab.backing_len() <= max.max(64), "{offset} {max}");
            assert_eq!(
                slab.as_bytes().as_ptr() as usize % 64,
                ((offset + pos as u64) % 64) as usize
            );
            assert_eq!(slab.as_bytes(), &data[pos..pos + slab.len()]);
            pos += slab.len();
        }
        assert_eq!(pos, data.len());
    }
    assert_eq!(slabs_from(&[], 3, 64).count(), 0);
}

#[test]
fn input_bound() {
    let big = SharedBytes::copy_from(&vec![0u8; 200 << 20], 0);
    assert_eq!(big.backing_len(), 200 << 20);
    let small = big.slice(0, 1024).unwrap_or_else(|| panic!("slice"));
    let mut s = FrameSplitter::new();
    assert_eq!(s.push(small), Err(DsfError::Limit("chunk")));
    assert_eq!(s.next(), Err(DsfError::Limit("chunk")), "sticky");
    drop(big);

    // A 128 MiB backing of PING frames is accepted.
    let ping = header(1, PING, 0, 0, 0, 0, 0);
    let pings: Vec<u8> = ping.iter().copied().cycle().take(MAX_CHUNK).collect();
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(1);
    let chunk = SharedBytes::copy_from(&pings, 0);
    assert_eq!(chunk.backing_len(), MAX_CHUNK);
    assert_eq!(s.push(chunk), Ok(()));
    let mut ev = Vec::new();
    drain(&mut s, &mut d, &mut ev);
    assert!(ev.is_empty());

    // 300 pushes of ~100 MiB chunks (96 MiB) of 64 MiB frames that span them: three frames
    // per two chunks, so the chunk contents repeat every two pushes (A, B, A, …).
    const C: usize = 96 << 20;
    let size = 64 << 20;
    let p = size - HEADER_LEN;
    let hdr = header(1, BATCH, 0, 7, p as u32, 0, 0);
    let bound = MAX_CHUNK + HEADER_LEN + MAX_PAYLOAD as usize;
    let pattern = |start: usize| {
        let mut chunk = vec![0u8; C];
        let mut j = start / size;
        while j * size < start + C {
            for (b, byte) in hdr.iter().enumerate() {
                let at = j * size + b;
                if (start..start + C).contains(&at) {
                    chunk[at - start] = *byte;
                }
            }
            j += 1;
        }
        SharedBytes::copy_from(&chunk, 0)
    };
    let ab = [pattern(0), pattern(C)];
    let mut s = FrameSplitter::new();
    let mut frames = 0;
    for k in 0..300 {
        assert_eq!(s.push(ab[k % 2].clone()), Ok(()));
        assert!(
            s.retained_bytes() <= bound,
            "push {k}: {}",
            s.retained_bytes()
        );
        loop {
            match s.next() {
                Ok(Some(f)) => {
                    frames += 1;
                    assert_eq!(f.payload.len(), p);
                    assert!(s.retained_bytes() <= bound, "push {k}");
                    drop(f);
                }
                Ok(None) => break,
                Err(e) => panic!("push {k}: {e:?}"),
            }
        }
        assert!(s.retained_bytes() <= bound, "push {k}");
    }
    assert_eq!(frames, 300 * 3 / 2);
}

#[test]
fn ping_frames_keep_no_state() {
    let frames: Vec<F> = (0..100_000)
        .map(|_| F::raw(PING, 0, 0, 0, Vec::new()))
        .collect();
    // One open labels part first, so retained() has state for the PINGs not to change.
    let mut d = BodyDecoder::new(1);
    let schema = empty_frames()[0].clone();
    assert!(feed(&mut d, frames_of(&encode(&[schema])), |_, _, _| {}).is_empty());
    let before = d.retained();
    assert_eq!((before.0, before.1), (1, 1));
    assert!(before.2 > cost::PART);
    let ev = feed(&mut d, frames_of(&encode(&frames)), |_, _, _| {});
    assert!(ev.is_empty());
    assert_eq!(d.retained(), before);

    // One 64 MiB chunk of PINGs pulled one frame at a time.
    let ping = header(1, PING, 0, 0, 0, 0, 0);
    let pings: Vec<u8> = ping.iter().copied().cycle().take(64 << 20).collect();
    let chunk = SharedBytes::copy_from(&pings, 0);
    let mut s = FrameSplitter::new();
    assert_eq!(s.push(chunk.clone()), Ok(()));
    let mut n = 0;
    while let Ok(Some(f)) = s.next() {
        assert!(chunk.strong_count() <= 3, "more than one frame held");
        assert!(d.frame(f).is_empty());
        n += 1;
    }
    assert_eq!(n, (64 << 20) / 16);
    assert_eq!(chunk.strong_count(), 1);
    assert_eq!(d.retained(), before);
}

// ---------------------------------------------------------------------------------------------
// Aggregate limits on built bodies

#[test]
fn meta_and_error_limits_fail_the_part() {
    let mut fr = empty_frames();
    let empties: Vec<&[u8]> = vec![b""; 5000];
    fr[1] = stream_frame(
        &fr[1],
        0,
        2,
        coverage_batch(0, None, [&[], &empties, &[], &[]]),
    );
    let (ev, d) = decode_with(&encode(&fr), Limits::default());
    assert!(
        matches!(failure(&ev, 2), Some(PartError::Limit(_))),
        "{ev:?}"
    );
    assert!(d.retained().2 <= BODY_BUDGET);

    let er = parse(&fixture("grid-error"));
    let like = &er[find_frame(&er, ERROR, 5, 0)];
    let mut fr = empty_frames();
    let msg = vec![b'm'; 2 << 20];
    fr.insert(5, stream_frame(like, LAST, 3, error_batch(&msg, None)));
    let (ev, _) = decode_with(&encode(&fr), Limits::default());
    assert!(
        matches!(failure(&ev, 3), Some(PartError::Limit(_))),
        "{ev:?}"
    );
    assert!(silent(&ev, 3));
    // The other parts are unaffected.
    assert_eq!(coverages(&ev, 2), 1);
}

#[test]
fn a_labels_part_above_label_rows_per_part() {
    let n = 1usize << 20;
    let mut fr = vec![empty_frames()[0].clone()];
    for b in 0..5u32 {
        let rows: Vec<LabelRow<'_>> = (0..if b < 4 { n } else { 1 })
            .map(|i| (b * n as u32 + i as u32, 0, Some(&b""[..]), Some(&b""[..])))
            .collect();
        fr.push(batch(
            if b == 4 { LAST } else { 0 },
            1,
            labels_msg(&rows, false),
        ));
    }
    fr.push(F::raw(END, 0, 0, 0, Vec::new()));
    let body = encode(&fr);
    // Default limits: the body budget is reached first (64 + 48 B per row).
    let (ev, d) = decode_with(&body, Limits::default());
    assert!(any_limit(&ev, 1), "{:?}", failure(&ev, 1));
    assert!(d.retained().2 <= BODY_BUDGET);
    // With the budget lifted, row 4 194 305 is past label_rows_per_part.
    let lifted = Limits {
        body_budget: u64::MAX,
        ..Limits::default()
    };
    let (ev, _) = decode_with(&body, lifted);
    assert!(
        matches!(failure(&ev, 1), Some(PartError::Limit(_))),
        "{:?}",
        failure(&ev, 1)
    );
}

#[test]
fn open_and_distinct_parts() {
    let e = empty_frames();
    // 65 labels parts opened: the 65th fails the stream.
    let fr: Vec<F> = (1..=65).map(|p| with_part(&e[0], p)).collect();
    let mut d = BodyDecoder::new(1);
    let mut last = Vec::new();
    feed(&mut d, frames_of(&encode(&fr)), |d, i, ev| {
        if i == 63 {
            assert_eq!(d.retained().0, 64);
        }
        last = ev.to_vec();
    });
    assert_eq!(last.len(), 64, "{last:?}");
    assert!(last.iter().all(|e| matches!(
        e,
        Event::Failed {
            reason: PartError::Stream(DsfError::Limit(_)),
            ..
        }
    )));

    // 1 025 parts opened and closed in turn (one ERROR each).
    let er = parse(&fixture("grid-error"));
    let like = er[find_frame(&er, ERROR, 5, 0)].clone();
    let fr: Vec<F> = (1..=1025).map(|p| with_part(&like, p)).collect();
    let mut d = BodyDecoder::new(1);
    let ev = feed(&mut d, frames_of(&encode(&fr)), |d, i, _| {
        if i == 1023 {
            assert_eq!(d.retained().1, 1024);
        }
    });
    assert_eq!(upstream_count(&ev), 1024);
    assert_eq!(
        d.finish().last(),
        Some(&Event::Verdict(Verdict::Incomplete("stream failed")))
    );

    // 64 open data parts, then END: exactly 64 Failed(Order), then End.
    let mut fr: Vec<F> = (1..=64).map(|p| with_part(&e[1], p)).collect();
    fr.push(e[5].clone());
    let mut d = BodyDecoder::new(1);
    let mut at_end = Vec::new();
    feed(&mut d, frames_of(&encode(&fr)), |_, i, ev| {
        if i == 64 {
            at_end = ev.to_vec();
        }
    });
    assert_eq!(at_end.len(), 65, "{at_end:?}");
    assert!(at_end[..64].iter().all(|e| matches!(
        e,
        Event::Failed {
            reason: PartError::Order(_),
            ..
        }
    )));
    assert_eq!(at_end[64], Event::End);
}

fn upstream_count(ev: &[Event]) -> usize {
    ev.iter()
        .filter(|e| matches!(e, Event::Upstream { .. }))
        .count()
}

#[test]
fn repeated_empty_label_parts_reach_the_budget() {
    let rows: Vec<LabelRow<'_>> = (0..65_536u32).map(|i| (i, 0, None, None)).collect();
    let tmpl = encode(&[
        empty_frames()[0].clone(),
        batch(LAST, 1, labels_msg(&rows, false)),
    ]);
    let span = round_up(tmpl.len(), 64) as u64;
    let fs = frames_of(&tmpl);
    let mut d = BodyDecoder::new(1);
    let mut failed_at = None;
    for p in 1..=1000u32 {
        let mut ev = Vec::new();
        for f in &fs {
            ev.extend(d.frame(retarget(f, p, u64::from(p - 1) * span)));
        }
        assert!(d.retained().2 <= BODY_BUDGET);
        if stream_limit(&ev) {
            failed_at = Some(p);
            break;
        }
    }
    let p = failed_at.unwrap_or_else(|| panic!("no Limit after 1 000 parts"));
    assert!(p <= 16, "failed at part {p}");
}

#[test]
fn small_frames_in_a_large_slab() {
    let e = empty_frames();
    let vals: Vec<String> = (0..1000).map(|i| i.to_string()).collect();
    let rows: Vec<LabelRow<'_>> = (0..1000u32)
        .map(|i| {
            (
                i,
                u64::from(i),
                Some(&b"i"[..]),
                Some(vals[i as usize].as_bytes()),
            )
        })
        .collect();
    let mut body = Vec::new();
    append(&mut body, &e[0]);
    append(&mut body, &batch(LAST, 1, labels_msg(&rows, false)));
    append(&mut body, &e[1]);
    append(&mut body, &schema(2, grid_schema(4, None)));
    for i in 0..1000u32 {
        let slots = vec![
            (true, 1f64.to_bits()),
            (false, NULL_BITS),
            (true, 2f64.to_bits()),
            (true, 0),
        ];
        append(&mut body, &batch(0, 2, grid_msg(&[(i, slots)])));
    }
    append(&mut body, &e[4]);
    let ping = F::raw(PING, 0, 0, 0, Vec::new());
    while body.len() + 32 <= 64 << 20 {
        append(&mut body, &ping);
    }
    append(&mut body, &e[5]);
    let slab = SharedBytes::copy_from(&body, 0);
    assert_eq!(slab.backing_len(), 64 << 20);
    let mut s = FrameSplitter::new();
    let mut d = BodyDecoder::new(1);
    let mut ev = Vec::new();
    assert_eq!(s.push(slab.clone()), Ok(()));
    drain(&mut s, &mut d, &mut ev);
    ev.extend(d.finish());
    drop(s);
    assert_eq!(slab.strong_count(), 1, "the slab is pinned");
    assert_eq!(ev.last(), Some(&Event::Verdict(Verdict::Complete)));
    let mut kept = 0usize;
    let mut n = 0;
    for e in &ev {
        if let Event::Chunk { chunk, .. } = e {
            n += 1;
            kept += 8 * chunk.values.len() + 8 * chunk.present.as_ref().map_or(0, Vec::len);
        }
    }
    assert_eq!(n, 1000);
    assert_eq!(kept, 1000 * (32 + 8));
}

#[test]
fn repeated_large_frames_reach_the_value_budget() {
    const LEN: u32 = 1 << 22;
    let e = empty_frames();
    let rows: Vec<LabelRow<'_>> = (0..32u32)
        .map(|i| (i, u64::from(i), Some(&b"i"[..]), Some(&b""[..])))
        .collect();
    let mut setup = Vec::new();
    append(&mut setup, &e[0]);
    append(&mut setup, &batch(LAST, 1, labels_msg(&rows, false)));
    append(&mut setup, &e[1]);
    append(&mut setup, &schema(2, grid_schema(LEN, None)));
    let mut d = BodyDecoder::new(1);
    let ev = feed(&mut d, frames_of(&setup), |_, _, _| {});
    assert!(no_failure(&ev), "{ev:?}");

    // One BATCH(D) frame encoded at the body offset after the setup frames.
    let lead = setup.len() % 64;
    let mut tmp = vec![0u8; lead];
    let slots = vec![(true, 3f64.to_bits()); LEN as usize];
    append(&mut tmp, &batch(0, 2, grid_msg(&[(0, slots)])));
    let frame = &tmp[lead..];
    let h = FrameHeader::parse(frame).unwrap_or_else(|e| panic!("{e:?}"));
    let payload = &frame[HEADER_LEN..];
    let l = i32_at(payload, 4) as usize;
    let at = (setup.len() + HEADER_LEN) as u64;
    let per = cost::VALUE * u64::from(LEN) + cost::VALIDITY_WORD * u64::from(LEN).div_ceil(64);
    assert_eq!(per, (32 << 20) + (512 << 10));
    assert!(31 * per <= VALUE_BUDGET && 32 * per > VALUE_BUDGET);
    for i in 0..32u32 {
        let mut p = payload.to_vec();
        p[8 + l..12 + l].copy_from_slice(&i.to_le_bytes());
        let input = SharedBytes::copy_from(&p, (at % 64) as usize);
        drop(p);
        let ev = d.frame(dash_wire::Frame {
            header: h,
            payload: input.clone(),
            payload_offset: at,
        });
        if i < 31 {
            assert!(no_failure(&ev), "batch {i}: {ev:?}");
            assert_eq!(chunks(&ev, 2), 1, "batch {i}");
        } else {
            assert!(stream_limit(&ev), "batch {i}: {ev:?}");
        }
        drop(ev);
        assert_eq!(input.strong_count(), 1, "batch {i} pinned");
    }
}

#[test]
fn shared_labels_cost_once() {
    let e = empty_frames();
    let big: Vec<Vec<u8>> = (0..15).map(|_| vec![b'v'; 1 << 20]).collect();
    let keys: Vec<[u8; 1]> = (0..15u8).map(|k| [b'a' + k]).collect();
    let vals: Vec<String> = (0..64).map(|i| i.to_string()).collect();
    let mut rows: Vec<LabelRow<'_>> = (0..15)
        .map(|k| (0u32, 0u64, Some(&keys[k][..]), Some(&big[k][..])))
        .collect();
    rows.extend((1..64u32).map(|i| {
        (
            i,
            u64::from(i),
            Some(&b"i"[..]),
            Some(vals[i as usize].as_bytes()),
        )
    }));
    let mut body = Vec::new();
    append(&mut body, &e[0]);
    append(&mut body, &batch(LAST, 1, labels_msg(&rows, false)));
    let prefix = body.len();
    let grid: Vec<(u32, Vec<(bool, u64)>)> = (0..64u32)
        .map(|i| (i, vec![(true, f64::from(i).to_bits()); 5]))
        .collect();
    for f in [
        e[1].clone(),
        schema(2, grid_schema(5, None)),
        batch(0, 2, grid_msg(&grid)),
        e[4].clone(),
    ] {
        append(&mut body, &f);
    }
    let span = round_up(body.len() - prefix, 64) as u64;
    let fs = frames_of(&body);
    let mut d = BodyDecoder::new(1);
    let ev = feed(&mut d, fs[..2].to_vec(), |_, _, _| {});
    assert!(no_failure(&ev));
    let mut first: Option<Arc<[(String, String)]>> = None;
    for p in 2..=1001u32 {
        for (k, f) in fs[2..].iter().enumerate() {
            let before = d.retained().2;
            let ev = d.frame(retarget(f, p, u64::from(p - 2) * span));
            assert!(no_failure(&ev), "part {p}: {ev:?}");
            if k == 2 {
                assert_eq!(d.retained().2 - before, 64 + 32 * 64, "part {p}");
                let Some(Event::Chunk { chunk, .. }) = ev.first() else {
                    panic!("part {p}: no chunk")
                };
                let l = &chunk.series[0].labels;
                match &first {
                    None => first = Some(Arc::clone(l)),
                    Some(f) => assert!(Arc::ptr_eq(f, l), "part {p}: labels copied"),
                }
            }
        }
    }
    assert!(d.retained().2 <= BODY_BUDGET);
}

#[test]
fn repeated_schema_metadata_is_charged_per_part() {
    let e = empty_frames();
    let planned = "p".repeat(900 << 10);
    let data_schema = grid_schema(5, Some(&planned));
    let mut body = Vec::new();
    append(&mut body, &e[0]);
    append(
        &mut body,
        &batch(
            LAST,
            1,
            labels_msg(&[(0, 0, Some(&b"i"[..]), Some(&b"0"[..]))], false),
        ),
    );
    let prefix = body.len();
    for f in [e[1].clone(), schema(2, data_schema.clone()), e[4].clone()] {
        append(&mut body, &f);
    }
    let span = round_up(body.len() - prefix, 64) as u64;
    let fs = frames_of(&body);
    let mut d = BodyDecoder::new(1);
    feed(&mut d, fs[..2].to_vec(), |_, _, _| {});
    let base = d.retained().2;
    // A data part: its part, its schema and two coverages with no strings.
    let per = cost::PART + schema_cost(&data_schema) + 2 * cost::COVERAGE;
    let k = (BODY_BUDGET - base) / per;
    assert!(k > 60 && k < 80, "{k}");
    for j in 1..=k + 1 {
        let p = j as u32 + 1;
        let mut ev = Vec::new();
        for f in &fs[2..] {
            ev.extend(d.frame(retarget(f, p, (j - 1) * span)));
        }
        assert!(d.retained().2 <= BODY_BUDGET);
        if j <= k {
            assert!(
                ev.contains(&Event::PartEnd { part: p }) && no_failure(&ev),
                "part {j} of {k}: {ev:?}"
            );
        } else {
            assert!(stream_limit(&ev), "part {j}: {ev:?}");
            assert!(!ev.contains(&Event::PartEnd { part: p }));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The writer-valid fixtures

/// The last value of `k` in an expectation object, as a JSON value.
fn field<'a>(v: &'a serde_json::Value, k: &str) -> &'a serde_json::Value {
    v.get(k).unwrap_or_else(|| panic!("no {k} in {v}"))
}

fn coverage_view(c: &dash_wire::Coverage) -> serde_json::Value {
    serde_json::json!({
        "phase": c.phase as u8, "truncated": c.truncated, "truncation_reason": c.truncation_reason,
        "series_returned": c.series_returned, "excluded_dims": c.excluded_dims, "warnings": c.warnings,
        "infos": c.infos, "upstream_query_ids": c.upstream_query_ids,
    })
}

fn expect_view(c: &serde_json::Value) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for k in [
        "phase",
        "truncated",
        "truncation_reason",
        "series_returned",
        "excluded_dims",
        "warnings",
        "infos",
        "upstream_query_ids",
    ] {
        out.insert(k.into(), field(c, k).clone());
    }
    serde_json::Value::Object(out)
}

#[test]
fn writer_valid_fixtures_decode_with_the_test_limits() {
    let lim = test_limits();
    let v = limits_json("limits-test.json");
    let reserves = num(&v, "part_reserve") + num(&v, "stream_reserve");
    let names = limit_fixtures();
    assert!(names.len() >= 10, "{names:?}");
    assert!(names.iter().any(|n| n == "budget-over"));
    for name in &names {
        let body = fixture(name);
        let (ev, d) = decode_with(&body, lim);
        if name == "budget-over" {
            assert!(
                stream_limit(&ev),
                "budget-over must fail with Limit: {:?}",
                ev.iter().rev().take(3).collect::<Vec<_>>()
            );
            continue;
        }
        assert!(
            no_failure(&ev),
            "{name}: {:?}",
            ev.iter().find(|e| matches!(e, Event::Failed { .. }))
        );
        let exp = expect(name);
        let refused = field(&exp, "errors")
            .as_array()
            .is_some_and(|e| e.iter().any(|e| field(e, "part") == 0));
        assert_eq!(d.stream_error().is_some(), refused, "{name}");
        let want = if refused {
            Verdict::Incomplete("stream error")
        } else {
            Verdict::Complete
        };
        assert_eq!(ev.last(), Some(&Event::Verdict(want)), "{name}");
        for p in field(&exp, "parts")
            .as_array()
            .unwrap_or_else(|| panic!("{name}: parts"))
        {
            let part = field(p, "data_part").as_u64().unwrap_or_default() as u32;
            let got: Vec<serde_json::Value> = ev
                .iter()
                .filter_map(|e| match e {
                    Event::Coverage { part: q, coverage } if *q == part => {
                        Some(coverage_view(coverage))
                    }
                    _ => None,
                })
                .collect();
            let cov = field(p, "coverage")
                .as_array()
                .unwrap_or_else(|| panic!("coverage"));
            // The reader emits no event for the planned coverage.
            let want: Vec<serde_json::Value> = cov[1..].iter().map(expect_view).collect();
            assert_eq!(got, want, "{name} part {part}");
            let last = &cov[cov.len() - 1];
            if field(last, "truncated") == true {
                let r = field(last, "truncation_reason")
                    .as_str()
                    .unwrap_or_default();
                assert!(
                    ["wire_limit", "wire_budget", "coverage_cut"].contains(&r),
                    "{name} part {part}: {r}"
                );
            }
            let series: usize = ev
                .iter()
                .filter_map(|e| match e {
                    Event::Chunk { part: q, chunk, .. } if *q == part => Some(chunk.series.len()),
                    _ => None,
                })
                .sum();
            assert_eq!(
                series,
                field(p, "series").as_array().map_or(0, Vec::len),
                "{name} part {part}"
            );
        }
        match name.as_str() {
            "limits-fail" => {
                let tail: Vec<&Event> = ev
                    .iter()
                    .filter(|e| {
                        matches!(
                            e,
                            Event::Coverage { .. }
                                | Event::Upstream { .. }
                                | Event::PartEnd { part: 2 }
                        )
                    })
                    .collect();
                assert!(
                    matches!(tail[..], [.., Event::Coverage { coverage, .. }, Event::Upstream { part: 2, .. }, Event::PartEnd { part: 2 }] if coverage.phase == dash_wire::Phase::Partial),
                    "{tail:?}"
                );
                assert_eq!(d.retained().2, lim.body_budget - num(&v, "stream_reserve"));
            }
            "limits-strings" => {
                let finals: Vec<&dash_wire::Coverage> = ev
                    .iter()
                    .filter_map(|e| match e {
                        Event::Coverage { part: 2, coverage } => Some(coverage),
                        _ => None,
                    })
                    .collect();
                assert!(
                    finals.len() == 1 && !finals[0].complete(0),
                    "the cut planned META keeps part 2 incomplete"
                );
            }
            "limits-budget" => {
                // When the fourth Grid is accepted, its reserves still fit.
                let mut d = BodyDecoder::with_limits(1, lim);
                feed(&mut d, frames_of(&body), |d, _, ev| {
                    if ev.iter().any(|e| matches!(e, Event::Grid { part: 8, .. })) {
                        assert!(
                            d.retained().2 + reserves <= lim.body_budget,
                            "{:?}",
                            d.retained()
                        );
                    }
                });
            }
            _ => {}
        }
    }
}
